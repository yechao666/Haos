import * as React from 'react';

const h = React.createElement;
const API = () => new URL('api/haos/config', document.baseURI).toString();
const TEST_API = () => new URL('api/haos/test', document.baseURI).toString();

const styles = {
  wrap: { maxWidth: 820, padding: '4px 0 28px', color: 'var(--dsw-alias-label-primary, #e8eefc)' },
  lead: { margin: '0 0 16px', color: 'var(--dsw-alias-label-secondary, #8b9ab5)', fontSize: 12, lineHeight: 1.7 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  list: { display: 'grid', gap: 12 },
  card: { border: '1px solid var(--dsw-alias-border-secondary, rgba(148,163,184,.22))', borderRadius: 12, padding: 15, background: 'var(--dsw-alias-bg-layer-1, rgba(17,24,41,.7))', display: 'grid', gap: 12 },
  cardActive: { borderColor: 'rgba(94,234,212,.48)', boxShadow: '0 0 0 1px rgba(94,234,212,.08) inset' },
  cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  headerToggle: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, padding: 0, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' },
  chevron: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #5d6b85)', flex: '0 0 auto' },
  summaryLine: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, marginTop: 2 },
  cardTitle: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  cardName: { fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  badge: { fontSize: 9, padding: '2px 7px', borderRadius: 999, background: 'rgba(94,234,212,.15)', color: '#5eead4', whiteSpace: 'nowrap' },
  meta: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #5d6b85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 },
  field: { display: 'grid', gap: 6, minWidth: 0 },
  label: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-secondary, #8b9ab5)' },
  input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-secondary, rgba(148,163,184,.25))', borderRadius: 8, padding: '9px 11px', background: 'var(--dsw-alias-bg-layer-2, rgba(8,13,25,.8))', color: 'var(--dsw-alias-label-primary, #e8eefc)', fontSize: 13, outline: 'none' },
  textarea: { minHeight: 68, resize: 'vertical', fontFamily: 'inherit' },
  hint: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary, #5d6b85)', lineHeight: 1.6 },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  actions: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' },
  button: { border: '1px solid transparent', borderRadius: 8, padding: '8px 13px', background: 'linear-gradient(135deg,#5eead4,#7dd3fc)', color: '#04121a', fontWeight: 700, fontSize: 12, cursor: 'pointer' },
  secondary: { border: '1px solid var(--dsw-alias-border-secondary, rgba(148,163,184,.25))', borderRadius: 8, padding: '7px 11px', background: 'transparent', color: 'var(--dsw-alias-label-secondary, #8b9ab5)', fontWeight: 600, fontSize: 11, cursor: 'pointer' },
  danger: { border: '1px solid rgba(251,113,133,.3)', borderRadius: 8, padding: '7px 11px', background: 'transparent', color: '#fb7185', fontSize: 11, cursor: 'pointer' },
  statusLine: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginTop: 2 },
  dot: { width: 7, height: 7, borderRadius: 999, flex: '0 0 auto' },
  message: { fontSize: 11, color: 'var(--dsw-alias-state-success-primary, #34d399)' },
  error: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary, #fb7185)' },
  check: { display: 'flex', gap: 7, alignItems: 'center', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #8b9ab5)' },
};

function Label({ children }) { return h('label', { style: styles.label }, children); }
function Input({ label, value, onChange, placeholder, type = 'text' }) {
  return h('div', { style: styles.field }, h(Label, null, label), h('input', { style: styles.input, type, value: value ?? '', placeholder: placeholder ?? '', onChange: (event) => onChange(event.target.value), autoComplete: 'off' }));
}
function Area({ label, value, onChange, placeholder }) {
  return h('div', { style: styles.field }, h(Label, null, label), h('textarea', { style: { ...styles.input, ...styles.textarea }, value: value ?? '', placeholder: placeholder ?? '', onChange: (event) => onChange(event.target.value) }));
}

function profileId() { return `profile-${Date.now().toString(36)}`; }
function normalize(value) {
  let list = Array.isArray(value?.profiles) ? value.profiles : [];
  if (!list.length && typeof value?.profilesJson === 'string' && value.profilesJson.trim()) {
    try { const parsed = JSON.parse(value.profilesJson); if (Array.isArray(parsed)) list = parsed; } catch { /* ignore */ }
  }
  if (list.length) {
    return list.map((profile, index) => ({
      id: profile.id || `profile-${index + 1}`,
      friendlyName: profile.friendlyName || '',
      capabilitySummary: profile.capabilitySummary || '',
      webEnabled: profile.webEnabled !== false,
      baseUrl: profile.baseUrl || 'http://127.0.0.1:4600',
      apiKey: '',
      workspaceRoot: profile.workspaceRoot || '',
    }));
  }
  return [{
    id: 'profile-1',
    friendlyName: value?.friendlyName || '',
    capabilitySummary: value?.capabilitySummary || '',
    webEnabled: value?.webEnabled !== false,
    baseUrl: value?.baseUrl || 'http://127.0.0.1:4600',
    apiKey: '',
    workspaceRoot: value?.workspaceRoot || '',
  }];
}

function HaosSettingsPage() {
  const [form, setForm] = React.useState(null);
  const [profiles, setProfiles] = React.useState([]);
  const [activeId, setActiveId] = React.useState('');
  const [expandedIds, setExpandedIds] = React.useState([]);
  const [error, setError] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [testingId, setTestingId] = React.useState('');
  const [saved, setSaved] = React.useState('');
  const [testStates, setTestStates] = React.useState({});
  const latest = React.useRef({ profiles: [], activeId: '', form: null });
  const savingRef = React.useRef(false);
  latest.current = { profiles, activeId, form };

  const load = React.useCallback(async () => {
    setError('');
    try {
      const response = await fetch(API(), { credentials: 'same-origin' });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
      const value = data.form?.value || {};
      const nextProfiles = normalize(value);
      setForm(data.form); setProfiles(nextProfiles);
      const nextActiveId = nextProfiles.some((item) => item.id === value.activeProfileId) ? value.activeProfileId : nextProfiles[0].id;
      setActiveId(nextActiveId);
      setExpandedIds([]);
    } catch (loadError) { setError(loadError.message); }
  }, []);
  React.useEffect(() => { load(); }, [load]);

  const update = (id, key, next) => {
    setSaved(''); setProfiles((current) => current.map((item) => item.id === id ? { ...item, [key]: next } : item));
    setTestStates((current) => ({ ...current, [id]: { status: 'untested', message: '' } }));
  };
  const addProfile = () => {
    const next = { id: profileId(), friendlyName: '新配置', capabilitySummary: '', webEnabled: true, baseUrl: 'http://127.0.0.1:4600', apiKey: '', workspaceRoot: '' };
    setProfiles((current) => [...current, next]); setExpandedIds((current) => [...current, next.id]); setSaved('');
  };
  const removeProfile = (id) => {
    if (profiles.length <= 1) return;
    const next = profiles.filter((item) => item.id !== id);
    setProfiles(next);
    setExpandedIds((current) => current.filter((item) => item !== id));
    if (activeId === id) setActiveId(next[0].id);
    setSaved('');
  };

  const save = async () => {
    if (savingRef.current) return;
    const snapshot = latest.current;
    if (!snapshot.form) return;
    savingRef.current = true;
    setSaving(true); setError('');
    try {
      const patch = {
        profilesJson: JSON.stringify(snapshot.profiles.map((profile) => ({ ...profile, apiKey: profile.apiKey?.trim() ? profile.apiKey : '' }))),
        activeProfileId: snapshot.activeId,
      };
      const response = await fetch(API(), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch, revision: snapshot.form.revision }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
      setForm(data.form); setSaved('配置已保存；只有活动配置会连接 Haos。');
      await load();
    } catch (saveError) { setError(saveError.message); } finally { savingRef.current = false; setSaving(false); }
  };

  const test = async (profile) => {
    setTestingId(profile.id);
    setTestStates((current) => ({ ...current, [profile.id]: { status: 'testing', message: '' } }));
    try {
      const response = await fetch(TEST_API(), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId: profile.id, baseUrl: profile.baseUrl || '', apiKey: profile.apiKey || '' }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
      setTestStates((current) => ({ ...current, [profile.id]: { status: 'ok', message: `连接成功：${data.owner?.name || data.owner?.email || '已授权'}` } }));
    } catch (testError) {
      setTestStates((current) => ({ ...current, [profile.id]: { status: 'fail', message: testError.message } }));
    } finally { setTestingId(''); }
  };

  if (!form) return h('div', { style: styles.wrap }, h('h2', { style: { margin: '0 0 8px' } }, 'Haos'), error ? h('div', { style: styles.error }, error) : h('div', { style: styles.lead }, '正在读取配置…'));

  return h('div', { style: styles.wrap },
    h('h2', { style: { margin: '0 0 8px' } }, 'Haos'),
    h('p', { style: styles.lead }, '每套配置是一张卡片；可以保存多套，但同一时间只能激活一套。只有活动配置会注册实例、维持心跳并连接 Haos。'),
    h('div', { style: styles.header }, h('span', { style: styles.meta }, `共 ${profiles.length} 套配置`), h('button', { type: 'button', style: styles.secondary, onClick: addProfile }, '+ 新增配置')),
    h('div', { style: { ...styles.list, marginTop: 10 } }, profiles.map((profile, index) => {
      const active = profile.id === activeId;
      const expanded = expandedIds.includes(profile.id);
      const testState = testStates[profile.id] || { status: 'untested', message: '' };
      const tone = testState.status === 'ok' ? '#34d399' : testState.status === 'fail' ? '#fb7185' : testState.status === 'testing' ? '#fbbf24' : '#6b7280';
      const statusText = testState.status === 'ok' ? '已连通' : testState.status === 'fail' ? '连接失败' : testState.status === 'testing' ? '检测中…' : '未测试';
      const toggle = () => setExpandedIds((current) => current.includes(profile.id) ? current.filter((item) => item !== profile.id) : [...current, profile.id]);
      return h('div', { style: { ...styles.card, ...(active ? styles.cardActive : {}) }, key: profile.id },
        h('div', { style: styles.cardHead },
          h('button', { type: 'button', style: styles.headerToggle, onClick: toggle, 'aria-expanded': expanded },
            h('span', { style: styles.chevron }, expanded ? '▾' : '▸'),
            h('div', { style: styles.cardTitle }, h('span', { style: styles.cardName }, profile.friendlyName || `配置 ${index + 1}`), active ? h('span', { style: styles.badge }, '当前活动') : null),
          ),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('label', { style: styles.check }, h('input', { type: 'radio', name: 'haos-active-profile', checked: active, onChange: () => { setActiveId(profile.id); setExpandedIds((current) => [...new Set([...current, profile.id])]); setSaved(''); } }), '设为活动'),
            h('button', { type: 'button', style: styles.secondary, disabled: saving, onClick: save }, saving ? '保存中…' : '保存'),
            profiles.length > 1 ? h('button', { type: 'button', style: styles.danger, onClick: () => removeProfile(profile.id) }, '删除') : null,
          ),
        ),
        h('div', { style: styles.statusLine },
          h('span', { style: { ...styles.dot, background: tone } }),
          h('span', { style: { ...styles.meta, color: tone } }, statusText),
          testState.message ? h('span', { style: styles.meta, title: testState.message }, testState.message) : null,
        ),
        expanded ? h(React.Fragment, null,
          h('div', { style: styles.grid },
            h(Input, { label: '本实例友好名', value: profile.friendlyName, placeholder: '例如：设计部 Mac mini', onChange: (next) => update(profile.id, 'friendlyName', next) }),
            h(Input, { label: 'Haos 中心地址（API 端点）', value: profile.baseUrl, placeholder: 'http://127.0.0.1:4600', onChange: (next) => update(profile.id, 'baseUrl', next) }),
          ),
          h(Area, { label: '本实例工作能力概述', value: profile.capabilitySummary, placeholder: '例如：macOS 本机 DSH，负责前端开发、测试与文件处理', onChange: (next) => update(profile.id, 'capabilitySummary', next) }),
          h('label', { style: styles.check },
            h('input', { type: 'checkbox', checked: profile.webEnabled !== false, onChange: (event) => update(profile.id, 'webEnabled', event.target.checked) }),
            '开放 WEB：允许在 Haos 中通过 Tunnel 打开此 DSH 的页面',
          ),
          h('div', { style: styles.grid },
            h(Input, { label: '连接 Haos 的 API Key', type: 'password', value: profile.apiKey, placeholder: '已配置时留空；haos_api_…', onChange: (next) => update(profile.id, 'apiKey', next) }),
            h(Input, { label: '本地根工作区目录', value: profile.workspaceRoot, placeholder: '例如：/Users/me/.haos/workspace', onChange: (next) => update(profile.id, 'workspaceRoot', next) }),
          ),
          h('div', { style: styles.actions },
            h('button', { type: 'button', style: styles.button, disabled: saving, onClick: save }, saving ? '保存中…' : '保存此配置'),
            h('button', { type: 'button', style: styles.secondary, disabled: Boolean(testingId), onClick: () => test(profile) }, testingId === profile.id ? '测试中…' : '测试此配置'),
          ),
        ) : null,
      );
    })),
    h('div', { style: { ...styles.card, marginTop: 12 } },
      h('div', { style: styles.actions },
        h('span', { style: styles.hint }, '修改后点击对应配置卡的“保存此配置”；保存后活动配置会连接 Haos。'),
        h('button', { type: 'button', style: styles.secondary, onClick: load, disabled: saving }, '重新读取'),
        saved ? h('span', { style: styles.message }, saved) : null,
        error ? h('span', { style: styles.error }, error) : null,
      ),
    ),
  );
}

export const name = 'dsh-haos-client';
export const inject = ['slots'];
export function apply(ctx) {
  try {
    ctx.slots.inject('settings.section', () => {
      const unregister = ctx.slots.register({ name: 'settings.section', id: 'dsh-haos', order: 22, label: () => 'Haos', inject: () => ({}) }, () => h(HaosSettingsPage));
      return () => unregister();
    });
  } catch (error) { console.error('[dsh-haos] settings slot failed', error); }
}
