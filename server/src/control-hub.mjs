import { WebSocketServer } from 'ws';
import { bearer, instanceByToken } from './auth.mjs';
import { now } from './db.mjs';
import { id } from './lib/ids.mjs';

const CONTROL_PATH = '/api/plugin/v1/stream';
const COMMAND_KINDS = new Set([
  'ping',
  'status',
  'diagnostics',
  'web.restart',
  'web.close',
  'web.open',
  'tunnel.reconnect',
  'notify',
  'echo',
]);

function safeJson(value, max = 20_000) {
  try {
    const text = JSON.stringify(value ?? null);
    return text.length > max ? JSON.stringify({ truncated: true, preview: text.slice(0, max) }) : text;
  } catch {
    return JSON.stringify({ error: 'unserializable' });
  }
}

function parseJson(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function commandView(row) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    payload: parseJson(row.payload_json, {}),
    result: parseJson(row.result_json, null),
    error: row.error || null,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    completedAt: row.completed_at,
  };
}

function eventView(row) {
  return {
    id: row.id,
    kind: row.kind,
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

export class ControlHub {
  constructor({ db, logger = console }) {
    this.db = db;
    this.logger = logger;
    this.connections = new Map();
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 512 * 1024 });
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== CONTROL_PATH) return false;
    const instance = instanceByToken(this.db, bearer(req) || url.searchParams.get('token'));
    if (!instance) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.register(instance, ws));
    return true;
  }

  register(instance, ws) {
    const old = this.connections.get(instance.id);
    if (old) {
      try {
        old.ws.close(4001, 'replaced');
      } catch {
        /* noop */
      }
    }
    const connection = {
      instanceId: instance.id,
      instance,
      ws,
      connectedAt: now(),
      lastSeenAt: now(),
    };
    this.connections.set(instance.id, connection);
    this.db
      .prepare('UPDATE instances SET status = ?, last_seen_at = ? WHERE id = ?')
      .run('online', now(), instance.id);
    this.logger.info?.(`[control] ${instance.name} connected`);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        this.onMessage(connection, JSON.parse(data.toString()));
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.on('close', () => {
      if (this.connections.get(instance.id) !== connection) return;
      this.connections.delete(instance.id);
      this.logger.info?.(`[control] ${instance.name} disconnected`);
    });
    ws.on('error', () => {
      if (this.connections.get(instance.id) !== connection) return;
      this.connections.delete(instance.id);
    });

    this.send(connection, {
      type: 'hello',
      protocol: 1,
      instanceId: instance.id,
      serverTime: now(),
      commands: [...COMMAND_KINDS],
    });
    this.deliverQueued(instance.id);
  }

  send(connection, payload) {
    if (!connection || connection.ws.readyState !== 1) return false;
    try {
      connection.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  onMessage(connection, message) {
    if (!message || typeof message.type !== 'string') return;
    connection.lastSeenAt = now();
    switch (message.type) {
      case 'ready':
      case 'heartbeat':
        this.touchInstance(connection.instanceId, message);
        if (message.type === 'ready') {
          this.recordEvent(connection.instanceId, 'agent.ready', {
            version: message.version,
            capabilities: message.capabilities,
            web: message.web,
            workspaceRoot: message.workspaceRoot,
          });
          this.deliverQueued(connection.instanceId);
        }
        break;
      case 'event':
        this.recordEvent(connection.instanceId, String(message.kind || 'agent.event'), message.payload);
        break;
      case 'command.result':
        this.completeCommand(connection.instanceId, message);
        break;
      case 'notification.ack':
        this.recordEvent(connection.instanceId, 'notification.ack', { notificationId: message.id });
        break;
      default:
        break;
    }
  }

  touchInstance(instanceId, message) {
    const web = message.web || {};
    this.db
      .prepare(
        `UPDATE instances SET
          status = 'online', last_seen_at = ?,
          version = COALESCE(?, version),
          platform = COALESCE(?, platform),
          hostname = COALESCE(?, hostname),
          workspace_root = COALESCE(?, workspace_root),
          web_port = COALESCE(?, web_port),
          web_status = COALESCE(?, web_status),
          web_transport = COALESCE(?, web_transport),
          web_url = COALESCE(?, web_url),
          capabilities_json = COALESCE(?, capabilities_json),
          capability_summary = COALESCE(?, capability_summary)
         WHERE id = ?`,
      )
      .run(
        now(),
        message.version ? String(message.version).slice(0, 80) : null,
        message.platform ? String(message.platform).slice(0, 80) : null,
        message.hostname ? String(message.hostname).slice(0, 120) : null,
        message.workspaceRoot ? String(message.workspaceRoot).slice(0, 1024) : null,
        Number.isFinite(Number(web.port)) ? Number(web.port) : null,
        web.status ? String(web.status).slice(0, 20) : null,
        web.transport ? String(web.transport).slice(0, 20) : null,
        web.url ? String(web.url).slice(0, 2048) : null,
        Array.isArray(message.capabilities) ? JSON.stringify(message.capabilities.map(String).slice(0, 30)) : null,
        message.capabilitySummary ? String(message.capabilitySummary).slice(0, 2_000) : null,
        instanceId,
      );
  }

  sendCommand(instance, actorId, kind, payload = {}) {
    if (!COMMAND_KINDS.has(kind)) {
      const error = new Error(`不支持的命令：${kind}`);
      error.status = 400;
      error.code = 'unsupported_command';
      throw error;
    }
    const commandId = id('cmd');
    const createdAt = now();
    this.db
      .prepare(
        `INSERT INTO instance_commands
          (id, instance_id, actor_id, kind, payload_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(commandId, instance.id, actorId || null, kind, safeJson(payload), createdAt);
    const connection = this.connections.get(instance.id);
    const sent = this.deliverCommand(connection, {
      id: commandId,
      instance_id: instance.id,
      kind,
      payload_json: safeJson(payload),
      status: 'queued',
      created_at: createdAt,
    });
    return commandView(
      this.db.prepare('SELECT * FROM instance_commands WHERE id = ?').get(commandId),
    ) || { id: commandId, kind, status: sent ? 'sent' : 'queued', payload };
  }

  deliverCommand(connection, row) {
    if (!connection) return false;
    const sent = this.send(connection, {
      type: 'command',
      id: row.id,
      kind: row.kind,
      payload: parseJson(row.payload_json, {}),
      issuedAt: now(),
    });
    if (sent) {
      this.db
        .prepare("UPDATE instance_commands SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'queued'")
        .run(now(), row.id);
      return true;
    }
    return false;
  }

  deliverQueued(instanceId) {
    const connection = this.connections.get(instanceId);
    if (!connection) return;
    const rows = this.db
      .prepare("SELECT * FROM instance_commands WHERE instance_id = ? AND status = 'queued' ORDER BY created_at LIMIT 20")
      .all(instanceId);
    for (const row of rows) this.deliverCommand(connection, row);
  }

  completeCommand(instanceId, message) {
    const row = this.db
      .prepare('SELECT * FROM instance_commands WHERE id = ? AND instance_id = ?')
      .get(message.id, instanceId);
    if (!row) return;
    const status = message.ok ? 'done' : 'failed';
    this.db
      .prepare(
        "UPDATE instance_commands SET status = ?, result_json = ?, error = ?, completed_at = ? WHERE id = ?",
      )
      .run(
        status,
        safeJson(message.result ?? null),
        message.error ? String(message.error).slice(0, 2000) : null,
        now(),
        message.id,
      );
    this.recordEvent(instanceId, `command.${status}`, {
      commandId: message.id,
      kind: row.kind,
      result: message.result ?? null,
      error: message.error || null,
    });
  }

  recordEvent(instanceId, kind, payload) {
    const eventId = id('evt');
    const createdAt = now();
    this.db
      .prepare(
        'INSERT INTO instance_events (id, instance_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(eventId, instanceId, String(kind).slice(0, 80), safeJson(payload), createdAt);
    return { id: eventId, instanceId, kind, payload, createdAt };
  }

  events(instanceId, limit = 60) {
    return this.db
      .prepare('SELECT * FROM instance_events WHERE instance_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(instanceId, Math.max(1, Math.min(200, Number(limit) || 60)))
      .map(eventView);
  }

  commands(instanceId, limit = 20) {
    return this.db
      .prepare('SELECT * FROM instance_commands WHERE instance_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(instanceId, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map(commandView);
  }

  status(instanceId) {
    return {
      connected: this.connections.has(instanceId),
      connectedAt: this.connections.get(instanceId)?.connectedAt || null,
    };
  }

  isOnline(instanceId) {
    return this.connections.has(instanceId);
  }

  close() {
    for (const connection of [...this.connections.values()]) {
      try {
        connection.ws.close(1001, 'server shutdown');
      } catch {
        /* noop */
      }
    }
  }
}
