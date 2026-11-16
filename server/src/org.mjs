/**
 * Haos 中心化组织模型（co-dsh 的中心化版本）。
 *
 * 目标：把 dsh-co-dsh 的 P2P 组织拓扑搬到 Haos：
 *   - 组织树由 Haos 集中配置（root → 下级 → 下下级）；
 *   - 任务不再由 DSH 之间直连，而是 POST 到 Haos，由 Haos 转发给目标实例；
 *   - 深度、直接下级、防环这些规则全部在中心校验，插件只能照办。
 *
 * 数据落在两类表里：
 *   orgs            组织（每个 team 一个默认组织，含 root 与 max_depth）
 *   instances       通过 org_id / org_parent_id / org_role / org_depth 挂到树上
 *   relay_tasks     经 Haos 转发的任务（queued → running → succeeded/failed）
 */
import { now } from './db.mjs';
import { id } from './lib/ids.mjs';

function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function parseCapabilities(row) {
  try {
    const list = row.capabilities_json ? JSON.parse(row.capabilities_json) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function ensureOrg(db, scope, name = '默认组织') {
  const teamId = typeof scope === 'string' ? scope : scope?.teamId ?? null;
  const ownerId = typeof scope === 'object' ? scope?.ownerId ?? null : null;
  const existing = teamId
    ? db.prepare('SELECT * FROM orgs WHERE team_id = ? ORDER BY created_at LIMIT 1').get(teamId)
    : db.prepare('SELECT * FROM orgs WHERE owner_id = ? AND team_id IS NULL ORDER BY created_at LIMIT 1').get(ownerId);
  if (existing) return existing;
  const orgId = id('org');
  db.prepare(
    'INSERT INTO orgs (id, team_id, owner_id, name, root_instance_id, max_depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(orgId, teamId, ownerId, name, null, 3, now());
  return db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId);
}

/** 浏览器会话对应的组织：有团队用团队组织，否则用个人组织。 */
export function ensureOrgForUser(db, user) {
  // 团队已退役：组织直接归属用户，不再从团队成员关系推导。
  return ensureOrg(db, { ownerId: user.id });
}

/** 实例注册后自动入组织：所在 team 的第一个实例成为 root，其余待管理员挂载。 */
export function bootstrapInstanceOrg(db, instance) {
  if (!instance || (!instance.team_id && !instance.owner_id)) return null;
  // 团队已退役：实例统一归入 owner 的个人组织。
  const org = ensureOrg(db, { ownerId: instance.owner_id });
  if (!instance.org_id) {
    const hasRoot = Boolean(org.root_instance_id);
    db.prepare('UPDATE instances SET org_id = ?, org_role = ?, org_depth = ?, org_parent_id = NULL WHERE id = ?').run(
      org.id,
      hasRoot ? 'member' : 'leader',
      hasRoot ? 0 : 0,
      instance.id,
    );
    if (!hasRoot) {
      db.prepare('UPDATE orgs SET root_instance_id = ? WHERE id = ?').run(instance.id, org.id);
    }
    return db.prepare('SELECT * FROM instances WHERE id = ?').get(instance.id);
  }
  return instance;
}

export function orgOfInstance(db, instance) {
  if (!instance?.org_id) return null;
  return db.prepare('SELECT * FROM orgs WHERE id = ?').get(instance.org_id) ?? null;
}

function orgRows(db, orgId) {
  return db
    .prepare('SELECT * FROM instances WHERE org_id = ? AND revoked_at IS NULL ORDER BY created_at')
    .all(orgId);
}

/** 计算每行深度并校验树：单一 root、无环、不超深。 */
function computeTree(rows, parentOf, maxDepth) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const depth = new Map();
  const resolveDepth = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) throw fail(400, 'org_cycle', '组织树出现环：父级链回到了自己');
    seen.add(id);
    const parent = parentOf.get(id) ?? null;
    if (!parent) {
      depth.set(id, 0);
      return 0;
    }
    if (!byId.has(parent)) throw fail(400, 'org_parent_missing', `父级实例不存在：${parent}`);
    const value = resolveDepth(parent, seen) + 1;
    depth.set(id, value);
    return value;
  };
  for (const row of rows) resolveDepth(row.id);
  const roots = rows.filter((row) => !(parentOf.get(row.id) ?? null));
  if (roots.length > 1) throw fail(400, 'org_multi_root', `组织只能有一个根，当前有 ${roots.length} 个：${roots.map((row) => row.name).join(', ')}`);
  const deepest = Math.max(0, ...[...depth.values()]);
  if (deepest > maxDepth) throw fail(400, 'org_too_deep', `树深 ${deepest} 超过组织上限 ${maxDepth}`);
  return { depth, roots };
}

/**
 * 集中配置组织树。assignments: [{ instanceId, parentId }]；
 * 未列出的实例保持原父级不变。
 */
export function setOrgTree(db, orgId, assignments) {
  const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId);
  if (!org) throw fail(404, 'org_not_found', '组织不存在');
  const rows = orgRows(db, orgId);
  const parentOf = new Map(rows.map((row) => [row.id, row.org_parent_id ?? null]));
  for (const item of Array.isArray(assignments) ? assignments : []) {
    const instanceId = String(item?.instanceId ?? '');
    if (!parentOf.has(instanceId)) throw fail(404, 'instance_not_in_org', `实例不在本组织：${instanceId}`);
    const parentId = item?.parentId ? String(item.parentId) : null;
    if (parentId && !parentOf.has(parentId)) throw fail(400, 'org_parent_missing', `父级实例不在本组织：${parentId}`);
    if (parentId === instanceId) throw fail(400, 'org_cycle', '实例不能把自己设为父级');
    parentOf.set(instanceId, parentId);
  }
  const { depth, roots } = computeTree(rows, parentOf, Number(org.max_depth ?? 3));
  const update = db.prepare('UPDATE instances SET org_parent_id = ?, org_depth = ?, org_role = ? WHERE id = ?');
  for (const row of rows) {
    const parentId = parentOf.get(row.id) ?? null;
    update.run(parentId, depth.get(row.id) ?? 0, parentId ? 'member' : 'leader', row.id);
  }
  db.prepare('UPDATE orgs SET root_instance_id = ? WHERE id = ?').run(roots[0]?.id ?? null, orgId);
  return buildOrgView(db, orgId);
}

export function buildOrgView(db, orgId) {
  const org = db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId);
  if (!org) return null;
  const rows = orgRows(db, orgId);
  return {
    org: {
      id: org.id,
      name: org.name,
      teamId: org.team_id,
      rootInstanceId: org.root_instance_id,
      maxDepth: Number(org.max_depth ?? 3),
    },
    members: rows.map((row) => ({
      instanceId: row.id,
      name: row.name_override || row.client_name || row.name,
      status: row.status,
      role: row.org_role ?? (row.org_parent_id ? 'member' : 'leader'),
      parentInstanceId: row.org_parent_id ?? null,
      depth: Number(row.org_depth ?? 0),
      lastSeenAt: row.last_seen_at ?? null,
      capabilities: parseCapabilities(row),
      capabilitySummary: row.capability_summary ?? '',
    })),
  };
}

// ── 任务转发 ─────────────────────────────────────────────────────

function requireInstanceRow(db, instanceId) {
  const row = db.prepare('SELECT * FROM instances WHERE id = ? AND revoked_at IS NULL').get(String(instanceId));
  if (!row) throw fail(404, 'instance_not_found', `实例不存在：${instanceId}`);
  return row;
}

/**
 * 源实例请求 Haos 把任务转发给目标实例。
 * 规则全部在中心校验：
 *   - 同一组织；
 *   - 只能派给**直接下级**（目标 parent === 调用方）；
 *   - 链里已经出现过的实例不能再派（防环）；
 *   - 深度不超过组织上限。
 */
export function createRelayTask(db, caller, input) {
  const org = orgOfInstance(db, caller);
  if (!org) throw fail(403, 'org_missing', '调用方还没有加入组织');
  const target = requireInstanceRow(db, input?.targetInstanceId);
  if (target.org_id !== org.id) throw fail(403, 'org_mismatch', '目标实例不在同一组织');
  if (target.id === caller.id) throw fail(400, 'self_delegate', '不能把任务派给自己');
  if ((target.org_parent_id ?? null) !== caller.id) {
    throw fail(403, 'not_direct_child', '中心化模式只允许把任务派给直接下级');
  }
  const chain = Array.isArray(input?.chain) ? input.chain.map(String) : [];
  if (chain.includes(caller.id) || chain.includes(target.id)) {
    throw fail(409, 'delegation_loop', '委派链里已经出现过调用方或目标实例');
  }
  const nextChain = [...chain, caller.id];
  const maxDepth = Number(org.max_depth ?? 3);
  if (nextChain.length > maxDepth) {
    throw fail(403, 'depth_exceeded', `超过组织级联深度上限（${maxDepth} 层）`);
  }
  const prompt = String(input?.prompt ?? '').trim();
  if (!prompt) throw fail(400, 'invalid_request', 'prompt 不能为空');
  const taskId = id('relay');
  db.prepare(
    `INSERT INTO relay_tasks
      (id, org_id, caller_instance_id, target_instance_id, status, prompt, context, cwd, title, chain_json, depth, created_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    org.id,
    caller.id,
    target.id,
    prompt.slice(0, 64 * 1024),
    String(input?.context ?? '').slice(0, 16 * 1024),
    String(input?.cwd ?? '').slice(0, 4096),
    String(input?.title ?? '').slice(0, 200),
    JSON.stringify(nextChain),
    nextChain.length,
    now(),
  );
  return relayTaskView(db.prepare('SELECT * FROM relay_tasks WHERE id = ?').get(taskId));
}

export function relayTaskView(row) {
  return {
    taskId: row.id,
    orgId: row.org_id,
    callerInstanceId: row.caller_instance_id,
    targetInstanceId: row.target_instance_id,
    status: row.status,
    prompt: row.prompt,
    context: row.context ?? '',
    cwd: row.cwd ?? '',
    title: row.title ?? '',
    chain: row.chain_json ? JSON.parse(row.chain_json) : [],
    depth: Number(row.depth ?? 0),
    summary: row.summary ?? '',
    error: row.error ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
  };
}

export function pendingRelayTasks(db, instanceId) {
  return db
    .prepare("SELECT * FROM relay_tasks WHERE target_instance_id = ? AND status = 'queued' ORDER BY created_at LIMIT 20")
    .all(instanceId)
    .map(relayTaskView);
}

export function claimRelayTask(db, taskId, instanceId) {
  const row = db.prepare('SELECT * FROM relay_tasks WHERE id = ?').get(String(taskId));
  if (!row) throw fail(404, 'task_not_found', '任务不存在');
  if (row.target_instance_id !== instanceId) throw fail(403, 'not_task_owner', '任务不属于该实例');
  if (row.status !== 'queued') throw fail(409, 'task_not_queued', `任务状态是 ${row.status}，不能领取`);
  db.prepare("UPDATE relay_tasks SET status = 'running', started_at = ? WHERE id = ?").run(now(), row.id);
  return relayTaskView(db.prepare('SELECT * FROM relay_tasks WHERE id = ?').get(row.id));
}

export function finishRelayTask(db, taskId, instanceId, { status = 'succeeded', summary = '', error = null } = {}) {
  const row = db.prepare('SELECT * FROM relay_tasks WHERE id = ?').get(String(taskId));
  if (!row) throw fail(404, 'task_not_found', '任务不存在');
  if (row.target_instance_id !== instanceId) throw fail(403, 'not_task_owner', '任务不属于该实例');
  const allowed = ['succeeded', 'failed', 'canceled'];
  if (!allowed.includes(status)) throw fail(400, 'invalid_status', `只接受 ${allowed.join('/')}`);
  db.prepare('UPDATE relay_tasks SET status = ?, summary = ?, error = ?, finished_at = ? WHERE id = ?').run(
    status,
    String(summary ?? '').slice(0, 32_000),
    error ? String(error).slice(0, 2_000) : null,
    now(),
    row.id,
  );
  return relayTaskView(db.prepare('SELECT * FROM relay_tasks WHERE id = ?').get(row.id));
}

export function relayTaskFor(db, taskId, instanceId) {
  const row = db.prepare('SELECT * FROM relay_tasks WHERE id = ?').get(String(taskId));
  if (!row) throw fail(404, 'task_not_found', '任务不存在');
  if (row.caller_instance_id !== instanceId && row.target_instance_id !== instanceId) {
    throw fail(403, 'task_forbidden', '任务与当前实例无关');
  }
  return relayTaskView(row);
}
