/**
 * dsh-haos：DSH 的 Haos 接入插件。
 *
 * 在 DSH 宿主进程内注册、心跳、控制、订阅 session/event、上报事件，
 * 复用当前 web server（如果存在）建立 WEB Tunnel。
 *
 * 不启动 sidecar；桌面/Web/headless profile 使用同一个插件路径。
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';
import { InProcessLink } from './link.mjs';
import { RelayRunner } from './relay.mjs';

export const name = 'dsh-haos';
export const inject = [];
export const HAOS_SETTINGS_NAMESPACE = 'dsh-haos';

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  // 多套连接配置；只有 activeProfileId 指向的一套生效。
  profilesJson: z.string().default('[]').volatile(),
  // 兼容旧版多配置数组；新保存只写 profilesJson。
  profiles: z.array(z.any()).default([]).volatile(),
  activeProfileId: z.string().default('').volatile(),
  // 兼容旧配置；新配置不再使用。
  baseUrl: z.string().default('').volatile(),
  apiKey: z.string().role('secret').default('').volatile(),
  friendlyName: z.string().default('').volatile(),
  capabilitySummary: z.string().default('').volatile(),
  workspaceRoot: z.string().default('').volatile(),
  // ── 组织与转发任务（原 dsh-co-dsh 能力）──────────────────
  declaredCapabilities: z
    .string()
    .default('')
    .volatile()
    .description('能力声明（每行一条，兼容 `id | 标题 | 标签 | 说明`），会上报到 Haos 组织树'),
  acceptRemoteTasks: z.boolean().default(true).volatile().description('接受 Haos 转发的任务'),
  allowedRoots: z.string().default('').volatile().description('转发任务允许使用的工作目录（每行一个；留空=拒绝）'),
  relayPollSeconds: z.number().default(2).volatile().description('轮询 Haos 转发任务的间隔（秒）'),
  maxTaskMinutes: z.number().default(60).volatile().description('单个转发任务的最长执行时间'),
  agentPreset: z.string().default('').volatile().description('转发任务使用的 agent preset（留空用 profile 默认）'),
  // 仅用于旧配置迁移；新配置不展示。
  haosHome: z.string().default('').volatile(),
});

function unwrap(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') return value.get();
  return value;
}

function raw(input, key, fallback) {
  const value = unwrap(input?.[key]);
  return value === undefined || value === null || value === '' ? fallback : value;
}

function normalizeProfile(input, index) {
  const unwrapped = unwrap(input);
  const source = unwrapped && typeof unwrapped === 'object' ? unwrapped : {};
  const id = String(unwrap(source.id) || `profile-${index + 1}`).trim() || `profile-${index + 1}`;
  return {
    id,
    friendlyName: String(unwrap(source.friendlyName) || '').trim().slice(0, 120),
    capabilitySummary: String(unwrap(source.capabilitySummary) || '').trim().slice(0, 2_000),
    baseUrl: String(unwrap(source.baseUrl) || 'http://127.0.0.1:4600').replace(/\/+$/, ''),
    apiKey: String(unwrap(source.apiKey) || ''),
    webEnabled: unwrap(source.webEnabled) !== false,
    workspaceRoot: String(unwrap(source.workspaceRoot) || '').trim().slice(0, 2_000),
  };
}

const PROFILE_FILE = join(process.env.DSH_HOME || resolve(homedir(), '.dsh'), 'haos-profiles.json');

function readProfilesFile() {
  try {
    const data = JSON.parse(readFileSync(PROFILE_FILE, 'utf8'));
    return Array.isArray(data?.profiles) ? data : null;
  } catch {
    return null;
  }
}

function writeProfilesFile(profiles, activeProfileId) {
  const data = {
    version: 1,
    profiles,
    activeProfileId,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(PROFILE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { chmodSync(PROFILE_FILE, 0o600); } catch { /* noop */ }
  return data;
}

export function resolveConfig(input = {}) {
  const legacy = {
    friendlyName: String(raw(input, 'friendlyName', '')),
    capabilitySummary: String(raw(input, 'capabilitySummary', '')),
    baseUrl: String(raw(input, 'baseUrl', process.env.HAOS_BASE_URL || 'http://127.0.0.1:4600')).replace(/\/+$/, ''),
    apiKey: String(raw(input, 'apiKey', process.env.HAOS_API_KEY || '')),
    enrollmentKey: String(raw(input, 'enrollmentKey', process.env.HAOS_ENROLLMENT_KEY || '')),
    workspaceRoot: String(raw(input, 'workspaceRoot', process.env.HAOS_WORKSPACE || '')),
  };
  const stored = readProfilesFile();
  const rawProfilesValue = stored ? null : unwrap(input?.profilesJson);
  let rawProfiles = stored?.profiles ?? unwrap(input?.profiles);
  if (typeof rawProfilesValue === 'string' && rawProfilesValue.trim()) {
    try { rawProfiles = JSON.parse(rawProfilesValue); } catch { rawProfiles = []; }
  }
  let profiles = Array.isArray(rawProfiles) ? rawProfiles.map(normalizeProfile) : [];
  if (profiles.length === 0) {
    profiles = [normalizeProfile({
      id: 'profile-1',
      ...legacy,
    }, 0)];
  }
  const ids = new Set();
  profiles = profiles.map((profile, index) => {
    let id = profile.id;
    if (ids.has(id)) id = `${id}-${index + 1}`;
    ids.add(id);
    return { ...profile, id };
  });
  const requested = String(stored?.activeProfileId || unwrap(input?.activeProfileId) || ids.values().next().value || '').trim();
  const active = profiles.find((profile) => profile.id === requested) ?? profiles[0];
  const legacyHome = String(raw(input, 'haosHome', ''));
  const workspaceRoot = active.workspaceRoot || legacyHome || process.env.HAOS_WORKSPACE || resolve(homedir(), '.haos', 'workspace');
  return {
    enabled: Boolean(raw(input, 'enabled', true)),
    profiles,
    activeProfileId: active.id,
    active,
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    webEnabled: active.webEnabled !== false,
    enrollmentKey: active.apiKey ? '' : legacy.enrollmentKey,
    haosHome: legacyHome,
    friendlyName: active.friendlyName,
    capabilitySummary: active.capabilitySummary,
    workspaceRoot,
  };
}

function log(...parts) {
  console.log('[dsh-haos]', ...parts);
}

function readIdentity(config) {
  const resolved = resolveConfig(config);
  const file = resolve(resolved.workspaceRoot, '.haos', 'instance.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取 Haos 实例身份（${file}）：${error.message}`);
  }
}

async function haosRequest(config, path, options = {}) {
  const resolved = resolveConfig(config);
  const identity = readIdentity(config);
  if (!identity.instanceToken) throw new Error('当前 Haos 配置尚未注册实例');
  const base = new URL(identity.baseUrl || resolved.baseUrl);
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new Error('Haos API 路径不允许跨 origin');
  const headers = {
    authorization: `Bearer ${identity.instanceToken}`,
    accept: 'application/json',
  };
  const init = { method: options.method || 'GET', headers };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  if (!response.ok) {
    const message = data && typeof data === 'object' && data.error ? data.error.message : text;
    throw new Error(`Haos HTTP ${response.status}: ${String(message || '').slice(0, 400)}`);
  }
  return data;
}

async function waitHaosTask(config, taskId, waitSeconds, peerName, exec) {
  const deadline = Date.now() + Math.max(1, waitSeconds) * 1000;
  let task = null;
  while (Date.now() < deadline) {
    if (exec?.signal?.aborted) break;
    task = await haosRequest(config, `/api/plugin/v1/tasks/${encodeURIComponent(taskId)}`);
    if (['succeeded', 'failed', 'canceled'].includes(task?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  task = task ?? (await haosRequest(config, `/api/plugin/v1/tasks/${encodeURIComponent(taskId)}`));
  return {
    taskId: task.taskId,
    status: task.status,
    peer: peerName || '',
    title: task.title ?? '',
    cwd: task.cwd ?? '',
    summary: task.summary ?? '',
    error: task.error ?? null,
    chain: task.chain ?? [],
    depth: task.depth ?? 0,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    transport: 'haos',
  };
}

function textOutput(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

export function createToolDefinitions(config) {
  return [
  {
    name: 'haos_instance_info',
    description:
      '查询当前 DSH 实例在 Haos 中的状态：在线、能力、WEB、Tunnel、工作目录和最近控制通道状态。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return haosRequest(config, '/api/plugin/v1/instance');
    },
  },
  {
    name: 'haos_notify',
    description: '向 Haos 控制台发送一条通知，出现在当前实例的事件流中。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '通知正文' },
        title: { type: 'string', description: '通知标题，可选' },
        level: {
          type: 'string',
          enum: ['info', 'success', 'warning', 'error'],
          description: '通知级别，默认 info',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
    async execute(args) {
      return haosRequest(config, '/api/plugin/v1/notify', {
        method: 'POST',
        body: {
          message: String(args.message ?? ''),
          title: args.title ? String(args.title) : 'DSH 通知',
          level: args.level || 'info',
        },
      });
    },
  },
  {
    name: 'haos_report',
    description: '向 Haos 上报一条结构化事件，用于后续自动化、审计或项目级功能。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: '事件类型，例如 dsh.note、dsh.result' },
        payload: { type: 'object', description: '事件数据，必须是 JSON 对象', additionalProperties: true },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    async execute(args) {
      return haosRequest(config, '/api/plugin/v1/events', {
        method: 'POST',
        body: {
          kind: String(args.kind ?? 'dsh.event'),
          payload: args.payload && typeof args.payload === 'object' ? args.payload : {},
        },
      });
    },
  },
  {
    name: 'haos_org',
    description:
      '读取本实例所在的 Haos 组织树：组织、自己的角色/深度、成员（含能力与在线状态）。判断某个任务该派给谁时先看它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const doc = await haosRequest(config, '/api/plugin/v1/org');
      const identity = readIdentity(config);
      const self = (doc?.members ?? []).find((member) => member.instanceId === identity.instanceId) ?? null;
      return {
        org: doc?.org ?? null,
        self,
        members: (doc?.members ?? []).filter((member) => member.instanceId !== identity.instanceId),
      };
    },
  },
  {
    name: 'haos_delegate',
    description:
      '把任务经 Haos 转发给组织里的直接下级执行：中心会校验组织、直接下级、防环与深度，任务会出现在 Haos 控制台并保持可审计。远端看不到本对话，必须写清目标、验收标准与工作目录。',
    parameters: {
      type: 'object',
      properties: {
        peer: { type: 'string', description: '目标成员：haos_org 里的名字或实例 ID' },
        prompt: { type: 'string', description: '任务说明（必填）：目标、验收标准、期望产出、必要背景' },
        cwd: { type: 'string', description: '远端工作目录（必须在对方的 allowedRoots 内）' },
        context: { type: 'string', description: '可选补充背景' },
        title: { type: 'string', description: '任务短标题，便于在 Haos 控制台检索' },
        waitSeconds: { type: 'number', description: '最多等待秒数，0 表示只提交不等待' },
      },
      required: ['peer', 'prompt'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const identity = readIdentity(config);
      const doc = await haosRequest(config, '/api/plugin/v1/org');
      const needle = String(args.peer ?? '').trim().toLowerCase();
      const member =
        (doc?.members ?? []).find((item) => String(item.instanceId).toLowerCase() === needle) ??
        (doc?.members ?? []).find((item) => String(item.name).toLowerCase() === needle) ??
        null;
      if (!member) throw new Error(`组织里没有成员：${args.peer}`);
      if (member.instanceId === identity.instanceId) throw new Error('不能把任务派给自己');
      const self = (doc?.members ?? []).find((item) => item.instanceId === identity.instanceId);
      if (member.parentInstanceId !== self?.instanceId) {
        throw new Error(`中心化模式只允许派给直接下级：${member.name} 不是本实例的下级`);
      }
      const created = await haosRequest(config, '/api/plugin/v1/tasks', {
        method: 'POST',
        body: {
          targetInstanceId: member.instanceId,
          prompt: String(args.prompt ?? ''),
          context: args.context ? String(args.context) : '',
          cwd: args.cwd ? String(args.cwd) : '',
          title: args.title ? String(args.title) : '',
        },
      });
      const waitSeconds = Number.isFinite(Number(args.waitSeconds)) ? Math.max(0, Math.round(Number(args.waitSeconds))) : 120;
      if (waitSeconds <= 0) return { ...created, peer: member.name, note: '已提交给 Haos，用 haos_task 轮询。' };
      return waitHaosTask(config, created.taskId, waitSeconds, member.name, exec);
    },
  },
  {
    name: 'haos_task',
    description: '查询（并可等待）一个经 Haos 转发的任务状态与结果。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'haos_delegate 返回的 taskId（relay_…）' },
        waitSeconds: { type: 'number', description: '最多等待秒数，0 表示只读当前状态' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const waitSeconds = Number.isFinite(Number(args.waitSeconds)) ? Math.max(0, Math.round(Number(args.waitSeconds))) : 0;
      if (waitSeconds <= 0) return haosRequest(config, `/api/plugin/v1/tasks/${encodeURIComponent(args.taskId)}`);
      return waitHaosTask(config, String(args.taskId), waitSeconds, '', exec);
    },
  },
  {
    name: 'haos_workspace',
    description: '返回当前 DSH 实例的 Haos 工作区路径和实例 ID，不读取文件内容。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const identity = readIdentity(config);
      return {
        instanceId: identity.instanceId,
        workspaceRoot: identity.workspaceRoot,
        friendlyName: identity.friendlyName,
        capabilitySummary: identity.capabilitySummary,
        publicPath: `/w/${identity.instanceId}/`,
      };
    },
  },
  ];
}

// Kept for tests and introspection; real registrations bind the active config.
export const toolDefinitions = createToolDefinitions({});

function registerTools(ctx, config) {
  ctx.inject(['tools'], (sctx) => {
    const tools = sctx.get('tools', false);
    if (!tools) return;
    for (const definition of createToolDefinitions(config)) {
      tools.register({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        output: {
          schema: { type: 'object' },
          render: (_args, value) => textOutput(value),
        },
        execute: definition.execute,
      });
    }
  });
}

export function apply(ctx, config = {}) {
  if (process.env.HAOS_PLUGIN_DISABLED === '1') return;

  let link = null;
  let activeSignature = '';

  // 首次升级时把旧的 profile 配置迁移到插件自己的配置文件。
  if (!readProfilesFile()) {
    const initial = resolveConfig(config);
    if (initial.profiles.some((profile) => profile.apiKey)) {
      writeProfilesFile(initial.profiles, initial.activeProfileId);
    }
  }

  let relay = null;
  const stopLink = () => {
    relay?.stop();
    relay = null;
    if (!link) return;
    const current = link;
    link = null;
    try {
      current.stop();
    } catch {
      /* noop */
    }
  };

  const startLink = () => {
    const current = resolveConfig(config);
    if (!current.enabled) {
      stopLink();
      return;
    }
    stopLink();
    link = new InProcessLink({
      ctx,
      config: current,
      logger: {
        info: (...args) => log(...args),
        warn: (...args) => console.warn('[dsh-haos]', ...args),
        error: (...args) => console.error('[dsh-haos]', ...args),
      },
    });
    link.start().catch((error) => log('in-process link 启动失败', error.message));
    relay = new RelayRunner({
      ctx,
      config,
      request: (path, options) => haosRequest(config, path, options),
      logger: { info: (...args) => log(...args), warn: (...args) => console.warn('[dsh-haos]', ...args), error: (...args) => console.error('[dsh-haos]', ...args) },
      pollSeconds: resolveConfig(config).relayPollSeconds,
    });
    relay.start();
  };

  const runtimeSignature = (current) => JSON.stringify({
    enabled: current.enabled,
    baseUrl: current.baseUrl,
    apiKey: current.apiKey,
    webEnabled: current.webEnabled,
    friendlyName: current.friendlyName,
    capabilitySummary: current.capabilitySummary,
    workspaceRoot: current.workspaceRoot,
  });

  const startRuntime = (force = false) => {
    const current = resolveConfig(config);
    const signature = runtimeSignature(current);
    if (!force && signature === activeSignature && link) return;
    activeSignature = signature;
    if (!current.enabled) {
      stopLink();
      log('已禁用');
      return;
    }
    startLink();
  };

  ctx.effect(
    () => {
      startRuntime(true);
      return () => stopLink();
    },
    'dsh-haos: lifecycle',
  );

  ctx.inject(['settings'], (sctx) => {
    try {
      const settings = sctx.get('settings', false);
      if (settings?.configure) {
        sctx.effect(() => settings.configure({ auto: false }, ctx.fiber), 'dsh-haos: settings form');
      }
      sctx.effect(
        () =>
          sctx.on('settings/document-updated', (...args) => {
            if (String(args[0]) === HAOS_SETTINGS_NAMESPACE) startRuntime();
          }),
        'dsh-haos: settings subscription',
      );
    } catch (error) {
      log('设置服务不可用，仅按 profile 配置启动', error.message);
    }
  });

  {
    ctx.inject(['systemPrompt'], (sctx) => {
      try {
        const systemPrompt = sctx.get('systemPrompt', false);
        if (!systemPrompt) return;
        const text = () => {
          const base =
            '本 DSH 实例已接入 Haos（dsh-haos，in-process 模式）：组织与任务转发都由 Haos 中心管理。' +
            '可用 haos_instance_info 查状态、haos_org 看组织树、haos_delegate 把任务经 Haos 转给直接下级、haos_task 查转发任务。';
          const view = relay?.orgCache;
          if (!view) {
            void relay?.org().catch(() => {});
            return `${base}\n（组织信息加载中）`;
          }
          const identity = (() => {
            try {
              return readIdentity(config);
            } catch {
              return null;
            }
          })();
          const self = (view.members ?? []).find((member) => member.instanceId === identity?.instanceId);
          const children = (view.members ?? []).filter((member) => member.parentInstanceId === identity?.instanceId);
          const lines = [
            base,
            '',
            `## Haos 组织（${view.org?.id ?? '未加入'}）`,
            `你的位置：${self?.name ?? identity?.instanceId ?? '本实例'}（${self?.parentInstanceId ? 'member' : 'leader'}，depth ${self?.depth ?? 0}，级联上限 ${view.org?.maxDepth ?? 3} 层）`,
            `下级：${children.length ? children.map((member) => `${member.name}(depth ${member.depth})`).join('、') : '无'}`,
            '任务只能经 Haos 转给直接下级；不要尝试绕过中心直连其它实例。',
          ];
          return lines.join('\n');
        };
        sctx.effect(
          () =>
            systemPrompt.section({
              name: 'plugin:dsh-haos',
              order: 170,
              text,
            }),
          'dsh-haos: prompt section',
        );
      } catch {
        /* 提示段失败不影响控制面 */
      }
    });
  }

  // Host -> browser config API for the client settings page.
  // 配置直接写插件自己的 JSON 文件，绕开 DSH settings schema 的 volatile 限制。
  ctx.inject(['webServer'], (sctx) => {
    try {
      const webServer = sctx.get('webServer', false);
      if (!webServer) return;
      const readBody = (req) => new Promise((resolveBody, reject) => {
        let body = '';
        let size = 0;
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > 256 * 1024) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
          body += chunk;
        });
        req.on('end', () => {
          try { resolveBody(body ? JSON.parse(body) : {}); } catch (error) { reject(Object.assign(error, { status: 400 })); }
        });
        req.on('error', reject);
      });
      const formFromConfig = () => {
        const current = resolveConfig(config);
        const value = {
          profilesJson: JSON.stringify(current.profiles),
          activeProfileId: current.activeProfileId,
        };
        return {
          autoGenerate: false,
          ns: HAOS_SETTINGS_NAMESPACE,
          schema: {},
          revision: 0,
          applies: 'live',
          value,
          base: value,
          user: value,
          secrets: [],
        };
      };
      const handler = async (req, res) => {
        try {
          if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ form: formFromConfig() }));
            return;
          }
          if (req.method === 'POST') {
            const body = await readBody(req);
            const incoming = Array.isArray(body?.patch?.profiles)
              ? body.patch.profiles
              : (typeof body?.patch?.profilesJson === 'string' ? (() => { try { return JSON.parse(body.patch.profilesJson); } catch { return null; } })() : null);
            if (!Array.isArray(incoming)) throw Object.assign(new Error('缺少配置列表'), { status: 400 });
            const current = resolveConfig(config);
            const merged = incoming.map((profile, index) => {
              const id = String(profile?.id || `profile-${index + 1}`);
              const previous = current.profiles.find((item) => item.id === id);
              return {
                id,
                friendlyName: String(profile?.friendlyName || '').slice(0, 120),
                capabilitySummary: String(profile?.capabilitySummary || '').slice(0, 2_000),
                baseUrl: String(profile?.baseUrl || 'http://127.0.0.1:4600').replace(/\/+$/, ''),
                apiKey: profile?.apiKey?.trim() ? profile.apiKey : previous?.apiKey || '',
                webEnabled: profile?.webEnabled !== false,
                workspaceRoot: String(profile?.workspaceRoot || ''),
              };
            });
            const activeProfileId = merged.some((profile) => profile.id === body?.patch?.activeProfileId)
              ? body.patch.activeProfileId
              : merged[0]?.id || '';
            writeProfilesFile(merged, activeProfileId);
            setImmediate(() => startRuntime(true));
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ form: formFromConfig() }));
            return;
          }
          res.writeHead(405, { allow: 'GET, POST', 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'method not allowed' } }));
        } catch (error) {
          const status = Number(error.status) || 500;
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ error: { code: error.name || 'error', message: error.message } }));
        }
      };
      const testHandler = async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'method not allowed' } }));
            return;
          }
          const body = await readBody(req);
          const current = resolveConfig(config);
          const selected = body.profileId
            ? current.profiles.find((profile) => profile.id === body.profileId)
            : null;
          const baseUrl = String(body.baseUrl || selected?.baseUrl || current.baseUrl).replace(/\/+$/, '');
          const apiKey = String(body.apiKey || selected?.apiKey || (body.profileId ? '' : current.apiKey) || '');
          if (!apiKey) throw Object.assign(new Error('缺少 API Key'), { status: 400 });
          const target = new URL('/api/plugin/v1/validate-key', baseUrl);
          if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Haos 地址必须是 http(s)');
          const response = await fetch(target, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey }),
          });
          const data = await response.json().catch(() => ({}));
          res.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify(data));
        } catch (error) {
          const status = Number(error.status) || 502;
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ error: { message: error.message } }));
        }
      };
      sctx.effect(
        () => webServer.register({ kind: 'exact', path: '/api/haos/test', handler: testHandler }),
        'dsh-haos: test route',
      );
      sctx.effect(
        () => webServer.register({ kind: 'exact', path: '/api/haos/config', handler }),
        'dsh-haos: config route',
      );
    } catch (error) {
      log('配置 API 注册失败', error.message);
    }
  });

  registerTools(ctx, config);

  log('插件已加载', {
    workspace: resolveConfig(config).workspaceRoot,
    home: homedir(),
  });
}
