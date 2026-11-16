/**
 * Haos 转发任务的执行器（原 dsh-co-dsh 的入站能力搬进 Haos 插件）。
 *
 * 工作方式：
 *   1. 每 `relayPollSeconds` 秒向 Haos 拉一次 `GET /api/plugin/v1/tasks/pending`；
 *   2. 对每条任务先 claim，再用本机 DSH 的 agents 服务开一个独立会话真正执行；
 *   3. 完成后 `POST /tasks/:id/result`，失败/超时 `POST /tasks/:id/fail`。
 *
 * 规则在 Haos 中心校验（组织、直接下级、防环、深度）；这里只做本地安全边界：
 *   - `acceptRemoteTasks` 关闭时完全拒绝；
 *   - 任务的工作目录必须落在 `allowedRoots` 内。
 */
import { randomBytes } from 'node:crypto';
import { isAbsolute, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

function unwrap(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') return value.get();
  return value;
}

function raw(input, key, fallback) {
  const value = unwrap(input?.[key]);
  return value === undefined || value === null || value === '' ? fallback : value;
}

function normalizeRoot(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return resolve(homedir(), text.slice(2));
  return resolve(text);
}

export function normalizeRoots(input) {
  const seen = new Set();
  const roots = [];
  for (const item of String(input ?? '').split(/[\r\n,]+/)) {
    const root = normalizeRoot(item);
    if (!root || seen.has(root)) continue;
    seen.add(root);
    roots.push(root);
  }
  return roots;
}

export function isInside(root, target) {
  if (!root || !target) return false;
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** 任务工作目录必须落在允许的根目录内（留空 = 拒绝所有远端任务）。 */
export function resolveWorkspace(cwd, roots) {
  if (!roots.length) return { ok: false, reason: 'no_roots' };
  const target = normalizeRoot(cwd) ?? roots[0];
  if (!isAbsolute(target)) return { ok: false, reason: 'not_absolute' };
  const root = roots.find((item) => isInside(item, target));
  if (!root) return { ok: false, reason: 'outside_roots' };
  return { ok: true, path: target, root };
}

export function summarizeSession(session, firstSeq) {
  let started = false;
  let text = '';
  let error = null;
  for (let seq = firstSeq; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq);
    if (!event) continue;
    if (event.type === 'turn/start') {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content ?? [];
      const joined = Array.isArray(content)
        ? content
            .filter((block) => block?.type === 'text')
            .map((block) => String(block.text ?? ''))
            .join('')
        : '';
      if (joined.trim()) text = joined;
    }
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'error') {
      error = event.data.reason.error ?? new Error('Agent 执行失败');
    }
  }
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return text.trim();
}

export function buildRelayPrompt(task) {
  return [
    `这是一项由 Haos 中心转发来的任务（来源实例：${task.callerInstanceId}，层级 depth ${task.depth ?? 0}）。`,
    '',
    '任务：',
    String(task.prompt ?? ''),
    task.context ? `\n补充背景：\n${task.context}` : '',
    '',
    '执行约定：',
    '- 直接在本机完成工作，不要等待用户输入；没有人会在这个会话里回答问题。',
    '- 需要审批而被拒绝时不要反复重试，记录原因后继续其它部分。',
    '',
    '输出约定（必须遵守，中心会转述给发起方）：',
    '结论：<一段可直接转述的中文结果，含关键数字与文件绝对路径>',
    '需要人工确认：<没有就写「无」>',
  ].join('\n');
}

/**
 * @param {{
 *   ctx: object,
 *   config: object,
 *   request: (path: string, options?: object) => Promise<any>,
 *   logger?: object,
 *   executor?: (task: object) => Promise<{ok: boolean, summary?: string, error?: string}>,
 *   pollSeconds?: number,
 * }} options
 */
export class RelayRunner {
  constructor({ ctx, config, request, logger, executor, pollSeconds }) {
    this.ctx = ctx;
    this.config = config;
    this.request = request;
    this.logger = logger ?? console;
    this.executor = executor ?? ((task) => this.defaultExecutor(task));
    this.pollMs = Math.max(500, Number(pollSeconds ?? raw(config, 'relayPollSeconds', 2)) * 1000 || 2000);
    this.timer = null;
    this.polling = false;
    this.stopped = false;
    this.orgCache = null;
    this.orgAt = 0;
  }

  get enabled() {
    return Boolean(unwrap(this.config?.enabled)) && unwrap(this.config?.acceptRemoteTasks) !== false;
  }

  start() {
    if (this.timer || !this.enabled) return false;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
    void this.tick();
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 组织树（缓存 10 秒），供提示词与工具复用。 */
  async org({ force = false } = {}) {
    if (!force && this.orgCache && Date.now() - this.orgAt < 10_000) return this.orgCache;
    const view = await this.request('/api/plugin/v1/org');
    this.orgCache = view ?? { org: null, members: [] };
    this.orgAt = Date.now();
    return this.orgCache;
  }

  async tick() {
    if (this.polling || this.stopped || !this.enabled) return;
    this.polling = true;
    try {
      const payload = await this.request('/api/plugin/v1/tasks/pending');
      for (const task of payload?.tasks ?? []) {
        if (this.stopped) break;
        try {
          const claimed = await this.request(`/api/plugin/v1/tasks/${encodeURIComponent(task.taskId)}/claim`, {
            method: 'POST',
            body: {},
          });
          this.logger.info?.(`[dsh-haos] 收到转发任务 ${claimed.taskId}（depth ${claimed.depth}）`);
          const outcome = await this.executor(claimed);
          if (outcome?.ok) {
            await this.request(`/api/plugin/v1/tasks/${encodeURIComponent(task.taskId)}/result`, {
              method: 'POST',
              body: { summary: String(outcome.summary ?? '').slice(0, 32_000) },
            });
          } else {
            await this.request(`/api/plugin/v1/tasks/${encodeURIComponent(task.taskId)}/fail`, {
              method: 'POST',
              body: { error: String(outcome?.error ?? '任务失败').slice(0, 2_000), canceled: Boolean(outcome?.canceled) },
            });
          }
        } catch (error) {
          this.logger.warn?.(`[dsh-haos] 处理转发任务失败：${error?.message ?? error}`);
        }
      }
    } catch (error) {
      this.logger.warn?.(`[dsh-haos] 拉取转发任务失败：${error?.message ?? error}`);
    } finally {
      this.polling = false;
    }
  }

  /** 默认执行器：在本机开一个独立 DSH 会话把任务真正做完。 */
  async defaultExecutor(task) {
    const agents = this.ctx.get?.('agents', false);
    const sessions = this.ctx.get?.('sessions', false);
    const defaultModel = this.ctx.get?.('agentDefaultModel', false);
    const subagents = this.ctx.get?.('subagents', false);
    if (!agents || !sessions) return { ok: false, error: '本机缺少 agents/sessions 服务，无法执行转发任务' };

    const roots = normalizeRoots(raw(this.config, 'allowedRoots', ''));
    const workspace = resolveWorkspace(task.cwd, roots);
    if (!workspace.ok) {
      return {
        ok: false,
        error:
          workspace.reason === 'no_roots'
            ? '本机没有配置 allowedRoots，拒绝所有转发任务'
            : `工作目录不在 allowedRoots 内：${task.cwd || '(默认)'}`,
      };
    }

    const selection = defaultModel?.currentSelection?.() ?? {};
    const agentOptions = {};
    if (selection.provider) agentOptions.provider = selection.provider;
    if (selection.model) agentOptions.model = selection.model;
    if (selection.reasoningEffort) agentOptions.reasoningEffort = selection.reasoningEffort;
    if (!agentOptions.provider || !agentOptions.model) return { ok: false, error: '无法确定本机默认模型' };

    const sessionId = `session-haos-relay-${randomBytes(6).toString('base64url')}`;
    const handle = await agents.create({ sessionId, meta: { cwd: workspace.path }, agentOptions });
    const agent = handle?.agent ?? handle;
    if (!agent) return { ok: false, error: 'agents.create 没有返回 Agent' };

    const presets = this.ctx.get?.('agentPresets', false);
    const presetId = raw(this.config, 'agentPreset', '') || presets?.defaultId || '';
    if (presetId && presets?.select) {
      try {
        await presets.select(agent, presetId);
      } catch (error) {
        return { ok: false, error: `选择 agent preset 失败：${error?.message ?? error}` };
      }
    }

    const firstSeq = agent.session.seq;
    const timeoutMs = Math.max(60_000, Number(raw(this.config, 'maxTaskMinutes', 60)) * 60_000);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`任务超过 ${Math.round(timeoutMs / 60000)} 分钟`)), timeoutMs);
      timer.unref?.();
    });
    try {
      agent.followup({
        id: randomBytes(8).toString('hex'),
        role: 'user',
        content: [{ type: 'text', text: buildRelayPrompt(task) }],
        source: { kind: 'user' },
      });
      await Promise.race([agent.whenIdle(), timeout]);
      while (subagents?.waitForChildren ? await subagents.waitForChildren(agent) : false) await agent.whenIdle();
      await sessions.flush?.(agent.session);
      const summary = summarizeSession(agent.session, firstSeq) || '任务结束，但 Agent 没有产生文本输出。';
      return { ok: true, summary: summary.slice(0, 32_000) };
    } catch (error) {
      try {
        agent.cancel?.(error);
      } catch {
        /* 忽略 */
      }
      return { ok: false, error: String(error?.message ?? error) };
    } finally {
      clearTimeout(timer);
      setTimeout(() => {
        try {
          if (typeof agent.dispose === 'function') agent.dispose();
          else agent.cancel?.(new Error('释放转发任务会话'));
        } catch {
          /* 忽略 */
        }
      }, 5 * 60_000).unref?.();
    }
  }
}
