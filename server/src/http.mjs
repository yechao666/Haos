import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { WEB_DIR } from './config.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function sendJson(res, status, data, headers = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendError(res, status, code, message, details) {
  sendJson(res, status, { error: { code, message, details } });
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413, code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON 解析失败'), { status: 400, code: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

export function serveStatic(req, res, pathname) {
  let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (relative.includes('\0')) return false;
  let file = resolve(join(WEB_DIR, normalize(relative)));
  if (!file.startsWith(resolve(WEB_DIR))) return false;
  if (!existsSync(file) || !statSync(file).isFile()) {
    if (pathname.startsWith('/api/') || pathname.startsWith('/w/')) return false;
    file = join(WEB_DIR, 'index.html');
    if (!existsSync(file)) return false;
  }
  const stat = statSync(file);
  const ext = extname(file).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': ['.html', '.js', '.css'].includes(ext) ? 'no-store' : 'public, max-age=300',
  });
  createReadStream(file).pipe(res);
  return true;
}

export function clientIp(req) {
  return req.socket?.remoteAddress || null;
}

export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.host === req.headers.host || url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  } catch {
    return false;
  }
}
