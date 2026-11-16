import { WebSocketServer } from 'ws';
import { bearer, instanceByToken } from './auth.mjs';
import { now } from './db.mjs';

const TUNNEL_PATH = '/api/plugin/v1/tunnel';
const MAX_STREAMS = 64;
const OPEN_TIMEOUT_MS = 30_000;
const MAX_FRAME = 256 * 1024;

function encodeData(streamId, chunk, text = false) {
  const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame.writeUInt32BE(streamId, 0);
  frame[4] = text ? 1 : 0;
  payload.copy(frame, 5);
  return frame;
}

export class TunnelStream {
  constructor(connection, streamId, kind, meta) {
    this.connection = connection;
    this.streamId = streamId;
    this.kind = kind;
    this.meta = meta;
    this.closed = false;
    this.onHeaders = null;
    this.onOpened = null;
    this.onData = null;
    this.onEnd = null;
    this.onClose = null;
    this.onError = null;
    this.timer = setTimeout(() => {
      this._error(new Error('上游响应超时'));
      this.connection.sendControl({ type: 'stream.reset', streamId: this.streamId, reason: 'timeout' });
      this.cleanup();
    }, OPEN_TIMEOUT_MS);
    this.timer.unref?.();
  }

  write(chunk, text = false) {
    if (this.closed) return;
    // WebSocket messages are protocol frames; never split them. HTTP bodies may
    // be chunked across tunnel frames.
    this.connection.sendData(this.streamId, chunk, text, this.kind !== 'ws');
  }

  endRequest() {
    if (this.closed) return;
    this.connection.sendControl({ type: 'stream.request_end', streamId: this.streamId });
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.connection.sendControl({ type: 'stream.close', streamId: this.streamId, code, reason });
    this.cleanup();
  }

  reset(reason = 'client_abort') {
    if (this.closed) return;
    this.connection.sendControl({ type: 'stream.reset', streamId: this.streamId, reason });
    this.cleanup();
  }

  _receiveHeaders(status, headers) {
    clearTimeout(this.timer);
    this.onHeaders?.(status, headers || {});
  }

  _receiveOpened(headers) {
    clearTimeout(this.timer);
    this.onOpened?.(headers || {});
  }

  _receiveData(chunk, text) {
    if (this.closed) return;
    this.onData?.(chunk, Boolean(text));
  }

  _receiveEnd() {
    if (this.closed) return;
    this.onEnd?.();
    this.cleanup();
  }

  _receiveClose(code, reason) {
    if (this.closed) return;
    this.onClose?.(code, reason);
    this.cleanup();
  }

  _error(error) {
    if (this.closed) return;
    try {
      this.onError?.(error);
    } finally {
      this.cleanup();
    }
  }

  cleanup() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.connection.streams.delete(this.streamId);
  }
}

class TunnelConnection {
  constructor(hub, instance, ws) {
    this.hub = hub;
    this.instance = instance;
    this.ws = ws;
    this.streams = new Map();
    this.nextStreamId = 1;
    this.closed = false;
    this.lastPong = Date.now();
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== 1) return;
      try {
        ws.ping();
      } catch {
        /* noop */
      }
    }, 30_000);
    this.pingTimer.unref?.();

    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    ws.on('close', () => this.dispose('closed'));
    ws.on('error', () => this.dispose('error'));
    ws.on('pong', () => {
      this.lastPong = Date.now();
    });
    this.sendControl({
      type: 'hello',
      instanceId: instance.id,
      serverTime: now(),
      maxStreams: MAX_STREAMS,
      protocol: 1,
    });
  }

  get open() {
    return !this.closed && this.ws.readyState === 1;
  }

  sendControl(payload) {
    if (!this.open) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  sendData(streamId, chunk, text = false, fragment = true) {
    if (!this.open) return false;
    const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!fragment) {
      try {
        this.ws.send(encodeData(streamId, payload, text), { binary: true });
        return true;
      } catch {
        return false;
      }
    }
    for (let offset = 0; offset < payload.length; offset += MAX_FRAME) {
      const slice = payload.subarray(offset, Math.min(payload.length, offset + MAX_FRAME));
      try {
        this.ws.send(encodeData(streamId, slice, text), { binary: true });
      } catch {
        return false;
      }
    }
    return true;
  }

  openStream(kind, meta) {
    if (!this.open) {
      const error = new Error('实例 Tunnel 未连接');
      error.code = 'tunnel_offline';
      throw error;
    }
    if (this.streams.size >= MAX_STREAMS) {
      const error = new Error('实例并发流已达上限');
      error.code = 'stream_limit';
      throw error;
    }
    const streamId = this.nextStreamId++;
    if (this.nextStreamId > 0xffffffff) this.nextStreamId = 1;
    const stream = new TunnelStream(this, streamId, kind, meta);
    this.streams.set(streamId, stream);
    this.sendControl({
      type: 'stream.open',
      streamId,
      kind,
      method: meta.method || 'GET',
      path: meta.path || '/',
      headers: meta.headers || {},
      upgrade: kind === 'ws',
    });
    return stream;
  }

  onMessage(data, isBinary) {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length < 5) return;
      const streamId = buf.readUInt32BE(0);
      const text = (buf[4] & 1) === 1;
      const stream = this.streams.get(streamId);
      if (!stream) return;
      stream._receiveData(buf.subarray(5), text);
      return;
    }
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'hello' || message.type === 'pong') return;
    const stream = this.streams.get(message.streamId);
    if (!stream) return;
    switch (message.type) {
      case 'stream.headers':
        stream._receiveHeaders(Number(message.status) || 200, message.headers);
        break;
      case 'stream.opened':
        stream._receiveOpened(message.headers);
        break;
      case 'stream.end':
        stream._receiveEnd();
        break;
      case 'stream.close':
        stream._receiveClose(Number(message.code) || 1000, message.reason || '');
        break;
      case 'stream.error':
        stream._error(Object.assign(new Error(message.message || '上游错误'), { code: message.code }));
        break;
      default:
        break;
    }
  }

  dispose(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    for (const stream of [...this.streams.values()]) {
      stream._error(new Error(`Tunnel ${reason}`));
    }
    this.streams.clear();
    this.hub.connections.delete(this.instance.id);
  }
}

export class TunnelHub {
  constructor({ db, logger = console }) {
    this.db = db;
    this.logger = logger;
    this.connections = new Map();
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    this.pingTimer = setInterval(() => {
      for (const conn of [...this.connections.values()]) {
        if (Date.now() - conn.lastPong > 120_000) {
          try {
            conn.ws.terminate();
          } catch {
            /* noop */
          }
        }
      }
    }, 30_000);
    this.pingTimer.unref?.();
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== TUNNEL_PATH) return false;
    const rawToken = bearer(req) || url.searchParams.get('token');
    const instance = instanceByToken(this.db, rawToken);
    if (!instance) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const old = this.connections.get(instance.id);
      if (old) {
        try {
          old.ws.close(4001, 'replaced');
        } catch {
          /* noop */
        }
      }
      const connection = new TunnelConnection(this, instance, ws);
      this.connections.set(instance.id, connection);
      this.db
        .prepare('UPDATE instances SET status = ?, last_seen_at = ? WHERE id = ?')
        .run('online', now(), instance.id);
      this.logger.info?.(`[tunnel] ${instance.name} connected`);
      ws.on('close', () => {
        if (this.connections.get(instance.id) === connection) {
          this.connections.delete(instance.id);
          this.db
            .prepare('UPDATE instances SET status = ?, last_seen_at = ? WHERE id = ? AND status != ?')
            .run('disconnected', now(), instance.id, 'revoked');
          this.logger.info?.(`[tunnel] ${instance.name} disconnected`);
        }
      });
    });
    return true;
  }

  openStream(instanceId, kind, meta) {
    const connection = this.connections.get(instanceId);
    if (!connection) {
      const error = new Error('Tunnel 未连接');
      error.code = 'tunnel_offline';
      throw error;
    }
    return connection.openStream(kind, meta);
  }

  isOnline(instanceId) {
    return this.connections.has(instanceId);
  }

  close() {
    clearInterval(this.pingTimer);
    for (const connection of [...this.connections.values()]) {
      try {
        connection.ws.close(1001, 'server shutdown');
      } catch {
        /* noop */
      }
    }
  }
}
