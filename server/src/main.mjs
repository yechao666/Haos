import { createServer } from 'node:http';
import { URL } from 'node:url';
import { HOST, PORT, PUBLIC_URL, DB_PATH } from './config.mjs';
import { openDb, ensureSeed, now, audit, teamIdFor } from './db.mjs';
import { apiKeyByToken, canManageTeam, login, publicUser, createSession, sessionCookie, clearSessionCookie, sessionUser, requireUser, bearer, instanceByToken } from './auth.mjs';
import { sendJson, sendError, readJson, parseCookies, serveStatic, originAllowed, clientIp } from './http.mjs';
import { TunnelHub } from './tunnel-hub.mjs';
import { ControlHub } from './control-hub.mjs';
import { WebGateway } from './web-gateway.mjs';
import {
  createApiKey,
  createEnrollment,
  listApiKeys,
  registerInstance,
  revokeApiKey,
  updateHeartbeat,
  instanceView,
  listInstances,
  normalizeScope,
} from './instances.mjs';
import { id } from './lib/ids.mjs';
import {
  bootstrapInstanceOrg,
  ensureOrgForUser,
  buildOrgView,
  claimRelayTask,
  createRelayTask,
  ensureOrg,
  finishRelayTask,
  orgOfInstance,
  pendingRelayTasks,
  relayTaskFor,
  setOrgTree,
} from './org.mjs';

const db = openDb();
const seeded = ensureSeed(db);
try {
  for (const row of db.prepare('SELECT * FROM instances WHERE org_id IS NULL').all()) bootstrapInstanceOrg(db, row);
  // 早期版本按 owner 建了个人组织；owner 有团队时把实例并入团队组织（原型阶段的统一）。
  for (const org of db.prepare('SELECT * FROM orgs WHERE owner_id IS NOT NULL').all()) {
    const teamId = db
      .prepare('SELECT team_id FROM team_members WHERE user_id = ? ORDER BY created_at LIMIT 1')
      .get(org.owner_id)?.team_id;
    if (!teamId) continue;
    const target = ensureOrg(db, { teamId });
    db.prepare("UPDATE instances SET org_id = ?, org_parent_id = NULL, org_role = 'member', org_depth = 0 WHERE org_id = ?").run(target.id, org.id);
    db.prepare('DELETE FROM orgs WHERE id = ?').run(org.id);
  }
} catch (error) {
  console.warn('[haos] org backfill failed', error?.message ?? error);
}
const hub = new TunnelHub({ db });
const control = new ControlHub({ db });
const gateway = new WebGateway({ db, hub });

function findInstance(instanceId) {
  return db.prepare('SELECT * FROM instances WHERE id = ? AND revoked_at IS NULL').get(instanceId);
}

function requireInstance(req, res) {
  const instance = instanceByToken(db, bearer(req));
  if (!instance) {
    sendError(res, 401, 'instance_unauthorized', '实例令牌无效');
    return null;
  }
  return instance;
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, name: 'haos', time: now() });
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(req);
    const user = login(db, body.email, body.password);
    if (!user) return sendError(res, 401, 'invalid_credentials', '邮箱或密码错误');
    const session = createSession(db, user.id);
    res.setHeader('set-cookie', sessionCookie(session.raw, session.expiresAt));
    audit(db, user.id, 'auth.login', 'user', user.id, null, clientIp(req));
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.haos_session) {
      const { sha256 } = await import('./lib/crypto.mjs');
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(cookies.haos_session));
    }
    res.setHeader('set-cookie', clearSessionCookie());
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/auth/me') {
    const user = sessionUser(req, db);
    if (!user) return sendError(res, 401, 'unauthorized', '未登录');
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (pathname.startsWith('/api/plugin/v1/')) {
    return handlePluginApi(req, res, url);
  }

  if (!pathname.startsWith('/api/')) return false;

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !originAllowed(req)) {
    return sendError(res, 403, 'bad_origin', 'Origin 校验失败');
  }

  const user = requireUser(req, res, db);
  if (!user) return true;

  // ── 组织配置（浏览器控制台，中心化配置入口）──────────────
  if (method === 'GET' && pathname === '/api/org') {
    let org;
    try {
      org = orgForRequest(user, url.searchParams.get('teamId') || '');
    } catch (error) {
      return sendError(res, error.status || 403, 'forbidden', error.message);
    }
    const view = buildOrgView(db, org.id);
    const assigned = new Set((view?.members ?? []).map((item) => item.instanceId));
    const visible = listInstances(db, hub, user).filter((item) => !assigned.has(item.id));
    return sendJson(res, 200, {
      ...view,
      unassigned: visible.map((item) => ({ instanceId: item.id, name: item.name, status: item.status, capabilities: item.capabilities ?? [] })),
    });
  }

  if (method === 'POST' && pathname === '/api/org/tree') {
    try {
      const body = await readJson(req);
      const org = orgForRequest(user, body.teamId || '');
      const view = setOrgTree(db, org.id, body.assignments ?? []);
      audit(db, user.id, 'org.tree.update', 'org', org.id, { assignments: body.assignments ?? [] }, clientIp(req));
      return sendJson(res, 200, view);
    } catch (error) {
      return sendError(res, error.status || 500, error.code || 'internal', error.message);
    }
  }

  if (method === 'POST' && pathname === '/api/org/max-depth') {
    try {
      const body = await readJson(req);
      const org = orgForRequest(user, body.teamId || '');
      const depth = Number(body.maxDepth);
      if (!Number.isInteger(depth) || depth < 1 || depth > 10) return sendError(res, 400, 'invalid_depth', 'maxDepth 取 1–10');
      db.prepare('UPDATE orgs SET max_depth = ? WHERE id = ?').run(depth, org.id);
      audit(db, user.id, 'org.maxdepth.update', 'org', org.id, { maxDepth: depth }, clientIp(req));
      return sendJson(res, 200, buildOrgView(db, org.id));
    } catch (error) {
      return sendError(res, error.status || 403, 'forbidden', error.message);
    }
  }

  if (method === 'PATCH' && pathname === '/api/org') {
    try {
      const body = await readJson(req);
      const org = orgForRequest(user, body.teamId || '');
      const name = String(body.name || '').trim().slice(0, 120);
      if (!name) return sendError(res, 400, 'invalid_name', '组织名称不能为空');
      db.prepare('UPDATE orgs SET name = ? WHERE id = ?').run(name, org.id);
      audit(db, user.id, 'org.updated', 'org', org.id, { name }, clientIp(req));
      return sendJson(res, 200, buildOrgView(db, org.id));
    } catch (error) {
      return sendError(res, error.status || 403, 'forbidden', error.message);
    }
  }

  if (method === 'GET' && pathname === '/api/org/tasks') {
    let org;
    try {
      org = orgForRequest(user, url.searchParams.get('teamId') || '');
    } catch (error) {
      return sendError(res, error.status || 403, 'forbidden', error.message);
    }
    const tasks = db
      .prepare('SELECT * FROM relay_tasks WHERE org_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(org.id)
      .map((row) => ({
        taskId: row.id,
        callerInstanceId: row.caller_instance_id,
        targetInstanceId: row.target_instance_id,
        status: row.status,
        title: row.title,
        depth: row.depth,
        createdAt: row.created_at,
        finishedAt: row.finished_at,
      }));
    return sendJson(res, 200, { tasks });
  }

  if (method === 'GET' && pathname === '/api/overview') {
    const instances = listInstances(db, hub, user);
    const stats = {
      total: instances.length,
      online: instances.filter((i) => i.online).length,
      webReady: instances.filter((i) => i.webReady).length,
      personal: instances.filter((i) => i.scope === 'personal').length,
      team: instances.filter((i) => i.scope === 'team').length,
      public: instances.filter((i) => i.scope === 'public').length,
    };
    return sendJson(res, 200, {
      user: publicUser(user),
      publicUrl: PUBLIC_URL,
      stats,
      instances,
      teams: [],
    });
  }

  if (method === 'GET' && pathname === '/api/instances') {
    const scope = url.searchParams.get('scope') || 'all';
    return sendJson(res, 200, { instances: listInstances(db, hub, user, scope) });
  }

  if (pathname === '/api/api-keys' && method === 'GET') {
    return sendJson(res, 200, { keys: listApiKeys(db, user) });
  }

  if (pathname === '/api/api-keys' && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 201, createApiKey(db, user, body));
  }

  const apiKeyRoute = /^\/api\/api-keys\/([^/]+)$/.exec(pathname);
  if (apiKeyRoute && method === 'DELETE') {
    if (!revokeApiKey(db, user, apiKeyRoute[1])) return sendError(res, 404, 'not_found', 'API Key 不存在');
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/instances/enrollments') {
    const body = await readJson(req);
    const enrollment = createEnrollment(db, user, body);
    return sendJson(res, 201, enrollment);
  }

  if (method === 'GET' && pathname === '/api/teams') {
    return sendJson(res, 200, { teams: teamsForUser(user) });
  }

  if (method === 'GET' && pathname === '/api/users') {
    const rows = db.prepare('SELECT id, name, email FROM users ORDER BY name').all();
    return sendJson(res, 200, { users: rows });
  }

  if (method === 'POST' && pathname === '/api/teams') {
    const body = await readJson(req);
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) return sendError(res, 400, 'invalid_name', '团队名称不能为空');
    const slug = String(body.slug || `team-${Date.now().toString(36)}`).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60) || `team-${Date.now().toString(36)}`;
    if (db.prepare('SELECT 1 FROM teams WHERE slug = ?').get(slug)) return sendError(res, 409, 'slug_exists', '团队标识已存在');
    const teamId = id('tm');
    const createdAt = now();
    db.prepare('INSERT INTO teams (id, name, slug, created_at) VALUES (?, ?, ?, ?)').run(teamId, name, slug, createdAt);
    db.prepare('INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').run(teamId, user.id, 'owner', createdAt);
    ensureOrg(db, { teamId });
    audit(db, user.id, 'team.created', 'team', teamId, { name, slug }, clientIp(req));
    return sendJson(res, 201, teamDetail(user, teamId));
  }

  const teamRoute = /^\/api\/teams\/([^/]+)(?:\/(members)(?:\/([^/]+))?)?$/.exec(pathname);
  if (teamRoute) {
    const teamId = teamRoute[1];
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
    if (!team) return sendError(res, 404, 'not_found', '团队不存在');
    const manager = user.is_admin || canManageTeam(db, user, teamId);
    const member = db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, user.id);
    if (!teamRoute[2] && method === 'GET') {
      if (!member && !user.is_admin) return sendError(res, 403, 'forbidden', '你不在该团队');
      return sendJson(res, 200, teamDetail(user, teamId));
    }
    if (!teamRoute[2] && method === 'PATCH') {
      if (!manager) return sendError(res, 403, 'forbidden', '只有团队管理员可以修改');
      const body = await readJson(req);
      const name = String(body.name || '').trim().slice(0, 80);
      if (!name) return sendError(res, 400, 'invalid_name', '团队名称不能为空');
      db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, teamId);
      audit(db, user.id, 'team.updated', 'team', teamId, { name }, clientIp(req));
      return sendJson(res, 200, teamDetail(user, teamId));
    }
    if (!teamRoute[2] && method === 'DELETE') {
      if (!manager) return sendError(res, 403, 'forbidden', '只有团队管理员可以删除');
      const count = db.prepare('SELECT COUNT(*) AS n FROM instances WHERE team_id = ? AND revoked_at IS NULL').get(teamId).n;
      if (count > 0) return sendError(res, 409, 'team_in_use', `团队还有 ${count} 个实例，请先调整实例范围`);
      db.prepare('DELETE FROM relay_tasks WHERE org_id IN (SELECT id FROM orgs WHERE team_id = ?)').run(teamId);
      db.prepare('DELETE FROM orgs WHERE team_id = ?').run(teamId);
      db.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId);
      db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
      audit(db, user.id, 'team.deleted', 'team', teamId, null, clientIp(req));
      return sendJson(res, 200, { ok: true });
    }
    if (teamRoute[2] === 'members') {
      if (method === 'POST') {
        if (!manager) return sendError(res, 403, 'forbidden', '只有团队管理员可以添加成员');
        const body = await readJson(req);
        const target = body.userId
          ? db.prepare('SELECT * FROM users WHERE id = ?').get(String(body.userId))
          : db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(String(body.email || '').trim());
        if (!target) return sendError(res, 404, 'user_not_found', '用户不存在');
        const role = ['owner', 'admin', 'member'].includes(body.role) ? body.role : 'member';
        db.prepare('INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role').run(teamId, target.id, role, now());
        audit(db, user.id, 'team.member.added', 'team', teamId, { userId: target.id, role }, clientIp(req));
        return sendJson(res, 200, teamDetail(user, teamId));
      }
      if (method === 'PATCH') {
        if (!manager) return sendError(res, 403, 'forbidden', '只有团队管理员可以修改角色');
        const userId = teamRoute[3];
        if (!userId) return sendError(res, 400, 'missing_user', '缺少用户 ID');
        const body = await readJson(req);
        const role = ['owner', 'admin', 'member'].includes(body.role) ? body.role : 'member';
        db.prepare('UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?').run(role, teamId, userId);
        audit(db, user.id, 'team.member.updated', 'team', teamId, { userId, role }, clientIp(req));
        return sendJson(res, 200, teamDetail(user, teamId));
      }
      if (method === 'DELETE') {
        if (!manager) return sendError(res, 403, 'forbidden', '只有团队管理员可以移除成员');
        const userId = teamRoute[3];
        if (!userId) return sendError(res, 400, 'missing_user', '缺少用户 ID');
        if (userId === user.id) return sendError(res, 400, 'cannot_remove_self', '不能移除自己');
        const owners = db.prepare("SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'owner'").get(teamId).n;
        const target = db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
        if (!target) return sendError(res, 404, 'not_member', '该用户不在团队');
        if (target.role === 'owner' && owners <= 1) return sendError(res, 409, 'last_owner', '不能移除最后一个 owner');
        db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, userId);
        audit(db, user.id, 'team.member.removed', 'team', teamId, { userId }, clientIp(req));
        return sendJson(res, 200, teamDetail(user, teamId));
      }
    }
    return sendError(res, 405, 'method_not_allowed', '不支持的团队操作');
  }

  const controlRoute = /^\/api\/instances\/([^/]+)\/(control|events|commands)$/.exec(pathname);
  if (controlRoute) {
    const instance = findInstance(controlRoute[1]);
    if (!instance) return sendError(res, 404, 'not_found', '实例不存在');
    if (!canSee(user, instance)) return sendError(res, 403, 'forbidden', '无权访问该实例');
    const action = controlRoute[2];
    if (action === 'control' && method === 'GET') {
      return sendJson(res, 200, {
        instance: instanceView(db, hub, instance),
        control: {
          ...control.status(instance.id),
          capabilities: (() => {
            try {
              return instance.capabilities_json ? JSON.parse(instance.capabilities_json) : [];
            } catch {
              return [];
            }
          })(),
        },
        commands: control.commands(instance.id, 12),
        events: control.events(instance.id, 30),
        tunnelOnline: hub.isOnline(instance.id),
      });
    }
    if (action === 'events' && method === 'GET') {
      return sendJson(res, 200, {
        events: control.events(instance.id, Number(url.searchParams.get('limit') || 60)),
        commands: control.commands(instance.id, 12),
        control: control.status(instance.id),
      });
    }
    if (action === 'commands' && method === 'POST') {
      const body = await readJson(req);
      const kind = String(body.kind || '');
      const dangerous = new Set(['web.restart', 'web.close', 'web.open', 'tunnel.reconnect']);
      if (dangerous.has(kind) && !canManage(user, instance)) {
        return sendError(res, 403, 'forbidden', '只有实例主人可以执行该命令');
      }
      const command = control.sendCommand(instance, user.id, kind, body.payload || {});
      audit(db, user.id, 'instance.command', 'instance', instance.id, { kind, commandId: command.id });
      return sendJson(res, 202, { command });
    }
  }

  const detail = /^\/api\/instances\/([^/]+)(?:\/(web\/sessions))?$/.exec(pathname);
  if (detail) {
    const instance = findInstance(detail[1]);
    if (!instance) return sendError(res, 404, 'not_found', '实例不存在');
    if (!canSee(user, instance)) return sendError(res, 403, 'forbidden', '无权访问该实例');
    if (detail[2] === 'web/sessions' && method === 'GET') {
      const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const rows = db
        .prepare(
          `SELECT w.user_id AS userId, u.name, u.email, w.opened_at AS openedAt, w.last_seen_at AS lastSeenAt
           FROM web_sessions w JOIN users u ON u.id = w.user_id
           WHERE w.instance_id = ? AND w.closed_at IS NULL AND w.last_seen_at > ?
           ORDER BY w.last_seen_at DESC`,
        )
        .all(instance.id, cutoff);
      return sendJson(res, 200, { sessions: rows });
    }
    if (method === 'GET') {
      return sendJson(res, 200, { instance: instanceView(db, hub, instance), control: control.status(instance.id) });
    }
    if (!canManage(user, instance)) return sendError(res, 403, 'forbidden', '只有实例主人可以修改');
    if (method === 'PATCH') {
      const body = await readJson(req);
      const changes = [];
      const values = [];
      if (typeof body.displayName === 'string') {
        const displayName = body.displayName.trim().slice(0, 120);
        changes.push('name_override = ?');
        values.push(displayName || null);
      }
      if (typeof body.scope === 'string') {
        const scope = normalizeScope(body.scope);
        let teamId = body.teamId ? String(body.teamId) : instance.team_id;
        if (scope === 'team') {
          if (!teamId) teamId = teamIdFor(db, user.id);
          if (!teamId) return sendError(res, 400, 'team_required', '团队范围需要先加入团队');
        } else {
          teamId = null;
        }
        changes.push('scope = ?', 'team_id = ?');
        values.push(scope, teamId);
      }
      if (changes.length === 0) return sendError(res, 400, 'no_changes', '没有可更新的字段');
      values.push(instance.id);
      db.prepare(`UPDATE instances SET ${changes.join(', ')} WHERE id = ?`).run(...values);
      const updated = findInstance(instance.id);
      if (body.scope !== undefined && updated?.scope === 'team' && updated.team_id) {
        const org = ensureOrg(db, { teamId: updated.team_id });
        const hasRoot = Boolean(org.root_instance_id) && org.root_instance_id !== updated.id;
        db.prepare('UPDATE instances SET org_id = ?, org_parent_id = NULL, org_role = ?, org_depth = 0 WHERE id = ?').run(
          org.id,
          hasRoot ? 'member' : 'leader',
          updated.id,
        );
        if (!hasRoot) db.prepare('UPDATE orgs SET root_instance_id = ? WHERE id = ?').run(updated.id, org.id);
      }
      audit(db, user.id, 'instance.updated', 'instance', instance.id, body);
      return sendJson(res, 200, { instance: instanceView(db, hub, findInstance(instance.id)) });
    }
    if (method === 'DELETE') {
      db.prepare('UPDATE instances SET revoked_at = ?, status = ? WHERE id = ?').run(now(), 'offline', instance.id);
      db.prepare('UPDATE instance_tokens SET revoked_at = ? WHERE instance_id = ?').run(now(), instance.id);
      const connection = hub.connections.get(instance.id);
      try {
        connection?.ws.close(4003, 'revoked');
      } catch {
        /* noop */
      }
      audit(db, user.id, 'instance.revoked', 'instance', instance.id, null, clientIp(req));
      return sendJson(res, 200, { ok: true });
    }
  }

  const reconnect = /^\/api\/instances\/([^/]+)\/reconnect-key$/.exec(pathname);
  if (reconnect && method === 'POST') {
    const instance = findInstance(reconnect[1]);
    if (!instance) return sendError(res, 404, 'not_found', '实例不存在');
    if (!canManage(user, instance)) return sendError(res, 403, 'forbidden', '只有实例主人可以重新接入');
    db.prepare('UPDATE instance_tokens SET revoked_at = ? WHERE instance_id = ?').run(now(), instance.id);
    try {
      hub.connections.get(instance.id)?.ws.close(4004, 'reconnect_required');
    } catch {
      /* noop */
    }
    const enrollment = createEnrollment(db, user, {
      scope: instance.scope,
      teamId: instance.team_id,
    }, { name: instance.name });
    audit(db, user.id, 'instance.reconnect_key', 'instance', instance.id, null, clientIp(req));
    return sendJson(res, 200, enrollment);
  }

  return sendError(res, 404, 'not_found', '接口不存在');
}

function canSee(user, instance) {
  if (user.is_admin) return true;
  if (instance.owner_id === user.id) return true;
  if (instance.scope === 'public') return true;
  if (instance.scope === 'team' && instance.team_id) {
    return Boolean(db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').get(instance.team_id, user.id));
  }
  return false;
}

function canManage(user, instance) {
  return Boolean(user.is_admin) || instance.owner_id === user.id;
}

function orgForRequest(user, _teamId) {
  // 团队已退役；组织按登录用户归属。
  return ensureOrgForUser(db, user);
}

function teamDetail(user, teamId) {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team) return null;
  const member = db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, user.id);
  if (!member && !user.is_admin) return null;
  const members = db
    .prepare(
      `SELECT u.id, u.name, u.email, m.role, m.created_at AS joinedAt
       FROM team_members m JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.name`,
    )
    .all(teamId);
  const instances = db
    .prepare('SELECT id, name, name_override, client_name, status FROM instances WHERE team_id = ? AND revoked_at IS NULL')
    .all(teamId)
    .map((row) => ({ id: row.id, name: row.name_override || row.client_name || row.name, status: row.status }));
  return {
    team: { ...team, role: member?.role || (user.is_admin ? 'admin' : null), memberCount: members.length },
    members,
    instances,
  };
}

function teamsForUser(user) {
  if (user.is_admin) {
    return db
      .prepare(
        `SELECT t.id, t.name, t.slug, COUNT(m.user_id) AS members
         FROM teams t LEFT JOIN team_members m ON m.team_id = t.id
         GROUP BY t.id ORDER BY t.created_at`,
      )
      .all();
  }
  return db
    .prepare(
      `SELECT t.id, t.name, t.slug, m.role,
        (SELECT COUNT(*) FROM team_members x WHERE x.team_id = t.id) AS members
       FROM teams t JOIN team_members m ON m.team_id = t.id
       WHERE m.user_id = ? ORDER BY t.created_at`,
    )
    .all(user.id);
}

async function handlePluginApi(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/plugin/v1/validate-key') {
    const body = await readJson(req);
    const key = apiKeyByToken(db, String(body.apiKey || body.api_key || '').trim());
    if (!key) return sendError(res, 401, 'api_key_invalid', 'API Key 无效或已撤销');
    return sendJson(res, 200, {
      ok: true,
      owner: { id: key.user_id, name: key.owner_name, email: key.owner_email },
      scope: key.scope,
      teamId: key.team_id,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/plugin/v1/register') {
    const body = await readJson(req);
    const result = registerInstance(db, body);
    try {
      const row = db.prepare('SELECT * FROM instances WHERE id = ?').get(result.instanceId);
      bootstrapInstanceOrg(db, row);
    } catch (error) {
      console.warn('[haos] org bootstrap failed', error?.message ?? error);
    }
    if (result.reused) {
      try {
        hub.connections.get(result.instanceId)?.ws.close(4005, 'replaced_by_client');
      } catch {
        /* noop */
      }
      try {
        control.connections.get(result.instanceId)?.ws.close(4005, 'replaced_by_client');
      } catch {
        /* noop */
      }
    }
    return sendJson(res, 201, {
      instanceId: result.instanceId,
      instanceToken: result.instanceToken,
      instanceName: result.name,
      reused: Boolean(result.reused),
      publicUrl: PUBLIC_URL,
      protocol: 1,
      webPath: `/w/${result.instanceId}/`,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/plugin/v1/instance') {
    const instance = requireInstance(req, res);
    if (!instance) return true;
    return sendJson(res, 200, {
      instance: instanceView(db, hub, instance),
      control: control.status(instance.id),
      tunnelOnline: hub.isOnline(instance.id),
      capabilities: (() => {
        try {
          return instance.capabilities_json ? JSON.parse(instance.capabilities_json) : [];
        } catch {
          return [];
        }
      })(),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/plugin/v1/org') {
    const instance = requireInstance(req, res);
    if (!instance) return true;
    try {
      const org = orgOfInstance(db, instance);
      if (!org) return sendJson(res, 200, { org: null, members: [] });
      return sendJson(res, 200, buildOrgView(db, org.id));
    } catch (error) {
      return sendError(res, error.status || 500, error.code || 'internal', error.message);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/plugin/v1/tasks') {
    const instance = requireInstance(req, res);
    if (!instance) return true;
    try {
      const body = await readJson(req);
      return sendJson(res, 201, createRelayTask(db, instance, body));
    } catch (error) {
      return sendError(res, error.status || 500, error.code || 'internal', error.message);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/plugin/v1/tasks/pending') {
    const instance = requireInstance(req, res);
    if (!instance) return true;
    return sendJson(res, 200, { tasks: pendingRelayTasks(db, instance.id) });
  }

  const relayTaskRoute = /^\/api\/plugin\/v1\/tasks\/([^/]+)(?:\/(claim|result|fail))?$/.exec(url.pathname);
  if (relayTaskRoute) {
    const instance = requireInstance(req, res);
    if (!instance) return true;
    const [, taskId, action] = relayTaskRoute;
    try {
      if (!action && req.method === 'GET') return sendJson(res, 200, relayTaskFor(db, taskId, instance.id));
      if (action === 'claim' && req.method === 'POST') return sendJson(res, 200, claimRelayTask(db, taskId, instance.id));
      if (action === 'result' && req.method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, finishRelayTask(db, taskId, instance.id, { status: 'succeeded', summary: body.summary }));
      }
      if (action === 'fail' && req.method === 'POST') {
        const body = await readJson(req);
        return sendJson(res, 200, finishRelayTask(db, taskId, instance.id, { status: body.canceled ? 'canceled' : 'failed', error: body.error || '任务失败' }));
      }
      return sendError(res, 405, 'method_not_allowed', '不支持的方法');
    } catch (error) {
      return sendError(res, error.status || 500, error.code || 'internal', error.message);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/plugin/v1/events') {
    const instance = requireInstance(req, res);
    if (!instance) return true;
    const body = await readJson(req);
    const event = control.recordEvent(instance.id, String(body.kind || 'agent.event'), body.payload || {});
    return sendJson(res, 201, { event });
  }

  if (req.method === 'POST' && url.pathname === '/api/plugin/v1/notify') {
    const instance = requireInstance(req, res);
    if (!instance) return true;
    const body = await readJson(req);
    const event = control.recordEvent(instance.id, 'notification', {
      level: ['info', 'success', 'warning', 'error'].includes(body.level) ? body.level : 'info',
      title: String(body.title || 'DSH 通知').slice(0, 160),
      message: String(body.message || body.content || '').slice(0, 4000),
    });
    return sendJson(res, 201, { event });
  }

  if (req.method === 'POST' && url.pathname === '/api/plugin/v1/heartbeat') {
    const instance = requireInstance(req, res);
    if (!instance) return true;
    const body = await readJson(req);
    updateHeartbeat(db, instance, body);
    try {
      const fresh = db.prepare('SELECT * FROM instances WHERE id = ?').get(instance.id);
      if (fresh && !fresh.org_id) bootstrapInstanceOrg(db, fresh);
    } catch (error) {
      console.warn('[haos] org bootstrap on heartbeat failed', error?.message ?? error);
    }
    return sendJson(res, 200, {
      ok: true,
      serverTime: now(),
      instanceId: instance.id,
      webPath: `/w/${instance.id}/`,
    });
  }

  return sendError(res, 404, 'not_found', '插件接口不存在');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/w/')) {
      const handled = await gateway.handleHttp(req, res, url);
      if (handled) return;
      return sendError(res, 404, 'not_found', '实例不存在');
    }
    const api = await handleApi(req, res, url);
    if (api === true || api === false) {
      if (api === false) {
        if (!serveStatic(req, res, url.pathname)) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
        }
      }
      return;
    }
  } catch (error) {
    const status = Number(error.status) || 500;
    if (!res.headersSent) {
      sendError(res, status, error.code || 'internal_error', error.message || '服务器内部错误');
    } else {
      res.destroy();
    }
    if (status >= 500) console.error('[haos]', error);
  }
});

server.on('upgrade', (req, socket, head) => {
  try {
    if (control.handleUpgrade(req, socket, head)) return;
    if (hub.handleUpgrade(req, socket, head)) return;
    if (gateway.handleUpgrade(req, socket, head)) return;
  } catch (error) {
    console.error('[haos] upgrade error', error);
  }
  socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
  socket.destroy();
});

server.on('clientError', (error, socket) => {
  if (!socket.writable) return;
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Haos prototype`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  URL:  ${PUBLIC_URL}`);
  if (seeded) {
    console.log(`  Demo: admin@haos.local / haos-demo`);
    console.log(`        member@haos.local / haos-demo`);
  }
  console.log(`  Data: ${DB_PATH}`);
  console.log(`  ─────────────────────────────────────\n`);
});

function shutdown() {
  console.log('\n[haos] shutting down…');
  hub.close();
  control.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
