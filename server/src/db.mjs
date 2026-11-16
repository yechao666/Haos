import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from './lib/crypto.mjs';
import { id } from './lib/ids.mjs';
import { DATA_DIR, DB_PATH, DEMO_PASSWORD } from './config.mjs';

export function openDb() {
  const db = new DatabaseSync(DB_PATH);
  return migrate(db);
}

/** 应用 schema；openDb 与内存测试共用。 */
export function migrate(db) {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL,
      PRIMARY KEY (team_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS enrollment_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'personal',
      team_id TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'personal',
      team_id TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'personal',
      team_id TEXT,
      status TEXT NOT NULL DEFAULT 'offline',
      version TEXT,
      platform TEXT,
      hostname TEXT,
      host_ip TEXT,
      process_user TEXT,
      process_pid INTEGER,
      process_started_at TEXT,
      profile TEXT,
      dsh_home TEXT,
      client_instance_id TEXT,
      client_name TEXT,
      name_override TEXT,
      workspace_root TEXT,
      web_port INTEGER,
      web_status TEXT NOT NULL DEFAULT 'pending',
      web_transport TEXT NOT NULL DEFAULT 'tunnel',
      web_url TEXT,
      capabilities_json TEXT,
      capability_summary TEXT,
      org_id TEXT,
      org_parent_id TEXT,
      org_role TEXT,
      org_depth INTEGER,
      mode TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS instance_tokens (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS instance_events (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS instance_commands (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      actor_id TEXT,
      kind TEXT NOT NULL,
      payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      result_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS web_sessions (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      closed_at TEXT,
      user_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS orgs (
      id TEXT PRIMARY KEY,
      team_id TEXT,
      owner_id TEXT,
      name TEXT NOT NULL,
      root_instance_id TEXT,
      max_depth INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS relay_tasks (
      id TEXT PRIMARY KEY,
      org_id TEXT,
      caller_instance_id TEXT NOT NULL,
      target_instance_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      prompt TEXT NOT NULL,
      context TEXT,
      cwd TEXT,
      title TEXT,
      chain_json TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      meta_json TEXT,
      ip TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_hash ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_instances_owner ON instances(owner_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_instance_tokens_instance ON instance_tokens(instance_id);
    CREATE INDEX IF NOT EXISTS idx_web_sessions_instance ON web_sessions(instance_id, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_instance_events ON instance_events(instance_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_instance_commands ON instance_commands(instance_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
  `);
  const instanceColumns = db.prepare('PRAGMA table_info(instances)').all();
  if (!instanceColumns.some((column) => column.name === 'capabilities_json')) {
    db.exec('ALTER TABLE instances ADD COLUMN capabilities_json TEXT;');
  }
  if (!instanceColumns.some((column) => column.name === 'capability_summary')) {
    db.exec('ALTER TABLE instances ADD COLUMN capability_summary TEXT;');
  }
  if (!instanceColumns.some((column) => column.name === 'mode')) {
    db.exec('ALTER TABLE instances ADD COLUMN mode TEXT;');
  }
  for (const [name, type] of [
    ['org_id', 'TEXT'],
    ['org_parent_id', 'TEXT'],
    ['org_role', 'TEXT'],
    ['org_depth', 'INTEGER'],
    ['host_ip', 'TEXT'],
    ['process_user', 'TEXT'],
    ['process_pid', 'INTEGER'],
    ['process_started_at', 'TEXT'],
    ['profile', 'TEXT'],
    ['dsh_home', 'TEXT'],
    ['client_instance_id', 'TEXT'],
    ['client_name', 'TEXT'],
    ['name_override', 'TEXT'],
  ]) {
    if (!instanceColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE instances ADD COLUMN ${name} ${type};`);
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_instances_client ON instances(owner_id, client_instance_id) WHERE client_instance_id IS NOT NULL;');
  db.exec('CREATE INDEX IF NOT EXISTS idx_instances_org ON instances(org_id, created_at);');
  const orgColumns = db.prepare('PRAGMA table_info(orgs)').all();
  if (!orgColumns.some((column) => column.name === 'owner_id')) db.exec('ALTER TABLE orgs ADD COLUMN owner_id TEXT;');
  db.exec('CREATE INDEX IF NOT EXISTS idx_relay_target ON relay_tasks(target_instance_id, status, created_at);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_relay_caller ON relay_tasks(caller_instance_id, created_at);');
  return db;
}

export function now() {
  return new Date().toISOString();
}

export function ensureSeed(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return false;

  const teamId = id('tm');
  const adminId = id('usr');
  const memberId = id('usr');
  const createdAt = now();
  const insertUser = db.prepare(
    'INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertUser.run(adminId, 'admin@haos.local', '管理员', hashPassword(DEMO_PASSWORD), 1, createdAt);
  insertUser.run(memberId, 'member@haos.local', '林薇', hashPassword(DEMO_PASSWORD), 0, createdAt);

  db.prepare('INSERT INTO teams (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(
    teamId,
    '默认团队',
    'default',
    createdAt,
  );
  const insertMember = db.prepare(
    'INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
  );
  insertMember.run(teamId, adminId, 'owner', createdAt);
  insertMember.run(teamId, memberId, 'member', createdAt);

  db.prepare(
    'INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, meta_json, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id('aud'), adminId, 'system.seeded', 'system', null, JSON.stringify({ demo: true }), null, createdAt);
  return true;
}

export function seedForce(db) {
  db.exec(`
    DELETE FROM web_sessions;
    DELETE FROM instance_tokens;
    DELETE FROM instances;
    DELETE FROM enrollment_keys;
    DELETE FROM sessions;
    DELETE FROM team_members;
    DELETE FROM teams;
    DELETE FROM users;
    DELETE FROM audit_logs;
  `);
  return ensureSeed(db);
}

export function teamIdFor(db, userId) {
  const row = db
    .prepare('SELECT team_id FROM team_members WHERE user_id = ? ORDER BY created_at LIMIT 1')
    .get(userId);
  return row?.team_id ?? null;
}

export function isTeamMember(db, userId, teamId) {
  if (!teamId) return false;
  return Boolean(db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId));
}

export function audit(db, actorId, action, targetType, targetId, meta, ip) {
  db.prepare(
    'INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, meta_json, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id('aud'), actorId ?? null, action, targetType ?? null, targetId ?? null, meta ? JSON.stringify(meta) : null, ip ?? null, now());
}

export { DATA_DIR };
