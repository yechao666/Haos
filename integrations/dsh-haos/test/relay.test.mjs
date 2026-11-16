import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RelayRunner,
  buildRelayPrompt,
  isInside,
  normalizeRoots,
  resolveWorkspace,
  summarizeSession,
} from '../lib/relay.mjs';

test('工作目录必须落在 allowedRoots 内', () => {
  const root = mkdtempSync(join(tmpdir(), 'haos-relay-'));
  assert.deepEqual(resolveWorkspace('', []), { ok: false, reason: 'no_roots' });
  assert.equal(resolveWorkspace('', [root]).ok, true);
  assert.equal(resolveWorkspace(join(root, 'sub'), [root]).ok, true);
  assert.deepEqual(resolveWorkspace('/etc', [root]), { ok: false, reason: 'outside_roots' });
  assert.equal(isInside('/work', '/work/a'), true);
  assert.equal(isInside('/work', '/workshop/a'), false);
  assert.deepEqual(normalizeRoots(`${root}\n${root}`), [root]);
});

test('转发提示词写明来源与输出契约', () => {
  const text = buildRelayPrompt({ prompt: '跑测试', callerInstanceId: 'ins_lead', depth: 1 });
  assert.match(text, /Haos 中心转发/);
  assert.match(text, /ins_lead/);
  assert.match(text, /结论：/);
  assert.match(text, /需要人工确认：/);
});

function makeRunner({ pending, executor, config = {} } = {}) {
  const calls = [];
  const queue = pending ? [...pending] : [];
  const request = async (path, options = {}) => {
    calls.push({ path, method: options.method ?? 'GET' });
    if (path.endsWith('/tasks/pending')) return { tasks: queue.slice() };
    if (path.endsWith('/claim')) {
      const claimed = queue.shift();
      return { ...claimed, status: 'running' };
    }
    if (path.endsWith('/result')) return { status: 'succeeded' };
    if (path.endsWith('/fail')) return { status: 'failed' };
    return {};
  };
  const runner = new RelayRunner({
    ctx: { get: () => undefined },
    config: { enabled: true, acceptRemoteTasks: true, ...config },
    request,
    logger: { info() {}, warn() {}, error() {} },
    executor: executor ?? (async () => ({ ok: true, summary: '结论：ok' })),
    pollSeconds: 999,
  });
  return { runner, calls, queue };
}

test('拉取 pending 任务 → claim → 执行 → result', async () => {
  const { runner, calls } = makeRunner({ pending: [{ taskId: 'relay_1', prompt: 'x', chain: [], depth: 1 }] });
  await runner.tick();
  const paths = calls.map((call) => `${call.method} ${call.path.replace('/api/plugin/v1', '')}`);
  assert.deepEqual(paths, [
    'GET /tasks/pending',
    'POST /tasks/relay_1/claim',
    'POST /tasks/relay_1/result',
  ]);
});

test('执行失败时回写 fail', async () => {
  const { runner, calls } = makeRunner({
    pending: [{ taskId: 'relay_2', prompt: 'x' }],
    executor: async () => ({ ok: false, error: '模型不可用' }),
  });
  await runner.tick();
  assert.equal(calls.some((call) => call.path.endsWith('/fail')), true);
  assert.equal(calls.some((call) => call.path.endsWith('/result')), false);
});

test('关闭 acceptRemoteTasks 后完全不轮询', async () => {
  const { runner, calls } = makeRunner({ pending: [{ taskId: 'relay_3' }], config: { acceptRemoteTasks: false } });
  await runner.tick();
  assert.equal(calls.length, 0);
});

test('summarizeSession 取本轮最后的助手文本', () => {
  const events = [
    { type: 'turn/start' },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '中间' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '结论：完成' }] } } },
    { type: 'turn/end', data: { reason: { kind: 'stop' } } },
  ];
  const session = { seq: events.length, eventAt: (index) => events[index] };
  assert.equal(summarizeSession(session, 0), '结论：完成');
});
