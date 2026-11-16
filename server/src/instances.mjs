import { PUBLIC_URL } from './config.mjs';
import { sha256 } from './lib/crypto.mjs';
import { id, token } from './lib/ids.mjs';
import { audit, now, teamIdFor } from './db.mjs';
import { apiKeyByToken } from './auth.mjs';

const SCOPES = new Set(['personal', 'team', 'public']);
const WEB_STATUS = new Set(['pending', 'starting', 'ready', 'error', 'off']);

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function scopeLabel(scope) {
  return { personal: '个人', team: '团队', public: '公共' }[scope] || scope;
}

export function normalizeScope(value) {
  return SCOPES.has(value) ? value : 'personal';
}

function inferMode(inputMode, capabilities = []) {
  if (inputMode === 'in-process' || inputMode === 'sidecar') return inputMode;
  if (capabilities.includes('sessions') || capabilities.includes('events') || capabilities.includes('control')) {
    return 'in-process';
  }
  return 'sidecar';
}

/** Preferred installer: add the plugin to an existing DSH profile. */
export function pluginInstallCommand(key) {
  return `node scripts/install-dsh-plugin.mjs --profile desktop --base ${shellQuote(PUBLIC_URL)} --api-key ${shellQuote(key)} --workspace "$HOME/.haos/workspace"`;
}

/**
 * A server-owned display name. Clients may describe themselves, but never pick
 * the name shown in the Haos instance list.
 */
export function nextInstanceName(db) {
  const rows = db
    .prepare(
      `SELECT name FROM instances
       UNION ALL
       SELECT name FROM enrollment_keys`,
    )
    .all();
  let max = 0;
  for (const row of rows) {
    const match = /^dsh-(\d+)$/.exec(String(row.name || ''));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `dsh-${String(max + 1).padStart(4, '0')}`;
}

export function createEnrollment(db, user, input, options = {}) {
  // Naming is a server concern. Ignore input.name/instanceName from clients.
  const name = String(options.name || nextInstanceName(db)).trim().slice(0, 120);
  const scope = normalizeScope(input?.scope);
  let teamId = input?.teamId ? String(input.teamId) : null;
  if (scope === 'team') {
    if (!teamId) teamId = teamIdFor(db, user.id);
    if (!teamId) {
      const error = new Error('团队范围需要先加入一个团队');
      error.status = 400;
      error.code = 'team_required';
      throw error;
    }
    const member = db
      .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
      .get(teamId, user.id);
    if (!member && !user.is_admin) {
      const error = new Error('你不属于该团队');
      error.status = 403;
      error.code = 'forbidden';
      throw error;
    }
  } else {
    teamId = null;
  }
  const raw = `haos_enr_${token(24)}`;
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const keyId = id('enr');
  db.prepare(
    'INSERT INTO enrollment_keys (id, user_id, name, scope, team_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(keyId, user.id, name, scope, teamId, sha256(raw), expiresAt, now());
  audit(db, user.id, 'enrollment.created', 'enrollment', keyId, { name, scope, teamId });
  return {
    id: keyId,
    key: raw,
    name,
    scope,
    teamId,
    expiresAt,
    pluginInstallCommand: pluginInstallCommand(raw),
  };
}

export function createApiKey(db, user, input = {}) {
  const scope = normalizeScope(input.scope);
  let teamId = input.teamId ? String(input.teamId) : null;
  if (scope === 'team') {
    if (!teamId) teamId = teamIdFor(db, user.id);
    if (!teamId) {
      const error = new Error('团队范围需要先加入一个团队');
      error.status = 400;
      error.code = 'team_required';
      throw error;
    }
    const member = db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, user.id);
    if (!member && !user.is_admin) {
      const error = new Error('你不属于该团队');
      error.status = 403;
      error.code = 'forbidden';
      throw error;
    }
  } else {
    teamId = null;
  }
  const raw = `haos_api_${token(32)}`;
  const keyId = id('apk');
  const createdAt = now();
  const name = String(input.name || 'DSH 接入 API Key').trim().slice(0, 120);
  db.prepare(
    'INSERT INTO api_keys (id, user_id, name, scope, team_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(keyId, user.id, name, scope, teamId, sha256(raw), createdAt);
  audit(db, user.id, 'api_key.created', 'api_key', keyId, { name, scope, teamId });
  return { id: keyId, key: raw, name, scope, teamId, createdAt, pluginInstallCommand: pluginInstallCommand(raw) };
}

export function listApiKeys(db, user) {
  return db
    .prepare('SELECT id, name, scope, team_id, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC')
    .all(user.id)
    .map((row) => ({
      id: row.id,
      name: row.name,
      scope: row.scope,
      teamId: row.team_id,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    }));
}

export function revokeApiKey(db, user, keyId) {
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(keyId, user.id);
  if (!row) return false;
  db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(now(), keyId);
  audit(db, user.id, 'api_key.revoked', 'api_key', keyId, null);
  return true;
}

export function registerInstance(db, input) {
  const rawApiKey = String(input?.apiKey || input?.api_key || '').trim();
  let ownerId;
  let scope;
  let teamId;
  let enrollment = null;

  if (rawApiKey) {
    const key = apiKeyByToken(db, rawApiKey);
    if (!key) {
      const error = new Error('API Key 无效或已撤销');
      error.status = 401;
      error.code = 'api_key_invalid';
      throw error;
    }
    ownerId = key.user_id;
    scope = key.scope;
    teamId = key.team_id;
  } else {
    const rawKey = String(input?.enrollmentKey || '').trim();
    if (!rawKey) {
      const error = new Error('缺少接入密钥或 API Key');
      error.status = 400;
      error.code = 'missing_credential';
      throw error;
    }
    enrollment = db
      .prepare(
        `SELECT e.*, u.email AS owner_email, u.name AS owner_name
         FROM enrollment_keys e JOIN users u ON u.id = e.user_id
         WHERE e.token_hash = ? AND e.expires_at > ? AND e.used_at IS NULL`,
      )
      .get(sha256(rawKey), now());
    if (!enrollment) {
      const error = new Error('接入密钥无效、已使用或已过期');
      error.status = 401;
      error.code = 'enrollment_invalid';
      throw error;
    }
    ownerId = enrollment.user_id;
    scope = enrollment.scope;
    teamId = enrollment.team_id;
  }

  const clientInstanceId = String(input?.clientInstanceId || input?.client_instance_id || '').trim().slice(0, 128) || null;
  const clientName = String(input?.friendlyName || input?.clientName || '').trim().slice(0, 120) || null;
  const hostIp = String(input?.hostIp || input?.host_ip || '').trim().slice(0, 255) || null;
  const processUser = String(input?.processUser || input?.user || '').trim().slice(0, 120) || null;
  const processPid = Number.isFinite(Number(input?.pid ?? input?.processPid)) ? Number(input?.pid ?? input?.processPid) : null;
  const processStartedAt = String(input?.startedAt || input?.processStartedAt || '').trim().slice(0, 80) || null;
  const profile = String(input?.profile || '').trim().slice(0, 80) || null;
  const dshHome = String(input?.dshHome || '').trim().slice(0, 1024) || null;
  const createdAt = now();
  const webStatus = WEB_STATUS.has(input?.webStatus) ? input.webStatus : 'pending';
  const webTransport = input?.webTransport === 'direct' ? 'direct' : 'tunnel';
  const webPort = Number.isFinite(Number(input?.webPort)) ? Number(input.webPort) : null;
  const capabilities = Array.isArray(input?.capabilities) ? input.capabilities.map(String).slice(0, 30) : [];
  const mode = inferMode(input?.mode, capabilities);
  const common = {
    version: String(input?.version || '').slice(0, 80) || null,
    platform: String(input?.platform || '').slice(0, 80) || null,
    hostname: String(input?.hostname || '').slice(0, 120) || null,
    workspaceRoot: String(input?.workspaceRoot || '').slice(0, 1024) || null,
    webPort,
    webStatus,
    webTransport,
    webUrl: String(input?.webUrl || '').slice(0, 2048) || null,
    capabilitySummary: String(input?.capabilitySummary || '').trim().slice(0, 2_000) || null,
  };

  const issueToken = (instanceId) => {
    const raw = `haos_itk_${token(32)}`;
    db.prepare('INSERT INTO instance_tokens (id, instance_id, token_hash, created_at) VALUES (?, ?, ?, ?)').run(
      id('itk'),
      instanceId,
      sha256(raw),
      createdAt,
    );
    return raw;
  };

  let existing = clientInstanceId
    ? db
        .prepare('SELECT * FROM instances WHERE owner_id = ? AND client_instance_id = ? AND revoked_at IS NULL')
        .get(ownerId, clientInstanceId)
    : null;
  if (!existing && clientInstanceId) {
    const resumeId = String(input?.resumeInstanceId || '').trim();
    if (resumeId) {
      const candidate = db
        .prepare('SELECT * FROM instances WHERE id = ? AND owner_id = ? AND revoked_at IS NULL')
        .get(resumeId, ownerId);
      if (candidate && (!candidate.client_instance_id || candidate.client_instance_id === clientInstanceId)) {
        existing = candidate;
      }
    }
  }

  if (existing) {
    db.prepare('UPDATE instance_tokens SET revoked_at = ? WHERE instance_id = ? AND revoked_at IS NULL').run(createdAt, existing.id);
    db.prepare(
      `UPDATE instances SET
        scope = ?, team_id = ?, status = 'online', last_seen_at = ?,
        version = ?, platform = ?, hostname = ?, host_ip = ?, process_user = ?, process_pid = ?,
        process_started_at = ?, profile = ?, dsh_home = ?, workspace_root = ?,
        web_port = ?, web_status = ?, web_transport = ?, web_url = ?, capabilities_json = ?, capability_summary = ?, mode = ?,
        client_instance_id = COALESCE(client_instance_id, ?),
        client_name = COALESCE(?, client_name)
       WHERE id = ?`,
    ).run(
      scope,
      teamId,
      createdAt,
      common.version,
      common.platform,
      common.hostname,
      hostIp,
      processUser,
      processPid,
      processStartedAt,
      profile,
      dshHome,
      common.workspaceRoot,
      common.webPort,
      common.webStatus,
      common.webTransport,
      common.webUrl,
      JSON.stringify(capabilities),
      common.capabilitySummary,
      mode,
      clientInstanceId,
      clientName,
      existing.id,
    );
    const instanceToken = issueToken(existing.id);
    audit(db, ownerId, 'instance.reconnected', 'instance', existing.id, {
      clientInstanceId,
      hostIp,
      processUser,
      pid: processPid,
    });
    return { instanceId: existing.id, instanceToken, scope, ownerId, name: existing.name, reused: true };
  }

  const instanceName = enrollment ? String(enrollment.name).trim().slice(0, 120) : nextInstanceName(db);
  const instanceId = id('ins');
  db.prepare(
    `INSERT INTO instances
      (id, name, owner_id, scope, team_id, status, version, platform, hostname, host_ip,
       process_user, process_pid, process_started_at, profile, dsh_home, client_instance_id, client_name,
       workspace_root, web_port, web_status, web_transport, web_url, capabilities_json, capability_summary, mode, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    instanceId,
    instanceName,
    ownerId,
    scope,
    teamId,
    'online',
    common.version,
    common.platform,
    common.hostname,
    hostIp,
    processUser,
    processPid,
    processStartedAt,
    profile,
    dshHome,
    clientInstanceId,
    clientName,
    common.workspaceRoot,
    common.webPort,
    common.webStatus,
    common.webTransport,
    common.webUrl,
    JSON.stringify(capabilities),
    common.capabilitySummary,
    mode,
    createdAt,
    createdAt,
  );
  const instanceToken = issueToken(instanceId);
  if (enrollment) db.prepare('UPDATE enrollment_keys SET used_at = ? WHERE id = ?').run(createdAt, enrollment.id);
  audit(db, ownerId, 'instance.registered', 'instance', instanceId, {
    name: instanceName,
    scope,
    clientInstanceId,
    hostIp,
    processUser,
    pid: processPid,
    auth: rawApiKey ? 'api_key' : 'enrollment',
  });
  return { instanceId, instanceToken, scope, ownerId, name: instanceName, reused: false };
}

export function updateHeartbeat(db, instance, input) {
  const timestamp = now();
  const webStatus = WEB_STATUS.has(input?.webStatus) ? input.webStatus : instance.web_status;
  const webTransport = input?.webTransport === 'direct' ? 'direct' : input?.webTransport === 'tunnel' ? 'tunnel' : instance.web_transport;
  const webPort = Number.isFinite(Number(input?.webPort)) ? Number(input.webPort) : instance.web_port;
  const incomingCapabilities = Array.isArray(input?.capabilities) ? input.capabilities.map(String).slice(0, 30) : [];
  const mode = input?.mode === 'in-process' || input?.mode === 'sidecar'
    ? input.mode
    : incomingCapabilities.length > 0
      ? inferMode(undefined, incomingCapabilities)
      : instance.mode;
  db.prepare(
    `UPDATE instances SET
      status = 'online', last_seen_at = ?, version = COALESCE(?, version),
      platform = COALESCE(?, platform), hostname = COALESCE(?, hostname),
      host_ip = COALESCE(?, host_ip), process_user = COALESCE(?, process_user),
      process_pid = COALESCE(?, process_pid), process_started_at = COALESCE(?, process_started_at),
      profile = COALESCE(?, profile), dsh_home = COALESCE(?, dsh_home),
      client_instance_id = COALESCE(client_instance_id, ?),
      client_name = ?,
      workspace_root = COALESCE(?, workspace_root), web_port = ?,
      web_status = ?, web_transport = ?, web_url = COALESCE(?, web_url),
      capabilities_json = COALESCE(?, capabilities_json),
      capability_summary = COALESCE(?, capability_summary),
      mode = COALESCE(?, mode)
     WHERE id = ?`,
  ).run(
    timestamp,
    String(input?.version || '').slice(0, 80) || null,
    String(input?.platform || '').slice(0, 80) || null,
    String(input?.hostname || '').slice(0, 120) || null,
    String(input?.hostIp || input?.host_ip || '').trim().slice(0, 255) || null,
    String(input?.processUser || input?.user || '').trim().slice(0, 120) || null,
    Number.isFinite(Number(input?.pid ?? input?.processPid)) ? Number(input?.pid ?? input?.processPid) : null,
    String(input?.startedAt || input?.processStartedAt || '').trim().slice(0, 80) || null,
    String(input?.profile || '').trim().slice(0, 80) || null,
    String(input?.dshHome || '').trim().slice(0, 1024) || null,
    String(input?.clientInstanceId || input?.client_instance_id || '').trim().slice(0, 128) || null,
    String(input?.friendlyName || input?.clientName || '').trim().slice(0, 120) || null,
    String(input?.workspaceRoot || '').slice(0, 1024) || null,
    webPort,
    webStatus,
    webTransport,
    String(input?.webUrl || '').slice(0, 2048) || null,
    incomingCapabilities.length > 0 ? JSON.stringify(incomingCapabilities) : null,
    String(input?.capabilitySummary || '').trim().slice(0, 2_000) || null,
    mode || null,
    instance.id,
  );
  return timestamp;
}

export function instanceView(db, hub, instance) {
  const lastSeenForOnline = instance.last_seen_at ? Date.parse(instance.last_seen_at) : 0;
  const online = !instance.revoked_at && (Boolean(hub?.isOnline(instance.id)) || (lastSeenForOnline > 0 && Date.now() - lastSeenForOnline < 90_000));
  const owner = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(instance.owner_id);
  const team = instance.team_id
    ? db.prepare('SELECT id, name FROM teams WHERE id = ?').get(instance.team_id)
    : null;
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const viewers = db
    .prepare(
      'SELECT COUNT(DISTINCT user_id) AS n FROM web_sessions WHERE instance_id = ? AND last_seen_at > ? AND closed_at IS NULL',
    )
    .get(instance.id, cutoff).n;
  const lastSeen = instance.last_seen_at ? Date.parse(instance.last_seen_at) : 0;
  let capabilities = [];
  try {
    capabilities = instance.capabilities_json ? JSON.parse(instance.capabilities_json) : [];
  } catch {
    capabilities = [];
  }
  const mode = instance.mode || (capabilities.includes('sessions') || capabilities.includes('events') || capabilities.includes('control') ? 'in-process' : 'sidecar');
  const serverName = instance.name;
  const displayName = instance.name_override || instance.client_name || serverName;
  return {
    id: instance.id,
    name: displayName,
    displayName,
    org: {
      id: instance.org_id ?? null,
      parentInstanceId: instance.org_parent_id ?? null,
      role: instance.org_role ?? null,
      depth: instance.org_depth ?? null,
    },
    serverName,
    clientName: instance.client_name || null,
    nameOverride: instance.name_override || null,
    clientInstanceId: instance.client_instance_id || null,
    mode,
    modeLabel: mode === 'in-process' ? '插件' : 'Sidecar',
    scope: instance.scope,
    scopeLabel: scopeLabel(instance.scope),
    teamId: instance.team_id,
    teamName: team?.name || null,
    ownerId: instance.owner_id,
    ownerName: owner?.name || null,
    online,
    status: online ? 'online' : lastSeen && Date.now() - lastSeen < 90_000 ? 'disconnected' : 'offline',
    version: instance.version,
    platform: instance.platform,
    hostname: instance.hostname,
    hostIp: instance.host_ip || null,
    processUser: instance.process_user || null,
    processPid: instance.process_pid || null,
    processStartedAt: instance.process_started_at || null,
    profile: instance.profile || null,
    dshHome: instance.dsh_home || null,
    workspaceRoot: instance.workspace_root,
    webPort: instance.web_port,
    webStatus: online ? instance.web_status : instance.web_status === 'ready' ? 'offline' : instance.web_status,
    webTransport: instance.web_transport,
    webReady: online && instance.web_status === 'ready',
    webPath: `/w/${instance.id}/`,
    viewers,
    capabilities: Array.isArray(capabilities) ? capabilities : [],
    capabilitySummary: instance.capability_summary || null,
    lastSeenAt: instance.last_seen_at,
    createdAt: instance.created_at,
  };
}

export function listInstances(db, hub, user, scope) {
  const rows = db.prepare('SELECT * FROM instances WHERE revoked_at IS NULL ORDER BY created_at DESC').all();
  return rows
    .filter((row) => {
      if (user.is_admin) return true;
      if (row.owner_id === user.id) return true;
      if (row.scope === 'public') return true;
      if (row.scope === 'team' && row.team_id) {
        return Boolean(db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').get(row.team_id, user.id));
      }
      return false;
    })
    .filter((row) => !scope || scope === 'all' || row.scope === scope)
    .map((row) => instanceView(db, hub, row))
    .sort((a, b) => Number(b.online) - Number(a.online) || String(b.createdAt).localeCompare(String(a.createdAt)));
}
