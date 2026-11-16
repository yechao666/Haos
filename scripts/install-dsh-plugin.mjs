#!/usr/bin/env node
/**
 * 在“已经安装好的 DSH profile”里安装并配置 dsh-haos，不需要新建 haos profile，
 * 也不需要 haos-agent sidecar。
 *
 * 用法：
 *   node scripts/install-dsh-plugin.mjs \
 *     --profile desktop \
 *     --base http://127.0.0.1:4600 \
 *     --api-key 'haos_api_...' \
 *     --workspace "$HOME/.haos/workspace"
 *
 * 之后重启 DSH（桌面应用或对应 dsh --profile <profile> 进程）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i += 1) {
  const item = argv[i];
  if (!item.startsWith('--')) continue;
  const key = item.slice(2);
  const next = argv[i + 1];
  args[key] = next && !next.startsWith('--') ? (i += 1, next) : true;
}

const dshHome = resolve(String(args['dsh-home'] || process.env.DSH_HOME || join(homedir(), '.dsh')));
const profile = String(args.profile || 'desktop');
const base = String(args.base || process.env.HAOS_BASE_URL || 'http://127.0.0.1:4600').replace(/\/+$/, '');
const apiKey = String(args['api-key'] || process.env.HAOS_API_KEY || '');
const workspace = resolve(String(args.workspace || process.env.HAOS_WORKSPACE || join(homedir(), '.haos', 'workspace')));
const haosHome = resolve(String(args['haos-home'] || process.env.HAOS_HOME || join(dshHome, 'haos-home', profile)));
const state = resolve(String(args.state || join(dshHome, 'state', 'dsh-haos.json')));
const profileDir = join(dshHome, 'profiles', profile);

if (!apiKey) {
  console.error('缺少 --api-key（Haos 用户级 API Key）');
  process.exit(1);
}
if (!existsSync(profileDir)) {
  console.error(`找不到 DSH profile：${profileDir}\n请先在 DSH 里使用过该 profile，或用 --profile 指定已有 profile。`);
  process.exit(1);
}
mkdirSync(workspace, { recursive: true, mode: 0o700 });
mkdirSync(dirname(state), { recursive: true, mode: 0o700 });

const pluginPath = join(ROOT, 'integrations', 'dsh-haos');
const result = spawnSync('dsh', ['plugin', '--profile', profile, 'add', `link:${pluginPath}`], {
  env: { ...process.env, DSH_HOME: dshHome },
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status || 1);

// `dsh plugin add` installs the dependency, but older profiles may not yet
// list the new bundle. Ensure the profile actually mounts it.
const manifestFile = join(profileDir, 'package.json');
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];
if (!manifest.dsh.profile.bundles.includes('dsh-haos')) {
  manifest.dsh.profile.bundles.push('dsh-haos');
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

const patchFile = join(profileDir, 'cordis.patch.yml');
let patch = readFileSync(patchFile, 'utf8');
if (!patch.includes('- id: dsh-haos')) {
  patch += `\n- id: dsh-haos\n  name: dsh-haos\n  config:\n    mode: in-process\n    baseUrl: '${base}'\n    apiKey: '${apiKey}'\n    workspaceRoot: '${workspace}'\n    haosHome: '${haosHome}'
    agentState: '${state}'\n    toolsEnabled: true\n    announceToAgent: true\n`;
  writeFileSync(patchFile, patch);
  console.log(`\n已写入 ${patchFile}`);
} else {
  console.log(`\n${patchFile} 已有 dsh-haos 配置；未覆盖。可在 DSH 设置 → Haos 修改。`);
}

console.log(`\n安装完成：profile=${profile}`);
if (profile === 'desktop') {
  console.log('重启 DSH 桌面应用后，插件会在进程内注册并建立 WEB Tunnel。');
} else {
  console.log(`重启：dsh --profile ${profile}\n或：DSH_HOME=${dshHome} dsh --profile ${profile}`);
}
console.log('实例名由 Haos 服务端分配；不需要 agent.mjs。');
