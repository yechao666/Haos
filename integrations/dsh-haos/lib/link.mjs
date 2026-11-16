/**
 * In-process Haos Link.
 *
 * 运行在 DSH 宿主进程内：
 *  - 注册实例、维持心跳；
 *  - 建立控制 WSS，接收 ping/status/diagnostics/notify 等命令；
 *  - 订阅 session/event，把会话/工具事件上报 Haos；
 *  - 复用当前 web server（如果存在）建立 WEB Tunnel。
 */
import { WebSocket } from 'ws';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, hostname, networkInterfaces, platform, arch, userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CurrentWeb, TunnelClient } from './tunnel.mjs';

const VERSION = '0.2.0-inprocess';
const BASE_CAPABILITIES = ['control', 'events', 'tools', 'sessions', 'workspace'];
const INTERESTING_EVENTS = new Set([
  'turn/start',
  'turn/end',
  'assistant/message',
  'tool/call',
  'tool/result',
  'status',
  'thinking',
  'text',
  'error',
]);

function unwrap(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') return value.get();
  return value;
}

function raw(input, key, fallback) {
  const value = unwrap(input?.[key]);
  return value === undefined || value === null || value === '' ? fallback : value;
}

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > 12_000 ? `${value.slice(0, 12_000)}…[truncated]` : value;
  }
  if (typeof value !== 'object') return value;
  if (depth > 5) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|authorization|cookie|api[_-]?key/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = redact(item, depth + 1);
    }
  }
  return out;
}

export class InProcessLink {
  constructor({ ctx, config = {}, logger = console }) {
    this.ctx = ctx;
    this.config = config;
    this.logger = logger;
    this.ws = null;
    this.connected = false;
    this.started = false;
    this.stopping = false;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.flushTimer = null;
    this.reconnectDelay = 1000;
    this.queue = [];
    this.disposers = [];
    this.startedAt = Date.now();
    this.identity = null;
    this.instanceId = null;
    this.instanceToken = null;
    this.eventCount = 0;
    this.workspaceRootPath = null;
    this.clientInstanceId = null;
    this.identityFile = null;
    this.lockDir = null;
    this.lockTimer = null;
    this.workspaceGuardInstalled = false;
    this.web = null;
    this.tunnel = null;
    this.webAttached = false;
  }

  get baseUrl() {
    return String(raw(this.config, 'baseUrl', 'http://127.0.0.1:4600')).replace(/\/+$/, '');
  }

  get workspaceRoot() {
    return this.workspaceRootPath
      || String(raw(this.config, 'workspaceRoot', resolve(homedir(), '.haos', 'workspace')))
      || resolve(homedir(), '.haos', 'workspace');
  }

  get friendlyName() {
    return String(raw(this.config, 'friendlyName', '')).trim().slice(0, 120);
  }

  get capabilitySummary() {
    return String(raw(this.config, 'capabilitySummary', '')).trim().slice(0, 2_000);
  }

  hostIp() {
    const interfaces = networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      for (const entry of entries || []) {
        if (entry && entry.family === 'IPv4' && !entry.internal) return entry.address;
      }
    }
    return '127.0.0.1';
  }

  profileName() {
    const index = process.argv.indexOf('--profile');
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : String(raw(this.config, 'profile', ''));
  }

  runtimeInfo() {
    return {
      hostIp: this.hostIp(),
      processUser: userInfo().username,
      pid: process.pid,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      profile: this.profileName() || null,
      dshHome: process.env.DSH_HOME || join(homedir(), '.dsh'),
    };
  }

  get instanceName() {
    return this.friendlyName || hostname();
  }

  get apiKey() {
    return String(raw(this.config, 'apiKey', process.env.HAOS_API_KEY || ''));
  }

  get webEnabled() {
    return this.config?.webEnabled !== false;
  }

  readIdentity() {
    try {
      return JSON.parse(readFileSync(this.identityFile, 'utf8'));
    } catch {
      return null;
    }
  }

  writeIdentity(patch) {
    this.identity = { ...(this.identity || {}), ...patch, updatedAt: new Date().toISOString() };
    writeFileSync(this.identityFile, JSON.stringify(this.identity, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.identityFile, 0o600);
    } catch {
      /* noop */
    }
  }

  async request(path, { method = 'POST', token, body } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      const error = new Error(data?.error?.message || `Haos HTTP ${response.status}`);
      error.status = response.status;
      error.code = data?.error?.code;
      throw error;
    }
    return data;
  }

  ensureHaosHome() {
    const configured = String(raw(this.config, 'haosHome', '')).trim();
    const dir = configured ? resolve(configured) : resolve(this.workspaceRoot);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.workspaceRootPath = dir;
    const identityDir = join(dir, '.haos');
    mkdirSync(identityDir, { recursive: true, mode: 0o700 });
    this.identityFile = join(identityDir, 'instance.json');
    this.identity = this.readIdentity();
    if (!this.identity || typeof this.identity.clientInstanceId !== 'string' || this.identity.clientInstanceId.length < 8) {
      this.identity = { version: 1, clientInstanceId: `dshc_${randomUUID()}`, createdAt: new Date().toISOString() };
      this.writeIdentity({});
    }
    this.clientInstanceId = this.identity.clientInstanceId;
    this.acquireHaosHomeLock(identityDir);
    if (!this.ctx?.inject) return this.seedWorkspaceFile(dir);
    this.ctx.inject(['workspaceRegistry'], (sctx) => {
      const registry = sctx.get('workspaceRegistry', false);
      if (!registry || typeof registry.create !== 'function') {
        this.seedWorkspaceFile(dir);
        return;
      }
      this.installWorkspaceGuard(registry);
      registry.create(dir, 'Haos 工作区').catch((error) => {
        this.logger.warn?.(`[dsh-haos] 创建 Haos 工作区失败：${error.message}`);
        this.seedWorkspaceFile(dir);
      });
    });
  }

  lockOwner() {
    return {
      clientInstanceId: this.clientInstanceId,
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
  }

  writeLockOwner() {
    if (!this.lockDir) return;
    const owner = this.lockOwner();
    const temp = join(this.lockDir, `owner.${process.pid}.tmp`);
    writeFileSync(temp, JSON.stringify(owner, null, 2), { mode: 0o600 });
    try {
      renameSync(temp, join(this.lockDir, 'owner.json'));
    } catch (error) {
      try {
        rmSync(temp, { force: true });
      } catch {
        /* noop */
      }
      throw error;
    }
  }

  acquireHaosHomeLock(identityDir) {
    const lockDir = join(identityDir, 'lock');
    const ownerFile = join(lockDir, 'owner.json');
    const attempt = (retry) => {
      try {
        mkdirSync(lockDir, { mode: 0o700 });
        this.lockDir = lockDir;
        this.writeLockOwner();
        this.lockTimer = setInterval(() => {
          try {
            this.writeLockOwner();
          } catch (error) {
            this.logger.warn?.(`[dsh-haos] 刷新 haos-home 锁心跳失败：${error.message}`);
          }
        }, 15_000);
        this.lockTimer.unref?.();
        this.logger.info?.(`[dsh-haos] Haos 工作区锁已获取：${this.workspaceRootPath}`);
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      let owner = null;
      try {
        owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
      } catch {
        owner = null;
      }
      const heartbeat = owner?.heartbeatAt ? Date.parse(owner.heartbeatAt) : 0;
      const age = Date.now() - heartbeat;
      let alive = false;
      if (owner?.hostname === hostname() && Number.isInteger(owner?.pid)) {
        try {
          process.kill(owner.pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      const stale = !owner || age > 90_000 || (owner.hostname === hostname() && !alive);
      if (!stale) {
        throw new Error(`haos-home 已被占用：${owner?.clientInstanceId || 'unknown'} (PID ${owner?.pid || '?'} @ ${owner?.hostname || '?'})`);
      }
      if (retry) throw new Error('haos-home 锁接管失败，请稍后重试');
      const staleDir = `${lockDir}.stale.${randomUUID()}`;
      try {
        renameSync(lockDir, staleDir);
        rmSync(staleDir, { recursive: true, force: true });
      } catch (error) {
        this.logger.warn?.(`[dsh-haos] 接管过期 Haos 工作区锁失败：${error.message}`);
      }
      this.logger.warn?.(`[dsh-haos] 接管过期 Haos 工作区锁：${this.workspaceRootPath}`);
      attempt(true);
    };
    attempt(false);
  }

  releaseHaosHomeLock() {
    clearInterval(this.lockTimer);
    this.lockTimer = null;
    if (!this.lockDir) return;
    try {
      const owner = JSON.parse(readFileSync(join(this.lockDir, 'owner.json'), 'utf8'));
      if (owner.clientInstanceId === this.clientInstanceId && owner.pid === process.pid) {
        rmSync(this.lockDir, { recursive: true, force: true });
      }
    } catch {
      /* noop */
    }
    this.lockDir = null;
  }

  installWorkspaceGuard(registry) {
    if (this.workspaceGuardInstalled || typeof registry.delete !== 'function') return;
    const originalDelete = registry.delete.bind(registry);
    const workspaceRoot = resolve(this.workspaceRootPath);
    registry.delete = (workspaceId) => {
      const workspace = typeof registry.get === 'function' ? registry.get(workspaceId) : null;
      if (workspace && resolve(workspace.path) === workspaceRoot) {
        throw new Error('haos-home 是 Haos 实例的根工作区，禁止删除');
      }
      return originalDelete(workspaceId);
    };
    this.workspaceGuardInstalled = true;
    // 清理旧配置留下的其他 Haos 工作区记录；只管理标题为 Haos 工作区的条目。
    if (typeof registry.list === 'function') {
      for (const workspace of registry.list()) {
        if (!workspace || resolve(workspace.path) === workspaceRoot) continue;
        if (workspace.title !== 'Haos 工作区') continue;
        try {
          Promise.resolve(originalDelete(workspace.id))
            .then(() => this.logger.info?.(`[dsh-haos] 清理旧 Haos 工作区记录：${workspace.path}`))
            .catch((error) => this.logger.warn?.(`[dsh-haos] 清理旧 Haos 工作区失败：${error.message}`));
        } catch (error) {
          this.logger.warn?.(`[dsh-haos] 清理旧 Haos 工作区失败：${error.message}`);
        }
      }
    }
    this.logger.info?.('[dsh-haos] 已保护 Haos 工作区，禁止删除');
  }

  seedWorkspaceFile(dir) {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
    const file = join(dshHome, 'storages', 'workspace.json');
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      let data = {};
      try {
        data = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        data = {};
      }
      const timestamp = new Date().toISOString();
      const tables = data.tables && typeof data.tables === 'object' ? data.tables : {};
      const workspaces = tables.workspaces && typeof tables.workspaces === 'object' ? tables.workspaces : {};
      let workspaceId = Object.keys(workspaces).find((key) => workspaces[key]?.path === dir);
      if (!workspaceId) {
        workspaceId = randomUUID();
        workspaces[workspaceId] = {
          path: dir,
          title: 'haos-home',
          sessionIds: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      }
      const global = data.global && typeof data.global === 'object' ? data.global : {};
      data.unit = { name: 'workspace', version: 2 };
      data.tables = { ...tables, workspaces };
      data.global = {
        initialized: true,
        workspaceIds: Object.keys(workspaces),
        archivedSessionIds: Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds : [],
        pinnedSessionIds: Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds : [],
        defaultWorkspaceId: global.defaultWorkspaceId || workspaceId,
      };
      writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
      try {
        chmodSync(file, 0o600);
      } catch {
        /* noop */
      }
    } catch (error) {
      this.logger.warn?.(`[dsh-haos] 写入 Haos 工作区失败：${error.message}`);
    }
  }

  async ensureRegistration() {
    const identity = this.readIdentity() || {};
    this.identity = identity;
    const token = identity.instanceToken || process.env.HAOS_INSTANCE_TOKEN || '';
    if (token) {
      try {
        const heartbeat = await this.request('/api/plugin/v1/heartbeat', {
          token,
          body: this.heartbeatBody(),
        });
        this.instanceToken = token;
        if (heartbeat?.instanceId) identity.instanceId = heartbeat.instanceId;
        if (!identity.instanceId) throw new Error('心跳响应缺少 instanceId');
        this.instanceId = identity.instanceId;
        this.writeIdentity({
          instanceToken: token,
          baseUrl: this.baseUrl,
          workspaceRoot: this.workspaceRoot,
          friendlyName: this.friendlyName,
          capabilitySummary: this.capabilitySummary,
        });
        this.logger.info?.(`[dsh-haos] 复用实例令牌 ${this.instanceId}`);
        return;
      } catch (error) {
        if (error.status !== 401) throw error;
        this.logger.warn?.('[dsh-haos] 实例令牌失效，尝试重新注册');
      }
    }

    if (!this.apiKey) throw new Error('缺少 Haos API Key');

    const result = await this.request('/api/plugin/v1/register', {
      body: {
        apiKey: this.apiKey,
        clientInstanceId: this.clientInstanceId,
        friendlyName: this.friendlyName,
        capabilitySummary: this.capabilitySummary,
        ...this.runtimeInfo(),
        ...(identity.instanceId ? { resumeInstanceId: identity.instanceId } : {}),
        instanceName: this.instanceName,
        machineId: `${hostname()}|${platform()}|${arch()}`,
        version: VERSION,
        platform: `${platform()}-${arch()}`,
        hostname: hostname(),
        workspaceRoot: this.workspaceRoot,
        webStatus: 'off',
        webTransport: 'tunnel',
        capabilities: this.capabilities(),
        mode: 'in-process',
      },
    });
    this.instanceId = result.instanceId;
    this.instanceToken = result.instanceToken;
    this.writeIdentity({
      instanceId: this.instanceId,
      instanceToken: this.instanceToken,
      baseUrl: this.baseUrl,
      name: this.instanceName,
      workspaceRoot: this.workspaceRoot,
      clientInstanceId: this.clientInstanceId,
      friendlyName: this.friendlyName,
      capabilitySummary: this.capabilitySummary,
      mode: 'in-process',
    });
    this.logger.info?.(`[dsh-haos] 注册成功 ${this.instanceId}`);
  }

  /** 能力声明（每行一条，兼容 `id | 标题 | 标签 | 说明`）→ 能力 id 列表。 */
  declaredCapabilities() {
    const text = String(raw(this.config, 'declaredCapabilities', ''));
    const ids = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split('|').map((part) => part.trim());
      const id = parts.length >= 3 && parts[0] ? parts[0] : `declared.cap${ids.length + 1}`;
      ids.push(String(id).slice(0, 60));
    }
    return ids.slice(0, 20);
  }

  capabilities() {
    const base = this.web ? [...BASE_CAPABILITIES, 'web', 'tunnel'] : [...BASE_CAPABILITIES];
    return [...new Set([...base, 'relay', ...this.declaredCapabilities()])];
  }

  webState() {
    return this.web?.state() || { status: 'off', transport: 'tunnel' };
  }

  heartbeatBody() {
    const web = this.webState();
    return {
      version: VERSION,
      platform: `${platform()}-${arch()}`,
      hostname: hostname(),
      workspaceRoot: this.workspaceRoot,
      webStatus: web.status || 'off',
      webPort: web.port,
      webTransport: 'tunnel',
      capabilities: this.capabilities(),
      web,
      clientInstanceId: this.clientInstanceId,
      friendlyName: this.friendlyName,
      capabilitySummary: this.capabilitySummary,
      ...this.runtimeInfo(),
      mode: 'in-process',
      eventCount: this.eventCount,
    };
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.startedAt = Date.now();
    this.ensureHaosHome();
    try {
      await this.ensureRegistration();
    } catch (error) {
      this.logger.error?.(`[dsh-haos] 注册失败：${error.message}`);
      this.started = false;
      return;
    }
    this.subscribeSessionEvents();
    this.connectControl();
    this.attachWeb();
    this.heartbeatTimer = setInterval(() => {
      this.request('/api/plugin/v1/heartbeat', {
        token: this.instanceToken,
        body: this.heartbeatBody(),
      }).catch((error) => this.logger.warn?.(`[dsh-haos] 心跳失败：${error.message}`));
    }, 20_000);
    this.heartbeatTimer.unref?.();
    this.flushTimer = setInterval(() => this.flush(), 700);
    this.flushTimer.unref?.();
    this.logger.info?.('[dsh-haos] in-process link 已启动');
  }

  connectControl() {
    if (this.stopping || !this.instanceToken) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/api/plugin/v1/stream';
    url.search = '';
    const ws = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${this.instanceToken}`,
        'x-haos-protocol': '1',
        'x-haos-instance': this.instanceId,
      },
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
    });
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      this.send({
        type: 'ready',
        v: 1,
        version: VERSION,
        platform: `${platform()}-${arch()}`,
        hostname: hostname(),
        workspaceRoot: this.workspaceRoot,
        capabilities: this.capabilities(),
        web: this.webState(),
        mode: 'in-process',
      });
      this.flush();
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        this.onControl(JSON.parse(data.toString()));
      } catch {
        /* ignore */
      }
    });
    ws.on('close', (code) => {
      this.connected = false;
      this.ws = null;
      if (this.stopping) return;
      this.logger.warn?.(`[dsh-haos] 控制通道断开（${code}），重连中`);
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connectControl(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    });
    ws.on('error', (error) => this.logger.warn?.(`[dsh-haos] 控制通道错误：${error.message}`));
  }

  send(payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  onControl(message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'hello') return;
    if (message.type !== 'command') return;
    this.handleCommand(message.kind, message.payload || {})
      .then((result) => this.send({ type: 'command.result', id: message.id, ok: true, result: result ?? null }))
      .catch((error) => this.send({ type: 'command.result', id: message.id, ok: false, error: error.message }));
  }

  async handleCommand(kind, payload) {
    switch (kind) {
      case 'ping':
        return { pong: true, at: new Date().toISOString(), instanceId: this.instanceId };
      case 'status':
        return {
          instanceId: this.instanceId,
          mode: 'in-process',
          version: VERSION,
          uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
          workspaceRoot: this.workspaceRoot,
          sessionEvents: this.eventCount,
          queuedEvents: this.queue.length,
          controlConnected: this.connected,
          capabilities: this.capabilities(),
          web: this.webState(),
        };
      case 'diagnostics':
        return {
          instanceId: this.instanceId,
          mode: 'in-process',
          version: VERSION,
          node: process.version,
          platform: `${platform()}-${arch()}`,
          hostname: hostname(),
          pid: process.pid,
          workspaceRoot: this.workspaceRoot,
          sessionEvents: this.eventCount,
          queuedEvents: this.queue.length,
          controlConnected: this.connected,
          identityFile: this.identityFile,
          capabilitySummary: this.capabilitySummary,
          web: this.webState(),
        };
      case 'notify':
        this.logger.info?.(`[dsh-haos] Haos 通知：${payload.title || ''} ${payload.message || ''}`.trim());
        this.send({
          type: 'event',
          kind: 'notification.received',
          payload: {
            level: payload.level || 'info',
            title: payload.title || 'Haos 通知',
            message: payload.message || '',
          },
        });
        return { delivered: true, at: new Date().toISOString() };
      case 'echo':
        return payload ?? {};
      case 'tunnel.reconnect':
        this.tunnel?.reconnect();
        return { ok: true, web: this.webState() };
      case 'web.close':
        this.tunnel?.stop();
        if (this.web) this.web.status = 'off';
        return { ok: true, web: this.webState() };
      case 'web.open':
      case 'web.restart': {
        if (!this.webEnabled) throw new Error('当前配置未开放 WEB');
        if (!this.web) {
          this.attachWeb();
          return { ok: true, web: this.webState(), note: '正在重新挂载当前 WEB' };
        }
        await this.web.connect();
        this.tunnel?.start();
        return { ok: true, web: this.webState() };
      }
      default:
        throw new Error(`未知命令：${kind}`);
    }
  }

  attachWeb() {
    if (this.webAttached || this.stopping) return;
    if (!this.webEnabled) {
      this.webAttached = true;
      this.logger.info?.('[dsh-haos] 配置未开放 WEB，跳过 Tunnel');
      return;
    }
    if (!this.ctx?.inject) return;
    this.webAttached = true;
    this.ctx.inject(['webServer', 'connection'], (sctx) => {
      if (this.stopping) return;
      const webServer = sctx.get('webServer', false);
      const connection = sctx.get('connection', false);
      if (!webServer || !connection) {
        this.logger.warn?.('[dsh-haos] webServer/connection 不可用，WEB Tunnel 未启用');
        return;
      }
      try {
        const origin = webServer.getOrigin();
        const authUrl = connection.authenticatedUrl(origin);
        const web = new CurrentWeb({
          instanceId: this.instanceId,
          origin,
          authUrl,
          logger: this.logger,
        });
        web.onEvent = (event) => {
          this.send({ type: 'event', kind: event.kind, payload: event.payload || {} });
          this.send({ type: 'heartbeat', ...this.heartbeatBody() });
        };
        this.web = web;
        this.tunnel = new TunnelClient({
          baseUrl: this.baseUrl,
          instanceId: this.instanceId,
          instanceToken: this.instanceToken,
          web,
          logger: this.logger,
        });
        web.connect()
          .then(() => {
            if (this.stopping) return;
            this.tunnel.start();
            this.send({ type: 'heartbeat', ...this.heartbeatBody() });
          })
          .catch((error) => this.logger.warn?.(`[dsh-haos] 当前 WEB 认证失败：${error.message}`));
      } catch (error) {
        this.logger.warn?.(`[dsh-haos] 挂载当前 WEB 失败：${error.message}`);
      }
    });
  }

  subscribeSessionEvents() {
    if (!this.ctx?.on) return;
    try {
      const dispose = this.ctx.on('session/event', (session, event) => {
        this.onSessionEvent(session, event);
      });
      if (typeof dispose === 'function') this.disposers.push(dispose);
      this.logger.info?.('[dsh-haos] 已订阅 session/event');
    } catch (error) {
      this.logger.warn?.(`[dsh-haos] 订阅 session/event 失败：${error.message}`);
    }
  }

  onSessionEvent(session, event) {
    if (!event || typeof event.type !== 'string') return;
    if (!INTERESTING_EVENTS.has(event.type) && !event.type.startsWith('tool/')) return;
    this.eventCount += 1;
    const payload = {
      sessionId: session?.id || session?.sessionId || null,
      eventType: event.type,
      seq: event.seq,
      data: redact(event.data),
      at: new Date().toISOString(),
      source: 'in-process-plugin',
    };
    this.queue.push({ kind: 'session.event', payload });
    if (this.queue.length > 500) this.queue.splice(0, this.queue.length - 500);
    if (this.queue.length >= 20) this.flush();
  }

  flush() {
    if (!this.connected) return;
    while (this.queue.length) {
      const item = this.queue.shift();
      if (!this.send({ type: 'event', ...item })) {
        this.queue.unshift(item);
        break;
      }
    }
  }

  stop() {
    this.stopping = true;
    this.started = false;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.flushTimer);
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* noop */
      }
    }
    this.releaseHaosHomeLock();
    try {
      this.tunnel?.stop();
    } catch {
      /* noop */
    }
    if (this.web) this.web.status = 'off';
    try {
      this.ws?.close(1001, 'plugin shutdown');
    } catch {
      /* noop */
    }
    this.ws = null;
    this.connected = false;
  }
}
