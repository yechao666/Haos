const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

const state = {
  user: null,
  data: null,
  route: 'overview',
  instanceId: null,
  detail: null,
  detailSessions: [],
  control: null,
  team: null,
  teamId: null,
  users: [],
  filter: 'all',
  enrollment: null,
  apiKey: null,
  apiKeys: [],
  reconnect: null,
  org: null,
  orgTasks: [],
  orgTeamId: '',
  loading: false,
  error: '',
};

const icons = {
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>',
  instances: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>',
  connect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg>',
  teams: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.5a3 3 0 0 1 0 5.8M17.5 14.5a5.5 5.5 0 0 1 3 5"/></svg>',
  web: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4" stroke-linecap="round"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 4h6v6M20 4l-9 9" stroke-linecap="round"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 5H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h5M14 8l4 4-4 4M18 12H9" stroke-linecap="round"/></svg>',
  server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/></svg>',
};

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function icon(name) {
  return `<span class="icon">${icons[name] || ''}</span>`;
}

function toast(message, type = '') {
  toastEl.textContent = message;
  toastEl.className = `toast show ${type}`;
  clearTimeout(toastEl._timer);
  toastEl._timer = setTimeout(() => {
    toastEl.className = 'toast';
  }, 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message || `请求失败 (${response.status})`);
    error.code = data?.error?.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

function timeAgo(value) {
  if (!value) return '从未';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '未知';
  const diff = Math.max(0, Date.now() - time);
  if (diff < 10_000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return value;
  }
}

function scopeBadge(scope, label) {
  const cls = scope === 'public' ? 'green' : scope === 'team' ? 'blue' : '';
  return `<span class="badge ${cls}">${esc(label || scope)}</span>`;
}

function modeBadge(instance) {
  const mode = instance.mode === 'in-process' ? 'in-process' : 'sidecar';
  return `<span class="badge ${mode === 'in-process' ? 'teal' : 'blue'}">${mode === 'in-process' ? '插件' : 'Sidecar'}</span>`;
}

function statusOf(instance) {
  if (instance.online) return { cls: 'online', text: '在线', tone: 'green' };
  if (instance.status === 'disconnected') return { cls: 'warn', text: '连接中断', tone: 'amber' };
  return { cls: 'error', text: '离线', tone: 'red' };
}

function webOf(instance) {
  if (instance.webReady) return { text: 'WEB 就绪', tone: 'teal' };
  if (!instance.online) return { text: '离线', tone: '' };
  if (instance.webStatus === 'starting') return { text: 'WEB 启动中', tone: 'amber' };
  if (instance.webStatus === 'error') return { text: 'WEB 异常', tone: 'red' };
  if (instance.webStatus === 'off') return { text: 'WEB 未开放', tone: '' };
  return { text: '等待 WEB', tone: 'amber' };
}

function card(instance) {
  const status = statusOf(instance);
  const web = webOf(instance);
  return `
    <article class="card clickable" data-action="open-instance" data-id="${esc(instance.id)}">
      <div class="card-head">
        <div class="card-title"><span class="dot ${status.cls}"></span><span>${esc(instance.name)}</span></div>
        <div class="row wrap" style="gap:6px">${modeBadge(instance)}${scopeBadge(instance.scope, instance.scopeLabel)}</div>
      </div>
      <div class="card-meta">
        ${status.text} · ${web.text}<br />
        ${instance.hostIp || instance.hostname || '未知主机'}${instance.processUser ? ` · ${esc(instance.processUser)}` : ''}${instance.processPid ? ` · PID ${instance.processPid}` : ''}<br />
        ${instance.hostname ? esc(instance.hostname) : ''}${instance.platform ? ` · ${esc(instance.platform)}` : ''}<br />
        最后心跳 ${timeAgo(instance.lastSeenAt)}
      </div>
      <div class="card-actions">
        ${instance.webReady ? `<button class="btn primary sm" data-action="open-web" data-id="${esc(instance.id)}">${icon('web')} 打开 WEB</button>` : ''}
        <button class="btn sm" data-action="open-instance" data-id="${esc(instance.id)}">详情</button>
        <button class="btn ghost sm" data-action="open-new" data-id="${esc(instance.id)}" ${instance.webReady ? '' : 'disabled'}>新窗口</button>
      </div>
    </article>
  `;
}

function renderLogin() {
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-brand">
          <div class="brand-mark">H</div>
          <div>
            <div class="login-title">Haos</div>
            <div class="login-sub">DSH 实例中枢 · 连接、管理、直接对话</div>
          </div>
        </div>
        <form class="login-form" id="login-form">
          <div class="field">
            <label class="label" for="email">邮箱</label>
            <input class="input" id="email" name="email" type="email" autocomplete="username" placeholder="admin@haos.local" value="admin@haos.local" required />
          </div>
          <div class="field">
            <label class="label" for="password">密码</label>
            <input class="input" id="password" name="password" type="password" autocomplete="current-password" placeholder="haos-demo" value="haos-demo" required />
          </div>
          <div class="error-text" id="login-error"></div>
          <button class="btn primary" type="submit" style="width:100%;height:40px">进入 Haos</button>
          <button class="btn ghost sm" type="button" data-action="fill-demo">填充演示账号</button>
        </form>
        <div class="login-note">
          演示账号：<code>admin@haos.local</code> / <code>haos-demo</code><br />
          成员账号：<code>member@haos.local</code> / <code>haos-demo</code>
        </div>
      </div>
    </div>
  `;
  app.querySelector('#login-form').addEventListener('submit', onLogin);
}

async function onLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const errorEl = form.querySelector('#login-error');
  errorEl.textContent = '';
  button.disabled = true;
  button.textContent = '登录中…';
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: form.email.value,
        password: form.password.value,
      }),
    });
    state.user = result.user;
    state.error = '';
    await loadOverview();
    location.hash = '#/overview';
    renderShell();
    renderContent();
  } catch (error) {
    errorEl.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = '进入 Haos';
  }
}

function renderShell() {
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">H</div>
          <div>
            <div class="brand-name">Haos</div>
            <div class="brand-sub">DSH 实例中枢</div>
          </div>
        </div>
        <nav class="nav">
          <div class="nav-label">工作台</div>
          <button class="nav-item" data-action="navigate" data-route="overview">${icon('overview')} 概览</button>
          <button class="nav-item" data-action="navigate" data-route="instances">${icon('instances')} 实例</button>
          <button class="nav-item" data-action="navigate" data-route="connect">${icon('connect')} 接入实例</button>
          <div class="nav-label">组织</div>
          <button class="nav-item" data-action="navigate" data-route="org">${icon('instances')} 组织树</button>
        </nav>
        <div class="sidebar-spacer"></div>
        <div class="sidebar-card">
          <strong>反向 Tunnel</strong><br />
          DSH 只需出站连接 Haos，无需公网端口。打开 WEB 时由 Haos 建立加密通道。
        </div>
        <div class="user-row">
          <div class="avatar">${esc((state.user?.name || 'U').slice(0, 1))}</div>
          <div class="grow" style="min-width:0">
            <div class="user-name">${esc(state.user?.name || '')}</div>
            <div class="user-mail">${esc(state.user?.email || '')}</div>
          </div>
          <button class="icon-btn" data-action="logout" title="退出">${icon('logout')}</button>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <div class="crumbs" id="crumbs"><span>工作台</span><span>/</span><strong>概览</strong></div>
          <div class="top-actions">
            <span class="status-pill"><span class="dot online"></span> Haos 服务运行中</span>
            <button class="btn sm" data-action="refresh">${icon('refresh')} 刷新</button>
          </div>
        </header>
        <main class="content" id="content"></main>
      </div>
    </div>
  `;
  updateNav();
  renderContent();
}

function updateNav() {
  app.querySelectorAll('.nav-item').forEach((item) => {
    const route = item.dataset.route;
    item.classList.toggle('active', route === state.route || (route === 'instances' && state.route === 'detail'));
  });
}

function setCrumbs(text) {
  const el = app.querySelector('#crumbs');
  if (el) el.innerHTML = text;
}

function renderContent() {
  const content = app.querySelector('#content');
  if (!content) return;
  updateNav();
  if (state.route === 'detail' && state.instanceId) {
    renderDetail();
    return;
  }
  if (state.route === 'connect') {
    setCrumbs('<span>工作台</span><span>/</span><strong>接入实例</strong>');
    renderConnect();
    return;
  }
  if (state.route === 'instances') {
    setCrumbs('<span>工作台</span><span>/</span><strong>实例</strong>');
    renderInstances();
    return;
  }
  if (state.route === 'teams') {
    setCrumbs('<span>组织</span><span>/</span><strong>团队</strong>');
    renderTeams();
    return;
  }
  if (state.route === 'team') {
    setCrumbs('<span>组织</span><span>/</span><strong>团队</strong>');
    renderTeam();
    return;
  }
  if (state.route === 'org') {
    setCrumbs('<span>组织</span><span>/</span><strong>组织树</strong>');
    renderOrg();
    return;
  }
  setCrumbs('<span>工作台</span><span>/</span><strong>概览</strong>');
  renderOverview();
}

function renderOverview() {
  const content = app.querySelector('#content');
  const instances = state.data?.instances || [];
  const stats = state.data?.stats || { total: 0, online: 0, webReady: 0, personal: 0, public: 0 };
  content.innerHTML = `
    <section class="page-head">
      <div>
        <p class="eyebrow">Control plane</p>
        <h1>你的 DSH，集中在这里。</h1>
        <p class="lead">接入分散在内网、笔记本和服务器上的 DSH 实例。登录 Haos 后，直接打开实例的 dsh-web，对话、看工作目录、继续工作。</p>
      </div>
      <button class="btn primary" data-action="navigate" data-route="connect">${icon('connect')} 接入 DSH 实例</button>
    </section>

    <section class="stats">
      <div class="stat"><div class="stat-label">全部实例 <span class="badge">${stats.total}</span></div><div class="stat-value">${stats.total}</div><div class="stat-hint">已登记的 DSH</div></div>
      <div class="stat"><div class="stat-label">在线 <span class="dot online"></span></div><div class="stat-value">${stats.online}</div><div class="stat-hint">Tunnel / 心跳正常</div></div>
      <div class="stat"><div class="stat-label">WEB 就绪</div><div class="stat-value">${stats.webReady}</div><div class="stat-hint">可直接打开 dsh-web</div></div>
      <div class="stat"><div class="stat-label">共享范围</div><div class="stat-value" style="font-size:20px">${stats.personal} / ${stats.public}</div><div class="stat-hint">个人 / 公共</div></div>
    </section>

    <div class="section-head">
      <h2>实例 <span class="count">${instances.length} 个</span></h2>
      <button class="btn ghost sm" data-action="navigate" data-route="instances">查看全部 →</button>
    </div>

    ${
      instances.length
        ? `<div class="grid">${instances.slice(0, 6).map(card).join('')}</div>`
        : `<div class="empty">
            <div class="empty-icon">${icon('server')}</div>
            <h3>还没有接入实例</h3>
            <p>在已有 DSH 上安装 dsh-haos 插件，填入用户级 API Key。插件会在 DSH 进程内注册，并在有 dsh-web 时建立反向 Tunnel。</p>
            <button class="btn primary" data-action="navigate" data-route="connect">创建接入密钥</button>
          </div>`
    }

    <div class="two-col">
      <div class="panel">
        <h3>三步接入</h3>
        <div class="steps">
          <div class="step"><div class="step-num">1</div><div><strong>创建 API Key</strong><br />在 Haos 里生成用户级 API Key，可被多台 DSH 复用。</div></div>
          <div class="step"><div class="step-num">2</div><div><strong>在已有 DSH 安装插件</strong><br />安装 dsh-haos，填入 API Key，重启 DSH。</div></div>
          <div class="step"><div class="step-num">3</div><div><strong>打开 WEB（可选）</strong><br />如果 DSH profile 包含 dsh-web，可回到 Haos 直接打开页面。</div></div>
        </div>
      </div>
      <div class="panel">
        <h3>为什么不用端口映射</h3>
        <p class="lead" style="margin-top:0;font-size:12px">插件只主动出站连接 Haos。即使 DSH 在 NAT、防火墙或内网后面，也不需要公网 IP、端口转发或动态 DNS。Haos 只对已登录且有权访问的用户开放入口。</p>
        <div class="divider"></div>
        <div class="row wrap"><span class="badge teal">出站 WSS</span><span class="badge">HTTP/WS 多路复用</span><span class="badge">按实例鉴权</span></div>
      </div>
    </div>
  `;
}

function renderInstances() {
  const content = app.querySelector('#content');
  const all = state.data?.instances || [];
  const instances = state.filter === 'all' ? all : all.filter((item) => item.scope === state.filter);
  content.innerHTML = `
    <section class="page-head">
      <div>
        <p class="eyebrow">Instances</p>
        <h1>实例</h1>
        <p class="lead">你登录 Haos 后可以使用的 DSH。个人实例仅自己可见，公共实例对组织内登录用户可见。</p>
      </div>
      <button class="btn primary" data-action="navigate" data-route="connect">${icon('connect')} 接入新实例</button>
    </section>
    <div class="row wrap" style="justify-content:space-between;margin-bottom:14px">
      <div class="filters">
        ${['all', 'personal', 'public']
          .map(
            (key) =>
              `<button class="filter ${state.filter === key ? 'active' : ''}" data-action="filter" data-filter="${key}">${
                { all: '全部', personal: '个人', public: '公共' }[key]
              }</button>`,
          )
          .join('')}
      </div>
      <span class="small faint">${instances.length} 个实例</span>
    </div>
    ${
      instances.length
        ? `<div class="grid">${instances.map(card).join('')}</div>`
        : `<div class="empty"><div class="empty-icon">${icon('instances')}</div><h3>没有匹配的实例</h3><p>换个范围，或接入一台新的 DSH。</p><button class="btn primary" data-action="navigate" data-route="connect">接入实例</button></div>`
    }
  `;
}

function renderTeams() {
  const content = app.querySelector('#content');
  const teams = state.data?.teams || [];
  content.innerHTML = `
    <section class="page-head">
      <div><p class="eyebrow">Organizations</p><h1>组织与团队</h1><p class="lead">团队用于组织成员和共享 DSH 实例；每个团队拥有独立组织树。点击团队卡片管理成员、角色和实例。</p></div>
    </section>
    <div class="panel" style="max-width:820px;margin-bottom:16px">
      <h3>新建团队</h3>
      <form class="form" id="team-create-form">
        <div class="split">
          <div class="field"><label class="label" for="team-name">团队名称</label><input class="input" id="team-name" placeholder="例如：研发一组" maxlength="80" /></div>
          <div class="field"><label class="label" for="team-slug">团队标识（可选）</label><input class="input" id="team-slug" placeholder="例如：dev-team" maxlength="60" /></div>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">创建团队</button><span class="hint">创建后你会成为团队 owner，可在团队详情中添加成员。</span></div>
      </form>
    </div>
    <div class="section-head"><h2>团队 <span class="count">${teams.length} 个</span></h2></div>
    ${
      teams.length
        ? `<div class="grid">${teams
            .map(
              (team) => `
          <div class="card clickable" data-action="open-team" data-id="${esc(team.id)}">
            <div class="card-head"><div class="card-title">${icon('teams')} ${esc(team.name)}</div><span class="badge blue">${esc(team.role || (state.user?.isAdmin ? '管理员' : '成员'))}</span></div>
            <div class="card-meta">${esc(team.slug || team.id)}<br />${team.members ?? 0} 位成员 · 点击管理</div>
          </div>`,
            )
            .join('')}</div>`
        : `<div class="empty"><div class="empty-icon">${icon('teams')}</div><h3>还没有团队</h3><p>创建第一个团队后，即可在团队中管理成员和共享实例。</p></div>`
    }
  `;
  const form = content.querySelector('#team-create-form');
  form?.addEventListener('submit', createTeam);
}

async function createTeam(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const name = form.querySelector('#team-name').value.trim();
  const slug = form.querySelector('#team-slug').value.trim();
  if (!name) return toast('请填写团队名称', 'error');
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const data = await api('/api/teams', { method: 'POST', body: JSON.stringify({ name, slug: slug || undefined }) });
    await loadOverview({ silent: true });
    toast('团队已创建', 'ok');
    location.hash = `#/team/${encodeURIComponent(data.team.id)}`;
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function loadTeam(teamId) {
  try {
    const [detail, users] = await Promise.all([api(`/api/teams/${encodeURIComponent(teamId)}`), api('/api/users')]);
    state.team = detail;
    state.users = users.users || [];
    renderContent();
  } catch (error) {
    state.team = { error: error.message };
    renderContent();
  }
}

function renderTeam() {
  const content = app.querySelector('#content');
  const data = state.team;
  if (!data) {
    content.innerHTML = '<div class="empty"><p>正在读取团队…</p></div>';
    return;
  }
  if (data.error) {
    content.innerHTML = `<div class="empty"><h3>读取团队失败</h3><p>${esc(data.error)}</p><button class="btn" data-action="navigate" data-route="teams">返回团队</button></div>`;
    return;
  }
  const team = data.team;
  const members = data.members || [];
  const instances = data.instances || [];
  const candidates = (state.users || []).filter((user) => !members.some((member) => member.id === user.id));
  content.innerHTML = `
    <section class="page-head">
      <div><p class="eyebrow">Team</p><h1>${esc(team.name)}</h1><p class="lead">${esc(team.slug)} · ${members.length} 位成员 · ${instances.length} 个共享实例</p></div>
      <button class="btn ghost sm" data-action="navigate" data-route="teams">← 团队列表</button>
    </section>
    <div class="split" style="align-items:start">
      <div class="panel">
        <h3>团队信息</h3>
        <div class="field"><div class="label">团队名称</div><div class="inline" style="gap:8px"><input class="input" id="team-rename" value="${esc(team.name)}" /><button class="btn sm" data-action="team-rename">保存</button></div></div>
        <div class="kv-list" style="margin-top:12px"><div class="kv"><div class="kv-key">团队 ID</div><div class="kv-val mono">${esc(team.id)}</div></div><div class="kv"><div class="kv-key">我的角色</div><div class="kv-val">${esc(team.role || '—')}</div></div></div>
        <div class="divider"></div>
        <div class="field"><div class="label">添加成员</div>
          <div class="inline" style="gap:8px;flex-wrap:wrap">
            <select class="select" id="team-add-user" style="flex:1;min-width:180px"><option value="">选择用户…</option>${candidates.map((user) => `<option value="${esc(user.id)}">${esc(user.name)} · ${esc(user.email)}</option>`).join('')}</select>
            <select class="select" id="team-add-role" style="width:120px"><option value="member">成员</option><option value="admin">管理员</option><option value="owner">Owner</option></select>
            <button class="btn sm" data-action="team-add-member">添加</button>
          </div>
        </div>
        <div class="divider"></div>
        <div class="field"><div class="label">团队实例</div><div class="list">${instances.length ? instances.map((item) => `<div class="list-item"><strong>${esc(item.name)}</strong><span class="badge ${item.status === 'online' ? 'green' : ''}">${esc(item.status)}</span></div>`).join('') : '<div class="muted">团队还没有共享实例。可在实例详情把范围设为团队。</div>'}</div></div>
      </div>
      <div class="panel">
        <h3>成员与角色</h3>
        <div class="list">${members.map((member) => `
          <div class="list-item">
            <div class="inline" style="gap:8px;align-items:center"><strong>${esc(member.name)}</strong><span class="muted">${esc(member.email)}</span></div>
            <div class="inline" style="gap:8px;align-items:center">
              <select class="select" data-action="team-member-role" data-user="${esc(member.id)}" style="width:120px">
                ${['owner','admin','member'].map((role) => `<option value="${role}" ${member.role === role ? 'selected' : ''}>${role}</option>`).join('')}
              </select>
              ${member.id === state.user?.id ? '<span class="badge">我</span>' : `<button class="btn danger sm" data-action="team-remove-member" data-user="${esc(member.id)}">移除</button>`}
            </div>
          </div>`).join('')}</div>
      </div>
    </div>
  `;
}

async function saveTeamName() {
  const name = app.querySelector('#team-rename')?.value.trim();
  if (!name) return toast('团队名称不能为空', 'error');
  try {
    const data = await api(`/api/teams/${encodeURIComponent(state.team.team.id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    state.team = data;
    await loadOverview({ silent: true });
    renderTeam();
    toast('团队名称已更新', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function addTeamMember() {
  const userId = app.querySelector('#team-add-user')?.value;
  const role = app.querySelector('#team-add-role')?.value || 'member';
  if (!userId) return toast('请选择用户', 'error');
  try {
    state.team = await api(`/api/teams/${encodeURIComponent(state.team.team.id)}/members`, { method: 'POST', body: JSON.stringify({ userId, role }) });
    await loadOverview({ silent: true });
    renderTeam();
    toast('成员已添加', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function setTeamMemberRole(userId, role) {
  try {
    state.team = await api(`/api/teams/${encodeURIComponent(state.team.team.id)}/members/${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify({ role }) });
    renderTeam();
    toast('角色已更新', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function removeTeamMember(userId) {
  if (!confirm('确定移除该成员？')) return;
  try {
    state.team = await api(`/api/teams/${encodeURIComponent(state.team.team.id)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    await loadOverview({ silent: true });
    renderTeam();
    toast('成员已移除', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderConnect() {
  const content = app.querySelector('#content');
  const created = state.apiKey;
  content.innerHTML = `
    <section class="page-head">
      <div><p class="eyebrow">Connect</p><h1>接入 DSH 实例</h1><p class="lead">创建一个用户级 API Key，可被多台 DSH 实例复用。实例名由 Haos 服务端分配，不需要为每台实例单独生成密钥。</p></div>
    </section>
    ${created ? renderApiKeyCreated(created) : ''}
    <div class="panel" style="max-width:820px">
      <h3>${created ? '再创建一个 API Key' : '创建 API Key'}</h3>
      <div class="notice info" style="margin:0 0 12px">
        推荐使用插件模式：在已有 DSH profile 中安装 <code>dsh-haos</code>，填入 API Key 后重启 DSH。不需要 Agent/sidecar。
      </div>
      <form class="form" id="connect-form">
        <div class="split">
          <div class="field">
            <label class="label" for="scope">实例范围</label>
            <select class="select" id="scope" name="scope">
              <option value="personal">个人 · 仅自己</option>
              <option value="public">公共 · 组织内登录用户</option>
            </select>
            <div class="hint">API Key 创建的实例默认使用这个范围。</div>
          </div>
        </div>

        <div class="form-actions">
          <button class="btn primary" type="submit">生成 API Key</button>
          <span class="hint">创建后可被多台 DSH 复用；密钥只显示一次。</span>
        </div>
      </form>
      <div class="field" style="margin-top:18px">
        <div class="label">已有 API Key</div>
        <div id="api-key-list" class="faint">${renderApiKeyList(state.apiKeys || [])}</div>
      </div>
    </div>
  `;
  const form = content.querySelector('#connect-form');
  const scope = content.querySelector('#scope');
  form.addEventListener('submit', onCreateApiKey);
  loadApiKeys();
}

function renderApiKeyList(keys) {
  if (!keys.length) return '还没有 API Key。生成一个后可在多台 DSH 上复用。';
  return keys
    .map(
      (key) => `
      <div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)">
        <div><strong>${esc(key.name)}</strong><br /><span class="small faint">${esc(key.scope)} · ${new Date(key.createdAt).toLocaleString('zh-CN', { hour12: false })}${key.lastUsedAt ? ` · 最近使用 ${new Date(key.lastUsedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}</span></div>
        <span class="badge ${key.revokedAt ? 'red' : 'green'}">${key.revokedAt ? '已撤销' : '有效'}</span>
      </div>`,
    )
    .join('');
}

async function loadApiKeys() {
  try {
    const data = await api('/api/api-keys');
    state.apiKeys = data.keys || [];
    const list = app.querySelector('#api-key-list');
    if (list) list.innerHTML = renderApiKeyList(state.apiKeys);
  } catch {
    /* optional */
  }
}

function renderApiKeyCreated(created) {
  return `
    <div class="card" style="max-width:920px;margin-bottom:14px;border-color:rgba(94,234,212,.28)">
      <div class="card-head">
        <div class="card-title"><span class="dot online"></span> API Key 已生成</div>
        <span class="badge amber">只显示一次</span>
      </div>
      <div class="form" style="margin-top:12px">
        <div class="field">
          <div class="label">API Key</div>
          <div class="key-box">
            <input class="input mono" id="api-key-value" readonly value="${esc(created.key)}" />
            <button class="btn sm" data-copy-target="#api-key-value">${icon('copy')} 复制</button>
          </div>
          <div class="hint">这个 Key 可被多台 DSH 实例复用；丢失后需要重新创建。</div>
        </div>
        <div class="field">
          <div class="label">在已有 DSH 上安装插件</div>
          <div class="code-block">
            <div class="code-head"><span>shell</span><button class="btn ghost sm" data-copy-target="#plugin-install-command">复制命令</button></div>
            <pre id="plugin-install-command">${esc(created.pluginInstallCommand || '')}</pre>
          </div>
          <div class="hint">然后重启 DSH 桌面应用；Web profile 使用 <code>--profile web</code> 并重启对应进程。不需要 agent.mjs。</div>
        </div>
        <div class="notice info">接入成功后 Haos 会自动给该 DSH 增加一个 <code>haos-home</code> 工作区；Haos 侧的后续工作区会创建在这个父目录下。</div>
      </div>
    </div>
  `;
}

async function onCreateApiKey(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = '生成中…';
  try {
    const created = await api('/api/api-keys', {
      method: 'POST',
      body: JSON.stringify({
        scope: form.scope.value,
        teamId: form.teamId?.value || undefined,
      }),
    });
    state.apiKey = created;
    await loadApiKeys();
    renderConnect();
    toast('API Key 已生成', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = '生成 API Key';
    }
  }
}

function renderDetail() {
  const content = app.querySelector('#content');
  const instance = state.detail;
  if (!instance) {
    content.innerHTML = `<div class="empty"><div class="empty-icon">${icon('refresh')}</div><h3>正在读取实例…</h3></div>`;
    loadDetail(state.instanceId).catch((error) => toast(error.message, 'error'));
    return;
  }
  const status = statusOf(instance);
  const web = webOf(instance);
  const reconnect = null;
  setCrumbs(`<span>工作台</span><span>/</span><span>实例</span><span>/</span><strong>${esc(instance.name)}</strong>`);
  content.innerHTML = `
    <div class="detail-head">
      <div>
        <div class="row wrap" style="margin-bottom:6px">
          <button class="btn ghost sm" data-action="navigate" data-route="instances">← 实例</button>
          <span class="badge ${status.tone}">${status.text}</span>
          ${modeBadge(instance)}
          ${scopeBadge(instance.scope, instance.scopeLabel)}
          <span class="badge ${web.tone}">${web.text}</span>
        </div>
        <div class="detail-title"><h1>${esc(instance.name)}</h1></div>
        <div class="detail-sub">${esc(instance.id)} · 最后心跳 <span data-live="lastSeen">${timeAgo(instance.lastSeenAt)}</span> · <span data-live="viewers">${instance.viewers || 0}</span> 人在线</div>
      </div>
      <div class="row wrap">
        ${instance.webReady ? `<button class="btn primary" data-action="open-web" data-id="${esc(instance.id)}">${icon('web')} 打开 WEB</button>` : ''}
        <button class="btn" data-action="open-new" data-id="${esc(instance.id)}" ${instance.webReady ? '' : 'disabled'}>${icon('external')} 新窗口</button>
        ${state.user?.isAdmin ? `<button class="btn" data-action="rename-instance" data-id="${esc(instance.id)}">设置显示名</button>` : ''}
        <button class="btn" data-action="refresh">${icon('refresh')} 刷新</button>
      </div>
    </div>

    <div class="detail-grid">
      <div class="kv"><div class="kv-key">接入方式</div><div class="kv-val">${instance.mode === 'in-process' ? '插件 / in-process' : 'Sidecar / 兼容模式'}<br /><span class="faint">${instance.mode === 'in-process' ? 'DSH 进程内控制 + Tunnel' : '外部 Agent 反向 WEB'}</span></div></div>
      <div class="kv"><div class="kv-key">主机 / IP</div><div class="kv-val">${esc(instance.hostname || '—')}<br /><span class="faint">${esc(instance.hostIp || '—')}</span></div></div>
      <div class="kv"><div class="kv-key">进程用户 / PID</div><div class="kv-val">${esc(instance.processUser || '—')}<br /><span class="faint">${instance.processPid ?? '—'}</span></div></div>
      <div class="kv"><div class="kv-key">平台 / 版本</div><div class="kv-val">${esc(instance.platform || '—')}<br /><span class="faint">${esc(instance.version || '—')}</span></div></div>
      <div class="kv"><div class="kv-key">工作目录</div><div class="kv-val mono" style="font-size:10px">${esc(instance.workspaceRoot || '—')}</div></div>
      <div class="kv" style="grid-column:1 / -1"><div class="kv-key">工作能力概述</div><div class="kv-val">${esc(instance.capabilitySummary || '—')}</div></div>
      <div class="kv"><div class="kv-key">WEB 传输</div><div class="kv-val">${esc(instance.webTransport || 'tunnel')}<br /><span class="faint">端口 ${instance.webPort ?? '—'}</span></div></div>
    </div>

    <div class="panel">
      <div class="row" style="justify-content:space-between;margin-bottom:10px">
        <h3>dsh-web</h3>
        <span class="small faint">${instance.webReady ? '通过 Haos 反向 Tunnel 直连' : web.text}</span>
      </div>
      ${
        instance.webReady
          ? `<div class="web-shell">
              <div class="web-toolbar">
                <span class="dot online"></span>
                <span class="url">${esc(location.origin + instance.webPath)}</span>
                <span class="spacer"></span>
                <span class="badge ${instance.scope === 'personal' ? '' : 'amber'}">${instance.scope === 'personal' ? '仅自己' : '共享桌面'}</span>
                <button class="btn ghost sm" data-action="reload-iframe">${icon('refresh')} 重载</button>
              </div>
              <iframe class="web-frame" id="dsh-frame" src="${esc(instance.webPath)}" title="${esc(instance.name)} dsh-web"></iframe>
            </div>`
          : `<div class="empty" style="padding:26px">
              <div class="empty-icon">${icon('web')}</div>
              <h3>${instance.online ? 'WEB 尚未就绪' : '实例当前离线'}</h3>
              <p>${instance.online ? '插件已连接，但 dsh-web 还在启动或未开放。稍等几秒刷新；若持续失败，检查插件设置的 API Key 和 DSH 日志。' : '插件未连接到 Haos。请确认 DSH 已重启、插件已启用，并检查 API Key 与网络。'}</p>
            </div>`
      }
    </div>

    <div id="control-panel" style="margin-top:14px">${controlHtml()}</div>

    <div class="split" style="margin-top:14px">
      <div class="panel">
        <h3>接入信息</h3>
        <div class="list">
          <div class="list-item"><span class="muted">实例 ID</span><span class="mono small">${esc(instance.id)}</span></div>
          <div class="list-item"><span class="muted">主人</span><span>${esc(instance.ownerName || '—')}</span></div>
          <div class="list-item"><span class="muted">团队</span><span>${esc(instance.teamName || '—')}</span></div>
          <div class="list-item"><span class="muted">创建时间</span><span>${esc(formatDate(instance.createdAt))}</span></div>
        </div>
      </div>
      <div class="panel">
        <h3>当前在线</h3>
        ${
          state.detailSessions?.length
            ? `<div class="list">${state.detailSessions
                .map(
                  (session) =>
                    `<div class="list-item"><span>${esc(session.name)} <span class="faint small">${esc(session.email)}</span></span><span class="faint small">${timeAgo(session.lastSeenAt)}</span></div>`,
                )
                .join('')}</div>`
            : `<p class="lead" style="margin:0;font-size:12px">当前没有打开的 WEB 会话。打开后这里会显示在线使用者。</p>`
        }
        <div class="divider"></div>
        <div class="row wrap">
          <button class="btn danger sm" data-action="delete-instance" data-id="${esc(instance.id)}">删除实例</button>
        </div>
      </div>
    </div>
  `;
  const frame = content.querySelector('#dsh-frame');
  if (frame) {
    frame.addEventListener('load', () => frame.classList.add('loaded'), { once: true });
  }
}

function controlHtml() {
  const data = state.control;
  if (!data) {
    return `<div class="panel"><div class="row" style="justify-content:space-between"><h3>Haos 通信</h3><span class="badge">加载中</span></div><p class="lead" style="margin:10px 0 0;font-size:12px">正在读取控制通道状态…</p></div>`;
  }
  const control = data.control || {};
  const caps = control.capabilities || data.instance?.capabilities || [];
  const commands = data.commands || [];
  const events = data.events || [];
  const connected = Boolean(control.connected);
  const canManage = Boolean(state.user?.isAdmin) || state.detail?.ownerId === state.user?.id;
  const commandLabel = { ping: 'Ping', status: '获取状态', diagnostics: '诊断', 'web.restart': '重启 WEB', 'tunnel.reconnect': '重连 Tunnel', notify: '发送通知' };
  const statusBadge = (status) => {
    const map = { done: 'green', sent: 'blue', queued: 'amber', failed: 'red' };
    return `<span class="badge ${map[status] || ''}">${esc(status)}</span>`;
  };
  return `
    <div class="panel">
      <div class="row wrap" style="justify-content:space-between">
        <div>
          <h3>Haos 通信</h3>
          <p class="lead" style="margin:6px 0 0;font-size:11px">控制通道用于下发命令、接收事件，为后续项目/记忆/自动化能力提供基础。</p>
        </div>
        <div class="row wrap">
          <span class="badge ${connected ? 'green' : 'red'}"><span class="dot ${connected ? 'online' : 'error'}"></span> ${connected ? '控制通道已连接' : '控制通道未连接'}</span>
          <span class="badge ${data.tunnelOnline ? 'teal' : 'amber'}">Tunnel ${data.tunnelOnline ? '在线' : '离线'}</span>
          <button class="btn ghost sm" data-action="haos-control-refresh">刷新</button>
        </div>
      </div>
      <div class="row wrap" style="margin-top:12px">
        ${caps.length ? caps.map((cap) => `<span class="badge blue">${esc(cap)}</span>`).join('') : '<span class="badge">等待能力上报</span>'}
        <span class="spacer"></span>
        <button class="btn sm" data-action="haos-command" data-kind="ping">${icon('refresh')} Ping</button>
        <button class="btn sm" data-action="haos-command" data-kind="status">获取状态</button>
        <button class="btn sm" data-action="haos-command" data-kind="diagnostics">诊断</button>
        <button class="btn sm" data-action="haos-notify">${icon('copy')} 发通知</button>
        ${canManage ? `<button class="btn sm" data-action="haos-command" data-kind="web.restart">重启 WEB</button>
        <button class="btn sm" data-action="haos-command" data-kind="tunnel.reconnect">重连 Tunnel</button>` : ''}
      </div>
      <div class="split" style="margin-top:14px">
        <div>
          <div class="small faint" style="margin-bottom:7px">最近命令</div>
          ${
            commands.length
              ? `<div class="list">${commands
                  .slice(0, 6)
                  .map(
                    (cmd) => `<div class="list-item"><span><strong>${esc(commandLabel[cmd.kind] || cmd.kind)}</strong> <span class="faint small">${esc(cmd.id)}</span></span><span class="row">${statusBadge(cmd.status)}<span class="faint small">${timeAgo(cmd.createdAt)}</span></span></div>`,
                  )
                  .join('')}</div>`
              : `<div class="empty" style="padding:16px;text-align:left"><span class="faint small">还没有命令。点击上方按钮测试控制通道。</span></div>`
          }
        </div>
        <div>
          <div class="small faint" style="margin-bottom:7px">最近事件</div>
          ${
            events.length
              ? `<div class="list">${events
                  .slice(0, 6)
                  .map(
                    (event) => `<div class="list-item"><span class="mono small">${esc(event.kind)}</span><span class="faint small">${timeAgo(event.createdAt)}</span></div>`,
                  )
                  .join('')}</div>`
              : `<div class="empty" style="padding:16px;text-align:left"><span class="faint small">还没有事件。Agent 上线、命令完成、DSH 通知都会出现在这里。</span></div>`
          }
        </div>
      </div>
    </div>
  `;
}

function renderControlPanel() {
  const el = document.querySelector('#control-panel');
  if (!el) return;
  el.innerHTML = controlHtml();
}

async function renameInstance(instanceId) {
  const current = state.detail?.name || '';
  const displayName = prompt('服务端显示名（留空恢复客户端/服务端名称）', state.detail?.nameOverride || '');
  if (displayName === null) return;
  try {
    await api(`/api/instances/${encodeURIComponent(instanceId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName }),
    });
    await loadDetail(instanceId);
    await loadOverview({ silent: true });
    toast('显示名已更新', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadControl(instanceId) {
  try {
    state.control = await api(`/api/instances/${encodeURIComponent(instanceId)}/control`);
    renderControlPanel();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function sendHaosCommand(kind, payload = {}) {
  const id = state.detail?.id;
  if (!id) return;
  try {
    const result = await api(`/api/instances/${encodeURIComponent(id)}/commands`, {
      method: 'POST',
      body: JSON.stringify({ kind, payload }),
    });
    toast(`已发送：${kind}${result.command?.status === 'queued' ? '（等待 Agent 上线）' : ''}`, 'ok');
    setTimeout(() => loadControl(id), 400);
    setTimeout(() => loadControl(id), 1500);
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadDetail(instanceId, options = {}) {
  const [detail, sessions, control] = await Promise.all([
    api(`/api/instances/${encodeURIComponent(instanceId)}`),
    api(`/api/instances/${encodeURIComponent(instanceId)}/web/sessions`).catch(() => ({ sessions: [] })),
    api(`/api/instances/${encodeURIComponent(instanceId)}/control`).catch(() => null),
  ]);
  const wasReady = state.detail?.webReady;
  state.detail = detail.instance;
  state.detailSessions = sessions.sessions || [];
  state.control = control;
  if (state.route !== 'detail') return;
  if (options.silent && !wasReady && state.detail.webReady) {
    renderDetail();
    return;
  }
  if (options.silent) {
    updateDetailLive();
    renderControlPanel();
    return;
  }
  renderDetail();
}

function updateDetailLive() {
  if (state.route !== 'detail' || !state.detail) return;
  const instance = state.detail;
  const last = app.querySelector('[data-live="lastSeen"]');
  if (last) last.textContent = timeAgo(instance.lastSeenAt);
  const viewers = app.querySelector('[data-live="viewers"]');
  if (viewers) viewers.textContent = instance.viewers || 0;
}

function openInstance(id) {
  state.instanceId = id;
  state.detail = null;
  state.detailSessions = [];
  state.control = null;
  state.reconnect = null;
  state.route = 'detail';
  location.hash = `#/instances/${encodeURIComponent(id)}`;
  renderContent();
}

function openWeb(id) {
  const instance = (state.data?.instances || []).find((item) => item.id === id) || state.detail;
  if (!instance?.webReady) {
    toast('WEB 尚未就绪，请等待 Agent 启动 dsh-web', 'error');
    return;
  }
  openInstance(id);
}

async function deleteInstance(id) {
  if (!confirm('确定删除这个实例？实例令牌会立即吊销，Agent 将断开。')) return;
  try {
    await api(`/api/instances/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('实例已删除', 'ok');
    await loadOverview();
    location.hash = '#/instances';
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function loadOrg() {
  try {
    const [org, tasks] = await Promise.all([api('/api/org'), api('/api/org/tasks')]);
    state.org = org;
    state.orgTasks = tasks?.tasks ?? [];
    if (!state.orgTeamId && org?.org?.teamId) state.orgTeamId = org.org.teamId;
  } catch (error) {
    state.org = { org: null, members: [], unassigned: [], error: error.message };
  }
}

async function setOrgParent(instanceId, parentId) {
  try {
    await api('/api/org/tree', {
      method: 'POST',
      body: JSON.stringify({ assignments: [{ instanceId, parentId: parentId || null }] }),
    });
    toast('组织关系已更新', 'ok');
    await loadOrg();
    renderContent();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function renameOrg() {
  const name = app.querySelector('#org-name')?.value.trim();
  if (!name) return toast('组织名称不能为空', 'error');
  try {
    await api('/api/org', { method: 'PATCH', body: JSON.stringify({ name }) });
    await loadOrg();
    renderContent();
    toast('组织名称已更新', 'ok');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function setOrgMaxDepth(depth) {
  try {
    await api('/api/org/max-depth', { method: 'POST', body: JSON.stringify({ maxDepth: depth }) });
    toast('级联深度已更新', 'ok');
    await loadOrg();
    renderContent();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderOrg() {
  const content = app.querySelector('#content');
  const data = state.org;
  if (!data) {
    content.innerHTML = '<div class="empty"><div class="empty-icon">${icon("instances")}</div><h3>正在读取组织…</h3><p>请稍候。</p></div>';
    return;
  }
  if (data.error) {
    content.innerHTML = `<div class="empty"><div class="empty-icon">${icon('instances')}</div><h3>读取组织失败</h3><p>${esc(data.error)}</p><button class="btn" data-action="refresh">重试</button></div>`;
    return;
  }
  const org = data.org || {};
  const members = data.members || [];
  const unassigned = data.unassigned || [];
  const tasks = state.orgTasks || [];
  const children = new Map();
  const byId = new Map(members.map((member) => [member.instanceId, member]));
  for (const member of members) {
    const parent = member.parentInstanceId && byId.has(member.parentInstanceId) ? member.parentInstanceId : '__root__';
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(member);
  }
  for (const list of children.values()) list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const online = members.filter((member) => member.status === 'online').length;
  const depth = Math.max(0, ...members.map((member) => Number(member.depth) || 0));
  const treeRows = [];
  const seen = new Set();
  const renderNode = (member, level) => {
    if (!member || seen.has(member.instanceId)) return;
    seen.add(member.instanceId);
    const kids = children.get(member.instanceId) || [];
    const isOnline = member.status === 'online';
    const caps = Array.isArray(member.capabilities) ? member.capabilities.filter((cap) => !['web', 'tunnel'].includes(cap)).slice(0, 3) : [];
    treeRows.push(`
      <div class="org-node" style="--depth:${level}">
        <div class="org-rail"></div>
        <div class="org-node-card ${isOnline ? 'is-online' : ''}">
          <div class="org-node-head">
            <span class="dot ${isOnline ? 'online' : 'error'}"></span>
            <strong>${esc(member.name)}</strong>
            <span class="badge ${member.role === 'leader' ? 'teal' : 'blue'}">${esc(member.role || 'member')}</span>
            <span class="org-depth">L${esc(member.depth ?? level)}</span>
            <span class="org-node-spacer"></span>
            <button class="btn ghost sm" data-action="org-move" data-instance="${esc(member.instanceId)}" data-parent="${esc(member.parentInstanceId || '')}" data-name="${esc(member.name)}">调整位置</button>
          </div>
          <div class="org-node-meta">
            <span class="mono">${esc(member.instanceId)}</span>
            ${member.capabilitySummary ? `<span class="org-cap">${esc(member.capabilitySummary)}</span>` : ''}
            ${caps.length ? `<span class="org-caps">${caps.map((cap) => `<span class="badge">${esc(cap)}</span>`).join('')}</span>` : ''}
          </div>
        </div>
      </div>`);
    for (const child of kids) renderNode(child, level + 1);
  };
  for (const root of children.get('__root__') || []) renderNode(root, 0);
  const treeHtml = treeRows.join('') || '<div class="org-empty">还没有挂载实例。先从右侧把实例挂载到组织树。</div>';
  const unassignedHtml = unassigned.length
    ? unassigned.map((item) => `
        <div class="org-side-item">
          <div><strong>${esc(item.name)}</strong><div class="org-node-meta"><span class="mono">${esc(item.instanceId)}</span></div></div>
          <button class="btn sm" data-action="org-move" data-instance="${esc(item.instanceId)}" data-parent="" data-name="${esc(item.name)}">挂载</button>
        </div>`).join('')
    : '<div class="org-empty">没有未挂载实例。</div>';
  const taskHtml = tasks.length
    ? tasks.slice(0, 8).map((task) => `
        <div class="org-task">
          <span class="badge ${task.status === 'succeeded' ? 'green' : task.status === 'failed' ? 'red' : 'amber'}">${esc(task.status)}</span>
          <div class="org-task-main"><strong>${esc(task.title || task.taskId)}</strong><span class="mono">${esc(task.taskId)}</span></div>
          <span class="org-task-depth">depth ${esc(task.depth ?? 0)}</span>
        </div>`).join('')
    : '<div class="org-empty">还没有经 Haos 转发的任务。</div>';
  content.innerHTML = `
    <section class="org-hero">
      <div>
        <div class="eyebrow">Organization</div>
        <h1>${esc(org.name || '默认组织')}</h1>
        <p class="org-sub">集中管理团队实例的组织树、层级和委派任务。</p>
      </div>
      <div class="org-toolbar">
        <button class="btn ghost sm" data-action="refresh">刷新</button>
      </div>
    </section>
    <div class="org-stats">
      <div class="org-stat"><span>实例</span><strong>${members.length}</strong><small>在线 ${online}</small></div>
      <div class="org-stat"><span>最大层级</span><strong>L${depth}</strong><small>上限 ${esc(org.maxDepth ?? 3)}</small></div>
      <div class="org-stat"><span>未挂载</span><strong>${unassigned.length}</strong><small>待分配上级</small></div>
      <div class="org-stat"><span>组织 ID</span><strong class="mono org-stat-id">${esc(org.id || '—')}</strong><small>${esc(state.orgTeamId || '')}</small></div>
    </div>
    <div class="org-layout">
      <div class="panel org-tree-panel">
        <div class="org-panel-head"><div><h3>组织树</h3><p>每个节点是一个 DSH 实例；点击“调整位置”修改上级。</p></div><span class="badge teal">${online}/${members.length} 在线</span></div>
        <div class="org-tree">${treeHtml}</div>
      </div>
      <div class="org-side">
        <div class="panel">
          <div class="org-panel-head"><div><h3>未挂载实例</h3><p>注册后尚未放入组织树</p></div></div>
          <div class="org-side-list">${unassignedHtml}</div>
        </div>
        <div class="panel">
          <div class="org-panel-head"><div><h3>组织设置</h3><p>名称与级联上限</p></div></div>
          <div class="org-settings">
            <label class="label">组织名称</label>
            <div class="inline"><input class="input" id="org-name" value="${esc(org.name || '')}" /><button class="btn sm" data-action="org-rename">保存</button></div>
            <label class="label">级联上限</label>
            <div class="inline"><input class="input" id="org-depth" type="number" min="1" max="10" value="${esc(org.maxDepth ?? 3)}" style="width:80px" /><button class="btn sm" data-action="org-set-depth">保存</button></div>
          </div>
        </div>
      </div>
    </div>
    <div class="panel org-tasks-panel">
      <div class="org-panel-head"><div><h3>转发的任务</h3><p>最近 8 条组织内委派</p></div></div>
      <div class="org-task-list">${taskHtml}</div>
    </div>
    <dialog id="org-move-dialog" class="org-dialog">
      <div class="org-dialog-body">
        <h3>调整组织位置</h3>
        <p class="org-sub">为 <strong id="org-move-name"></strong> 选择新的上级；选择“根节点”表示作为组织根。</p>
        <select class="select" id="org-move-parent"><option value="">根节点（无上级）</option></select>
        <div class="org-dialog-actions"><button class="btn" type="button" data-action="org-move-cancel">取消</button><button class="btn primary" type="button" data-action="org-move-save">保存位置</button></div>
      </div>
    </dialog>
  `;
}

let orgMoveInstanceId = null;

function openOrgMoveDialog(instanceId, parentId, name) {
  const dialog = app.querySelector('#org-move-dialog');
  const select = app.querySelector('#org-move-parent');
  if (!dialog || !select) return;
  orgMoveInstanceId = instanceId;
  app.querySelector('#org-move-name').textContent = name || instanceId;
  const members = (state.org?.members || []).filter((member) => member.instanceId !== instanceId);
  select.innerHTML = '<option value="">根节点（无上级）</option>' + members
    .map((member) => `<option value="${esc(member.instanceId)}" ${member.instanceId === parentId ? 'selected' : ''}>${esc(member.name)} · L${esc(member.depth ?? 0)}</option>`)
    .join('');
  dialog.showModal();
}

async function saveOrgMove() {
  const parent = app.querySelector('#org-move-parent')?.value || null;
  const dialog = app.querySelector('#org-move-dialog');
  if (!orgMoveInstanceId) return;
  await setOrgParent(orgMoveInstanceId, parent);
  orgMoveInstanceId = null;
  dialog?.close();
}

async function loadOverview(options = {}) {
  try {
    const data = await api('/api/overview');
    state.data = data;
    state.user = data.user;
    if (options.silent && state.route === 'detail' && state.detail) {
      const fresh = (data.instances || []).find((item) => item.id === state.detail.id);
      if (fresh) {
        const wasReady = state.detail.webReady;
        state.detail = { ...state.detail, ...fresh };
        updateDetailLive();
        if (!wasReady && fresh.webReady) renderDetail();
      }
    } else if (!options.skipRender && ['overview', 'instances', 'teams'].includes(state.route)) {
      renderContent();
    }
  } catch (error) {
    if (error.status === 401) {
      state.user = null;
      renderLogin();
    } else if (!options.silent) {
      toast(error.message, 'error');
    }
  }
}

function routeFromHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] === 'instances' && parts[1]) {
    state.route = 'detail';
    state.instanceId = decodeURIComponent(parts[1]);
    return;
  }
  if (parts[0] === 'team' && parts[1]) {
    state.route = 'team';
    state.teamId = decodeURIComponent(parts[1]);
    state.instanceId = null;
    return;
  }
  if (['overview', 'instances', 'connect', 'teams', 'org'].includes(parts[0])) {
    state.route = parts[0];
    state.instanceId = null;
    return;
  }
  state.route = 'overview';
}

function onHashChange() {
  routeFromHash();
  if (!state.user) return;
  if (state.route === 'org') {
    loadOrg().then(() => renderContent()).catch((error) => toast(error.message, 'error'));
    renderContent();
  } else if (state.route === 'team') {
    state.team = null;
    loadTeam(state.teamId).catch((error) => toast(error.message, 'error'));
    renderContent();
  } else if (state.route === 'detail') {
    if (state.detail?.id !== state.instanceId) {
      state.detail = null;
      state.detailSessions = [];
      state.reconnect = null;
    }
    renderContent();
  } else {
    state.detail = null;
    renderContent();
  }
}

app.addEventListener('change', async (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'org-set-parent') {
    await setOrgParent(el.dataset.instance, el.value || null);
  }
  if (el.dataset.action === 'team-member-role') {
    await setTeamMemberRole(el.dataset.user, el.value);
  }
  if (el.dataset.action === 'org-select-team') {
    state.orgTeamId = el.value || '';
    await loadOrg();
    renderContent();
  }
});

app.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'fill-demo') {
    const form = document.querySelector('#login-form');
    if (form) {
      form.email.value = 'admin@haos.local';
      form.password.value = 'haos-demo';
    }
    return;
  }
  if (action === 'navigate') {
    location.hash = `#/${target.dataset.route}`;
    return;
  }
  if (action === 'open-team') {
    location.hash = `#/team/${encodeURIComponent(target.dataset.id)}`;
    return;
  }
  if (action === 'team-rename') {
    await saveTeamName();
    return;
  }
  if (action === 'team-add-member') {
    await addTeamMember();
    return;
  }
  if (action === 'team-remove-member') {
    await removeTeamMember(target.dataset.user);
    return;
  }
  if (action === 'org-rename') {
    await renameOrg();
    return;
  }
  if (action === 'org-move') {
    openOrgMoveDialog(target.dataset.instance, target.dataset.parent || '', target.dataset.name || '');
    return;
  }
  if (action === 'org-move-cancel') {
    app.querySelector('#org-move-dialog')?.close();
    return;
  }
  if (action === 'org-move-save') {
    await saveOrgMove();
    return;
  }
  if (action === 'rename-instance') {
    await renameInstance(target.dataset.id || state.detail?.id);
    return;
  }
  if (action === 'refresh') {
    await loadOverview({ silent: true });
    if (state.route === 'org') await loadOrg();
    if (state.route === 'detail' && state.detail) await loadDetail(state.detail.id);
    toast('已刷新', 'ok');
    return;
  }
  if (action === 'logout') {
    await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
    state.user = null;
    state.data = null;
    state.detail = null;
    location.hash = '';
    renderLogin();
    return;
  }
  if (action === 'open-instance') {
    event.stopPropagation();
    openInstance(target.dataset.id);
    return;
  }
  if (action === 'open-web') {
    event.stopPropagation();
    openWeb(target.dataset.id);
    return;
  }
  if (action === 'open-new') {
    event.stopPropagation();
    const instance = (state.data?.instances || []).find((item) => item.id === target.dataset.id) || state.detail;
    if (instance?.webReady) window.open(instance.webPath, '_blank', 'noopener');
    else toast('WEB 尚未就绪', 'error');
    return;
  }
  if (action === 'reload-iframe') {
    const frame = document.querySelector('#dsh-frame');
    if (frame) frame.src = frame.src;
    return;
  }
  if (action === 'filter') {
    state.filter = target.dataset.filter;
    renderInstances();
    return;
  }
  if (action === 'org-set-depth') {
    const input = document.querySelector('#org-depth');
    await setOrgMaxDepth(Number(input?.value) || 3);
    return;
  }
  if (action === 'delete-instance') {
    await deleteInstance(target.dataset.id);
    return;
  }
  if (action === 'haos-control-refresh') {
    await loadControl(state.detail?.id);
    return;
  }
  if (action === 'haos-command') {
    await sendHaosCommand(target.dataset.kind);
    return;
  }
  if (action === 'haos-notify') {
    const message = prompt('发送给 Haos 的通知内容：', '来自 DSH 的测试通知');
    if (message) await sendHaosCommand('notify', { title: 'DSH 通知', message, level: 'info' });
    return;
  }
});

// Fallback for copy buttons added after render
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-copy-target]');
  if (!button) return;
  if (button._copyBound) return;
  // delegated copy for dynamically rendered buttons
  const target = button.dataset.copyTarget;
  const el = document.querySelector(target);
  const text = el?.value ?? el?.textContent ?? '';
  if (!text) return;
  event.preventDefault();
  navigator.clipboard?.writeText(text).then(
    () => toast('已复制', 'ok'),
    () => {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      toast('已复制', 'ok');
    },
  );
});

window.addEventListener('hashchange', onHashChange);

async function init() {
  try {
    const result = await api('/api/auth/me');
    state.user = result.user;
    routeFromHash();
    await loadOverview();
    renderShell();
    renderContent();
    if (state.route === 'org') {
      await loadOrg();
      renderContent();
    } else if (state.route === 'team' && state.teamId) {
      await loadTeam(state.teamId);
    }
    setInterval(() => loadOverview({ silent: true }), 6000);
    setInterval(() => {
      if (state.route === 'detail' && state.detail) loadDetail(state.detail.id, { silent: true }).catch(() => {});
    }, 8000);
  } catch {
    renderLogin();
  }
}

init();
