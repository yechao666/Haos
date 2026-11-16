import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/db.mjs';
import {
  bootstrapInstanceOrg,
  buildOrgView,
  claimRelayTask,
  createRelayTask,
  ensureOrg,
  finishRelayTask,
  orgOfInstance,
  pendingRelayTasks,
  setOrgTree,
} from '../src/org.mjs';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

function addInstance(db, { id, name = id, team = 'tm1', status = 'online', capabilities = [] }) {
  db.prepare(
    `INSERT INTO instances (id, name, owner_id, scope, team_id, status, capabilities_json, capability_summary, created_at)
     VALUES (?, ?, 'usr1', 'team', ?, ?, ?, ?, ?)`,
  ).run(id, name, team, status, JSON.stringify(capabilities), capabilities.join(','), new Date().toISOString());
  return db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
}

function fresh(db, instance) {
  return bootstrapInstanceOrg(db, instance);
}

test('第一个注册实例成为组织根，其余等待挂载', () => {
  const db = makeDb();
  const a = fresh(db, addInstance(db, { id: 'inst_a', name: 'team-lead' }));
  assert.equal(a.org_role, 'leader');
  assert.equal(a.org_depth, 0);
  assert.equal(a.org_parent_id, null);
  const org = orgOfInstance(db, a);
  assert.ok(org?.id);
  assert.equal(org.root_instance_id, 'inst_a');

  const b = fresh(db, addInstance(db, { id: 'inst_b', name: 'analyst' }));
  assert.equal(b.org_id, a.org_id);
  assert.equal(b.org_parent_id, null);
  assert.equal(b.org_role, 'member');
});

test('集中配置组织树：分配父子关系并计算深度', () => {
  const db = makeDb();
  const root = fresh(db, addInstance(db, { id: 'r', name: 'root' }));
  const child = fresh(db, addInstance(db, { id: 'c', name: 'child' }));
  fresh(db, addInstance(db, { id: 'g', name: 'grandchild' }));

  let view = setOrgTree(db, root.org_id, [
    { instanceId: 'c', parentId: 'r' },
    { instanceId: 'g', parentId: 'c' },
  ]);
  const byId = Object.fromEntries(view.members.map((m) => [m.instanceId, m]));
  assert.equal(byId.r.depth, 0);
  assert.equal(byId.r.role, 'leader');
  assert.equal(byId.c.depth, 1);
  assert.equal(byId.c.parentInstanceId, 'r');
  assert.equal(byId.g.depth, 2);
  assert.equal(view.org.rootInstanceId, 'r');

  // 取消挂载后，子节点变成新的独立节点；两个根会被拒绝
  assert.throws(
    () => setOrgTree(db, root.org_id, [{ instanceId: 'c', parentId: null }, { instanceId: 'g', parentId: null }]),
    (error) => error.code === 'org_multi_root',
  );
  view = buildOrgView(db, root.org_id);
  assert.equal(view.members.length, 3);
});

test('组织树拒绝环与超深', () => {
  const db = makeDb();
  const root = fresh(db, addInstance(db, { id: 'r' }));
  fresh(db, addInstance(db, { id: 'c' }));
  // c -> r 会成为环（r 目前没有父级，但把 r 挂到 c 下就成环）
  assert.throws(
    () => setOrgTree(db, root.org_id, [{ instanceId: 'r', parentId: 'c' }, { instanceId: 'c', parentId: 'r' }]),
    (error) => error.code === 'org_cycle',
  );
  // 把 max_depth 收紧到 1 后，挂到第 2 层会失败
  db.prepare('UPDATE orgs SET max_depth = 1 WHERE id = ?').run(root.org_id);
  fresh(db, addInstance(db, { id: 'g' }));
  assert.throws(
    () => setOrgTree(db, root.org_id, [{ instanceId: 'c', parentId: 'r' }, { instanceId: 'g', parentId: 'c' }]),
    (error) => error.code === 'org_too_deep',
  );
});

test('经 Haos 转发任务：排队 → 领取 → 完成', () => {
  const db = makeDb();
  const root = fresh(db, addInstance(db, { id: 'r', name: 'root', capabilities: ['role.coordinator'] }));
  const child = fresh(db, addInstance(db, { id: 'c', name: 'child', capabilities: ['role.qa'] }));
  setOrgTree(db, root.org_id, [{ instanceId: 'c', parentId: 'r' }]);

  const task = createRelayTask(db, root, { targetInstanceId: 'c', prompt: '跑测试', title: 'QA', cwd: '/work' });
  assert.equal(task.status, 'queued');
  assert.deepEqual(task.chain, ['r']);
  assert.equal(task.depth, 1);

  const pending = pendingRelayTasks(db, 'c');
  assert.equal(pending.length, 1);
  const claimed = claimRelayTask(db, task.taskId, 'c');
  assert.equal(claimed.status, 'running');
  assert.equal(pendingRelayTasks(db, 'c').length, 0);

  const done = finishRelayTask(db, task.taskId, 'c', { status: 'succeeded', summary: 'ok' });
  assert.equal(done.status, 'succeeded');
  assert.equal(done.summary, 'ok');
  assert.ok(done.finishedAt);
});

test('中心化规则：只能派给直接下级', () => {
  const db = makeDb();
  const root = fresh(db, addInstance(db, { id: 'r' }));
  fresh(db, addInstance(db, { id: 'c' }));
  fresh(db, addInstance(db, { id: 'g' }));
  setOrgTree(db, root.org_id, [
    { instanceId: 'c', parentId: 'r' },
    { instanceId: 'g', parentId: 'c' },
  ]);
  assert.throws(
    () => createRelayTask(db, root, { targetInstanceId: 'g', prompt: 'x' }),
    (error) => error.code === 'not_direct_child',
  );
  assert.throws(
    () => createRelayTask(db, root, { targetInstanceId: 'r', prompt: 'x' }),
    (error) => error.code === 'self_delegate',
  );
});

test('中心化规则：防环与深度上限', () => {
  const db = makeDb();
  const root = fresh(db, addInstance(db, { id: 'r' }));
  fresh(db, addInstance(db, { id: 'c' }));
  setOrgTree(db, root.org_id, [{ instanceId: 'c', parentId: 'r' }]);

  assert.throws(
    () => createRelayTask(db, root, { targetInstanceId: 'c', prompt: 'x', chain: ['r'] }),
    (error) => error.code === 'delegation_loop',
  );
  // 链长度 1 + 新的一跳 = 2 > maxDepth(1)
  db.prepare('UPDATE orgs SET max_depth = 1 WHERE id = ?').run(root.org_id);
  assert.throws(
    () => createRelayTask(db, root, { targetInstanceId: 'c', prompt: 'x', chain: ['other'] }),
    (error) => error.code === 'depth_exceeded',
  );
});

test('中心化规则：跨组织拒绝', () => {
  const db = makeDb();
  const root = fresh(db, addInstance(db, { id: 'r' }));
  addInstance(db, { id: 'o' });
  db.prepare("UPDATE instances SET owner_id = 'usr2' WHERE id = 'o'").run();
  const other = fresh(db, db.prepare("SELECT * FROM instances WHERE id = 'o'").get());
  assert.notEqual(other.org_id, root.org_id);
  assert.throws(
    () => createRelayTask(db, root, { targetInstanceId: 'o', prompt: 'x' }),
    (error) => error.code === 'org_mismatch',
  );
});

test('组织视图包含成员能力与深度', () => {
  const db = makeDb();
  const root = fresh(db, addInstance(db, { id: 'r', capabilities: ['role.coordinator', 'os.darwin'] }));
  fresh(db, addInstance(db, { id: 'c', capabilities: ['role.qa'] }));
  setOrgTree(db, root.org_id, [{ instanceId: 'c', parentId: 'r' }]);
  const view = buildOrgView(db, root.org_id);
  assert.equal(view.org.maxDepth, 3);
  const child = view.members.find((m) => m.instanceId === 'c');
  assert.equal(child.depth, 1);
  assert.deepEqual(child.capabilities, ['role.qa']);
  assert.equal(view.members.find((m) => m.instanceId === 'r').role, 'leader');
});

test('未加入组织的实例不能派任务', () => {
  const db = makeDb();
  addInstance(db, { id: 'loose', team: 'tm9' });
  // 直接绕过 bootstrap：手工清掉 org 字段
  db.prepare('UPDATE instances SET org_id = NULL WHERE id = ?').run('loose');
  const row = db.prepare('SELECT * FROM instances WHERE id = ?').get('loose');
  assert.throws(
    () => createRelayTask(db, row, { targetInstanceId: 'x', prompt: 'x' }),
    (error) => error.code === 'org_missing',
  );
  assert.equal(ensureOrg(db, 'tm9').team_id, 'tm9');
});
