import { WebSocketServer } from 'ws';
import { COOKIE_NAME } from './config.mjs';
import { canUseInstance, sessionUser } from './auth.mjs';
import { parseCookies, sendError } from './http.mjs';
import { now } from './db.mjs';
import { id } from './lib/ids.mjs';

const PREFIX = /^\/w\/([^/]+)(\/.*)?$/;

function routeFor(pathname) {
  const match = PREFIX.exec(pathname);
  if (!match) return null;
  return { instanceId: match[1], path: match[2] || '/' };
}

function stripHaosCookie(cookie) {
  if (!cookie) return '';
  return String(cookie)
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${COOKIE_NAME}=`))
    .join('; ');
}

function rewriteLocation(location, instanceId) {
  if (!location) return location;
  if (location.startsWith(`/w/${instanceId}`)) return location;
  if (location.startsWith('/')) return `/w/${instanceId}${location}`;
  return location;
}

function rewriteSetCookie(value, instanceId) {
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter(Boolean)
    .map((cookie) => {
      const parts = String(cookie).split(';').map((part) => part.trim());
      const kept = [];
      let hasPath = false;
      for (const part of parts) {
        if (!part) continue;
        if (/^domain=/i.test(part)) continue;
        if (/^path=/i.test(part)) {
          kept.push(`Path=/w/${instanceId}/`);
          hasPath = true;
        } else {
          kept.push(part);
        }
      }
      if (!hasPath) kept.push(`Path=/w/${instanceId}/`);
      return kept.join('; ');
    });
}

export class WebGateway {
  constructor({ db, hub, logger = console }) {
    this.db = db;
    this.hub = hub;
    this.logger = logger;
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, clientTracking: false });
  }

  instanceFor(pathname) {
    const route = routeFor(pathname);
    if (!route) return null;
    const instance = this.db.prepare('SELECT * FROM instances WHERE id = ?').get(route.instanceId);
    if (!instance || instance.revoked_at) return null;
    return { route, instance };
  }

  touchSession(instanceId, userId, userAgent) {
    const existing = this.db
      .prepare(
        'SELECT id FROM web_sessions WHERE instance_id = ? AND user_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1',
      )
      .get(instanceId, userId);
    const timestamp = now();
    if (existing) {
      this.db.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE id = ?').run(timestamp, existing.id);
      return;
    }
    this.db
      .prepare(
        'INSERT INTO web_sessions (id, instance_id, user_id, opened_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id('web'), instanceId, userId, timestamp, timestamp, userAgent || null);
  }

  async handleHttp(req, res, url) {
    const found = this.instanceFor(url.pathname);
    if (!found) return false;
    const { route, instance } = found;
    const user = sessionUser(req, this.db);
    if (!user) {
      sendError(res, 401, 'unauthorized', '请先登录 Haos');
      return true;
    }
    if (!canUseInstance(this.db, user, instance)) {
      sendError(res, 403, 'forbidden', '无权访问该实例');
      return true;
    }
    if (!this.hub.isOnline(instance.id)) {
      sendError(res, 503, 'tunnel_offline', '实例 Tunnel 未连接，请确认 DSH 侧 Haos Agent 正在运行');
      return true;
    }

    this.touchSession(instance.id, user.id, req.headers['user-agent']);
    const upstreamPath = `${route.path}${url.search || ''}`;
    const headers = { ...req.headers };
    delete headers.connection;
    delete headers['keep-alive'];
    delete headers['proxy-connection'];
    delete headers['transfer-encoding'];
    delete headers.upgrade;
    headers['x-forwarded-host'] = req.headers.host || '';
    headers['x-forwarded-proto'] = url.protocol.replace(':', '');
    headers['x-forwarded-for'] = req.socket?.remoteAddress || '';
    headers.cookie = stripHaosCookie(req.headers.cookie);

    let stream;
    try {
      stream = this.hub.openStream(instance.id, 'http', {
        method: req.method,
        path: upstreamPath,
        headers,
      });
    } catch (error) {
      sendError(res, error.code === 'stream_limit' ? 429 : 503, error.code || 'tunnel_error', error.message);
      return true;
    }

    let headersSent = false;
    let ended = false;
    stream.onHeaders = (status, responseHeaders) => {
      if (ended) return;
      headersSent = true;
      const headersOut = { ...responseHeaders };
      delete headersOut.connection;
      delete headersOut['keep-alive'];
      delete headersOut['transfer-encoding'];
      delete headersOut['x-frame-options'];
      if (headersOut.location) headersOut.location = rewriteLocation(headersOut.location, instance.id);
      if (headersOut['set-cookie']) {
        headersOut['set-cookie'] = rewriteSetCookie(headersOut['set-cookie'], instance.id);
      }
      try {
        res.writeHead(Number(status) || 200, headersOut);
      } catch (error) {
        this.logger.warn?.('[gateway] writeHead failed', error.message);
        ended = true;
        res.destroy();
      }
    };
    stream.onData = (chunk) => {
      if (ended) return;
      if (headersSent && !res.writableEnded) res.write(chunk);
    };
    stream.onEnd = () => {
      if (ended) return;
      ended = true;
      if (!res.writableEnded) res.end();
    };
    stream.onClose = () => {
      if (ended) return;
      ended = true;
      if (!res.writableEnded) res.end();
    };
    stream.onError = (error) => {
      if (ended) return;
      ended = true;
      this.logger.warn?.(`[gateway] ${instance.name} ${req.method} ${upstreamPath}: ${error.message}`);
      if (!headersSent) {
        sendError(res, 502, error.code || 'tunnel_error', error.message || '上游 WEB 不可用');
      } else if (!res.writableEnded) {
        res.destroy();
      }
    };

    req.on('data', (chunk) => {
      if (!ended) stream.write(chunk);
    });
    req.on('end', () => {
      if (!ended) stream.endRequest();
    });
    req.on('error', () => stream.reset('request_error'));
    res.on('close', () => {
      if (!ended) {
        ended = true;
        stream.reset('client_abort');
      }
    });
    return true;
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url || '/', 'http://localhost');
    const found = this.instanceFor(url.pathname);
    if (!found) return false;
    const { route, instance } = found;
    const user = sessionUser(req, this.db);
    if (!user || !canUseInstance(this.db, user, instance)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }
    if (!this.hub.isOnline(instance.id)) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }

    this.touchSession(instance.id, user.id, req.headers['user-agent']);
    const headers = { ...req.headers };
    delete headers.connection;
    delete headers['keep-alive'];
    delete headers['proxy-connection'];
    delete headers.upgrade;
    delete headers['sec-websocket-key'];
    delete headers['sec-websocket-version'];
    delete headers['sec-websocket-extensions'];
    headers.cookie = stripHaosCookie(req.headers.cookie);

    let stream;
    try {
      stream = this.hub.openStream(instance.id, 'ws', {
        method: 'GET',
        path: `${route.path}${url.search || ''}`,
        headers,
      });
    } catch (error) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }

    let accepted = false;
    let closed = false;
    const fail = (status = 502, message = 'Bad Gateway') => {
      if (closed) return;
      closed = true;
      try {
        if (!accepted) socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
      } catch {
        /* noop */
      }
      socket.destroy();
      stream.reset('upgrade_failed');
    };

    stream.onOpened = () => {
      if (accepted) return;
      accepted = true;
      this.wss.handleUpgrade(req, socket, head, (client) => {
        client.on('message', (data, isBinary) => {
          if (!closed) stream.write(Buffer.from(data), !isBinary);
        });
        client.on('close', (code, reason) => {
          if (closed) return;
          closed = true;
          stream.close(code, reason?.toString?.() || '');
        });
        client.on('error', () => fail(502, 'Client Error'));
        stream.onData = (chunk, text) => {
          if (closed) return;
          try {
            client.send(chunk, { binary: !text });
          } catch {
            fail(502, 'Client Closed');
          }
        };
        stream.onClose = (code, reason) => {
          if (closed) return;
          closed = true;
          try {
            client.close(Number(code) || 1000, reason || '');
          } catch {
            /* noop */
          }
        };
      });
    };
    stream.onError = () => fail(502, 'Bad Gateway');
    stream.onEnd = () => fail(502, 'Upstream Ended');
    socket.on('error', () => stream.reset('socket_error'));
    return true;
  }
}
