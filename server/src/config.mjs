import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// 轻量 .env 加载，避免额外依赖。
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

export const PORT = Number(process.env.HAOS_PORT || 4600);
export const HOST = process.env.HAOS_HOST || '127.0.0.1';
export const DATA_DIR = resolve(process.env.HAOS_DATA_DIR || join(ROOT, 'data'));
export const DB_PATH = join(DATA_DIR, 'haos.db');
export const WEB_DIR = join(ROOT, 'web');
export const PUBLIC_URL = (process.env.HAOS_PUBLIC_URL || `http://${HOST}:${PORT}`).replace(/\/+$/, '');
export const COOKIE_NAME = 'haos_session';
export const SESSION_DAYS = Number(process.env.HAOS_SESSION_DAYS || 14);
export const INSTANCE_OFFLINE_SECONDS = Number(process.env.HAOS_INSTANCE_OFFLINE_SECONDS || 90);
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
export const DEMO_PASSWORD = process.env.HAOS_DEMO_PASSWORD || 'haos-demo';
export const HOME = homedir();

mkdirSync(DATA_DIR, { recursive: true });
