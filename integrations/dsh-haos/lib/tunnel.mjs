/**
 * 插件内嵌的 WEB Tunnel（in-process）。
 * 复用 Haos 控制通道的实例令牌，把 Haos 的 /w/:instanceId/ HTTP/WS 流
 * 转发到当前 DSH web server（loopback）。
 */
import http from 'node:http';
import { WebSocket } from 'ws';

const MAX_FRAME = 256 * 1024;

export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  capture(response) {
    for (const value of response.headers.getSetCookie?.() || []) {
      const pair = String(value).split(';')[0];
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const cookieValue = pair.slice(index + 1).trim();
      if (!cookieValue) this.cookies.delete(name);
      else this.cookies.set(name, cookieValue);
    }
  }
  header() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

function encodeData(streamId, chunk, text = false) {
  const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame.writeUInt32BE(streamId, 0);
  frame[4] = text ? 1 : 0;
  payload.copy(frame, 5);
  return frame;
}

export class CurrentWeb {
  constructor({ instanceId, origin, authUrl, logger = console }) {
    this.instanceId = instanceId;
    this.origin = origin;
    this.authUrl = authUrl;
    this.logger = logger;
    this.port = Number(new URL(origin).port || 80);
    this.status = 'pending';
    this.jar = new CookieJar();
    this.token = null;
    this.onEvent = null;
  }

  get publicPath() {
    return `/w/${this.instanceId}/`;
  }

  state() {
    return { status: this.status, port: this.port, path: this.publicPath, transport: 'tunnel' };
  }

  localUrlFor(pathname, search = '') {
    return `http://127.0.0.1:${this.port}${pathname}${search}`;
  }

  async connect() {
    if (!this.authUrl) throw new Error('缺少 connection.authenticatedUrl');
    const auth = new URL(this.authUrl);
    this.token = auth.searchParams.get('token');
    const local = new URL(auth);
    local.protocol = 'http:';
    local.hostname = '127.0.0.1';
    local.port = String(this.port);
    local.pathname = '/';
    const response = await fetch(local, { redirect: 'manual', headers: { accept: 'text/html' } });
    this.jar.capture(response);
    const location = response.headers.get('location');
    if (location && response.status >= 300 && response.status < 400) {
      const next = new URL(location, local);
      next.protocol = 'http:';
      next.hostname = '127.0.0.1';
      next.port = String(this.port);
      const second = await fetch(next, {
        redirect: 'manual',
        headers: { accept: 'text/html', cookie: this.jar.header() },
      });
      this.jar.capture(second);
      if (second.status >= 400) throw new Error(`WEB 认证跳转 HTTP ${second.status}`);
    } else if (response.status >= 400) {
      throw new Error(`WEB 认证 HTTP ${response.status}`);
    }
    const verify = await fetch(this.localUrlFor('/'), {
      redirect: 'manual',
      headers: { accept: 'text/html', cookie: this.jar.header() },
    });
    if (verify.status >= 400) throw new Error(`WEB 认证后页面 HTTP ${verify.status}`);
    this.status = 'ready';
    this.logger.info?.(`[dsh-haos] 当前 WEB 已认证：${this.origin}`);
    this.onEvent?.({ kind: 'web.ready', payload: { port: this.port, status: 'ready' } });
  }

  cookieHeader(incoming) {
    const jar = this.jar.header();
    const filtered = String(incoming || '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part && !part.startsWith('haos_session='))
      .join('; ');
    return [jar, filtered].filter(Boolean).join('; ');
  }
}

class Stream {
  constructor(tunnel, id, kind, meta) {
    this.tunnel = tunnel;
    this.id = id;
    this.kind = kind;
    this.meta = meta;
    this.closed = false;
    this.upstream = null;
    this.upstreamWs = null;
    this.buffer = [];
    this.requestEnded = false;
  }

  write(chunk, text = false) {
    if (this.closed) return;
    this.tunnel.sendData(this.id, chunk, text, this.kind !== 'ws');
  }

  sendControl(payload) {
    this.tunnel.send({ ...payload, streamId: this.id });
  }

  fail(error, code = 'upstream_error') {
    if (this.closed) return;
    this.closed = true;
    this.tunnel.send({ type: 'stream.error', streamId: this.id, code, message: error?.message || String(error) });
    this.destroyUpstream();
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    this.tunnel.send({ type: 'stream.close', streamId: this.id, code, reason });
    this.destroyUpstream();
  }

  destroyUpstream() {
    try {
      this.upstream?.destroy();
    } catch {
      /* noop */
    }
    try {
      this.upstreamWs?.close();
    } catch {
      /* noop */
    }
    this.upstream = null;
    this.upstreamWs = null;
  }

  startHttp() {
    const headers = { ...(this.meta.headers || {}) };
    delete headers['sec-websocket-key'];
    delete headers['sec-websocket-version'];
    delete headers['sec-websocket-extensions'];
    delete headers.upgrade;
    delete headers.connection;
    delete headers['keep-alive'];
    delete headers['proxy-connection'];
    const cookie = this.tunnel.web.cookieHeader(headers.cookie);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    headers['x-forwarded-host'] = headers.host || '';
    const localOrigin = `http://127.0.0.1:${this.tunnel.web.port}`;
    if (headers.referer) headers.referer = localOrigin + '/';
    if (headers.origin) headers.origin = localOrigin;
    headers.host = `127.0.0.1:${this.tunnel.web.port}`;
    headers['x-haos-instance'] = this.tunnel.instanceId;

    const req = http.request(
      {
        host: '127.0.0.1',
        port: this.tunnel.web.port,
        method: this.meta.method || 'GET',
        path: this.meta.path || '/',
        headers,
      },
      (res) => {
        if (this.closed) {
          res.destroy();
          return;
        }
        const responseHeaders = { ...res.headers };
        delete responseHeaders.connection;
        delete responseHeaders['keep-alive'];
        delete responseHeaders['transfer-encoding'];
        this.sendControl({ type: 'stream.headers', status: res.statusCode || 200, headers: responseHeaders });
        res.on('data', (chunk) => this.write(chunk));
        res.on('end', () => {
          if (this.closed) return;
          this.closed = true;
          this.tunnel.send({ type: 'stream.end', streamId: this.id });
        });
        res.on('error', (error) => {
          this.tunnel.logger.warn?.(`[dsh-haos] WEB response error ${this.meta.path}: ${error.message}`);
          this.fail(error, 'upstream_response_error');
        });
      },
    );
    this.upstream = req;
    req.on('error', (error) => {
      const code = error.code === 'ECONNREFUSED' ? 'web_unreachable' : 'upstream_error';
      this.tunnel.logger.warn?.(`[dsh-haos] WEB upstream error ${this.meta.method} ${this.meta.path}: ${error.code || ''} ${error.message}`);
      this.fail(error, code);
    });
    for (const chunk of this.buffer.splice(0)) req.write(chunk);
    if (this.requestEnded) req.end();
  }

  startWebSocket() {
    const headers = { ...(this.meta.headers || {}) };
    const cookie = this.tunnel.web.cookieHeader(headers.cookie);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    delete headers['sec-websocket-key'];
    delete headers['sec-websocket-version'];
    delete headers['sec-websocket-extensions'];
    delete headers.connection;
    delete headers.upgrade;
    delete headers.origin;
    delete headers.host;
    headers['x-haos-instance'] = this.tunnel.instanceId;
    const url = `ws://127.0.0.1:${this.tunnel.web.port}${this.meta.path || '/'}`;
    const ws = new WebSocket(url, {
      headers,
      origin: `http://127.0.0.1:${this.tunnel.web.port}`,
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
      maxPayload: 64 * 1024 * 1024,
    });
    this.upstreamWs = ws;
    ws.on('open', () => {
      if (this.closed) return;
      this.sendControl({ type: 'stream.opened', headers: {} });
    });
    ws.on('message', (data, isBinary) => this.write(Buffer.from(data), !isBinary));
    ws.on('close', (code, reason) => {
      if (this.closed) return;
      this.closed = true;
      this.tunnel.send({ type: 'stream.close', streamId: this.id, code, reason: reason?.toString?.() || '' });
    });
    ws.on('error', (error) => {
      this.tunnel.logger.warn?.(`[dsh-haos] WEB ws error ${this.meta.path}: ${error.message}`);
      this.fail(error, error.code === 'ECONNREFUSED' ? 'web_unreachable' : 'upstream_ws_error');
    });
  }

  onData(chunk, text) {
    if (this.closed) return;
    if (this.kind === 'ws') {
      if (this.upstreamWs?.readyState === WebSocket.OPEN) this.upstreamWs.send(chunk, { binary: !text });
      else this.buffer.push(chunk);
      return;
    }
    if (!this.upstream) this.buffer.push(chunk);
    else this.upstream.write(chunk);
  }

  onRequestEnd() {
    this.requestEnded = true;
    if (this.kind === 'http' && this.upstream) this.upstream.end();
  }

  onCloseFromServer(code, reason) {
    if (this.kind === 'ws' && this.upstreamWs?.readyState === WebSocket.OPEN) {
      try {
        this.upstreamWs.close(code || 1000, reason || '');
      } catch {
        /* noop */
      }
    } else {
      this.destroyUpstream();
    }
    this.closed = true;
  }
}

export class TunnelClient {
  constructor({ baseUrl, instanceId, instanceToken, web, logger = console }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.instanceId = instanceId;
    this.instanceToken = instanceToken;
    this.web = web;
    this.logger = logger;
    this.ws = null;
    this.connected = false;
    this.streams = new Map();
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.stopped = false;
  }

  url() {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/api/plugin/v1/tunnel';
    url.search = '';
    return url.toString();
  }

  start() {
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    const ws = new WebSocket(this.url(), {
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
      this.logger.info?.('[dsh-haos] WEB Tunnel 已连接');
      this.send({ type: 'hello', v: 1, instanceId: this.instanceId, maxStreams: 64 });
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) this.onBinary(Buffer.from(data));
      else this.onControl(data.toString());
    });
    ws.on('close', (code) => {
      this.connected = false;
      this.ws = null;
      for (const stream of [...this.streams.values()]) stream.fail(new Error('Tunnel 已断开'), 'tunnel_closed');
      this.streams.clear();
      if (this.stopped) return;
      this.logger.warn?.(`[dsh-haos] WEB Tunnel 断开（${code}），${this.reconnectDelay}ms 后重连`);
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.start(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    });
    ws.on('error', (error) => this.logger.warn?.(`[dsh-haos] WEB Tunnel 错误：${error.message}`));
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

  sendData(streamId, chunk, text = false, fragment = true) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
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

  onControl(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'hello' || message.type === 'pong') return;
    if (message.type === 'stream.open') {
      const stream = new Stream(this, message.streamId, message.kind, {
        method: message.method,
        path: message.path,
        headers: message.headers || {},
      });
      this.streams.set(message.streamId, stream);
      if (message.kind === 'ws') stream.startWebSocket();
      else stream.startHttp();
      return;
    }
    const stream = this.streams.get(message.streamId);
    if (!stream) return;
    if (message.type === 'stream.request_end') stream.onRequestEnd();
    else if (message.type === 'stream.close' || message.type === 'stream.reset') {
      stream.onCloseFromServer(Number(message.code) || 1000, message.reason || '');
      this.streams.delete(stream.id);
    }
  }

  onBinary(buf) {
    if (buf.length < 5) return;
    const streamId = buf.readUInt32BE(0);
    const text = (buf[4] & 1) === 1;
    const stream = this.streams.get(streamId);
    if (!stream) return;
    stream.onData(buf.subarray(5), text);
  }

  reconnect() {
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close(4002, 'manual reconnect');
    } catch {
      /* noop */
    }
    this.ws = null;
    setTimeout(() => this.start(), 200);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close(1001, 'plugin shutdown');
    } catch {
      /* noop */
    }
    for (const stream of [...this.streams.values()]) stream.close(1001, 'shutdown');
    this.streams.clear();
    this.ws = null;
    this.connected = false;
  }
}
