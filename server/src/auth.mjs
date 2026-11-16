import { COOKIE_NAME, PUBLIC_URL, SESSION_DAYS } from './config.mjs';
import { parseCookies, sendError } from './http.mjs';
import { sha256, verifyPassword } from './lib/crypto.mjs';
import { id, token } from './lib/ids.mjs';
import { now, isTeamMember } from './db.mjs';

const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isAdmin: Boolean(user.is_admin),
  };
}

export function createSession(db, userId) {
  const raw = token(32);
  const createdAt = now();
  const expiresAt = new Date(Date.now() + SESSION_MS).toISOString();
  db.prepare(
    'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id('sess'), userId, sha256(raw), expiresAt, createdAt);
  return { raw, expiresAt };
}

export function sessionUser(req, db) {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  const row = db
    .prepare(
      `SELECT u.*, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(raw), now());
  return row || null;
}

export function sessionCookie(raw, expiresAt) {
  const secure = PUBLIC_URL.startsWith('https://') ? '; Secure' : '';
  const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  return `${COOKIE_NAME}=${encodeURIComponent(raw)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function requireUser(req, res, db) {
  const user = sessionUser(req, db);
  if (!user) {
    sendError(res, 401, 'unauthorized', '请先登录');
    return null;
  }
  return user;
}

export function login(db, email, password) {
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(String(email || '').trim());
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  return user;
}

export function bearer(req) {
  const value = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1].trim() : null;
}

export function apiKeyByToken(db, raw) {
  if (!raw) return null;
  const row = db
    .prepare(
      `SELECT k.*, u.email AS owner_email, u.name AS owner_name
       FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.token_hash = ? AND k.revoked_at IS NULL`,
    )
    .get(sha256(raw));
  if (!row) return null;
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id);
  return row;
}

export function instanceByToken(db, raw) {
  if (!raw) return null;
  const row = db
    .prepare(
      `SELECT i.*, t.id AS token_id
       FROM instance_tokens t JOIN instances i ON i.id = t.instance_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL AND i.revoked_at IS NULL`,
    )
    .get(sha256(raw));
  if (!row) return null;
  db.prepare('UPDATE instance_tokens SET last_used_at = ? WHERE id = ?').run(now(), row.token_id);
  return row;
}

export function canUseInstance(db, user, instance) {
  if (!user || !instance || instance.revoked_at) return false;
  if (user.is_admin) return true;
  if (instance.owner_id === user.id) return true;
  if (instance.scope === 'public') return true;
  if (instance.scope === 'team') return isTeamMember(db, user.id, instance.team_id);
  return false;
}

export function canManageInstance(user, instance) {
  if (!user || !instance) return false;
  return Boolean(user.is_admin) || instance.owner_id === user.id;
}

export function canManageTeam(db, user, teamId) {
  if (!user || !teamId) return false;
  if (user.is_admin) return true;
  const row = db
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .get(teamId, user.id);
  return row?.role === 'owner' || row?.role === 'admin';
}

export function scopeLabel(scope) {
  return { personal: '个人', team: '团队', public: '公共' }[scope] || scope;
}
