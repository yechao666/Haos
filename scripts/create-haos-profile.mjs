#!/usr/bin/env node
/**
 * 创建一个同时包含 dsh-web-app + dsh-haos 的 DSH profile。
 *
 * 用法：
 *   node scripts/create-haos-profile.mjs \
 *     --dsh-home ~/.dsh \
 *     --key haos_enr_xxx \
 *     --base http://127.0.0.1:4600 \
 *     --workspace ~/.haos/haos-workspace
 *
 * 之后：
 *   dsh --profile haos --no-open --host 127.0.0.1 --port 30900
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((out, item) => {
    if (item.startsWith('--')) out.push([item.slice(2), true]);
    else if (out.length) out[out.length - 1][1] = item;
    return out;
  }, []),
);

const dshHome = resolve(String(args['dsh-home'] || process.env.DSH_HOME || join(homedir(), '.dsh')));
const profile = String(args.profile || 'haos');
const target = join(dshHome, 'profiles', profile);
const source = join(dshHome, 'profiles', 'web');
const base = String(args.base || process.env.HAOS_BASE_URL || 'http://127.0.0.1:4600').replace(/\/+$/, '');
const key = String(args.key || process.env.HAOS_ENROLLMENT_KEY || '');
const workspace = resolve(String(args.workspace || process.env.HAOS_WORKSPACE || join(homedir(), '.haos', 'haos-workspace')));
const state = resolve(String(args.state || join(dshHome, 'state', 'dsh-haos.json')));

if (!key) {
  console.error('缺少 --key（Haos 接入密钥）');
  process.exit(1);
}
if (!existsSync(source)) {
  console.error(`找不到 web profile：${source}。请先运行 dsh web --help 或安装 dsh-web-app。`);
  process.exit(1);
}
if (existsSync(target) && !args.force) {
  console.error(`profile 已存在：${target}。加 --force 覆盖。`);
  process.exit(1);
}
if (existsSync(target) && args.force) cpSync(source, target, { recursive: true, force: true });
else cpSync(source, target, { recursive: true });
mkdirSync(workspace, { recursive: true, mode: 0o700 });

const pluginPath = join(ROOT, 'integrations', 'dsh-haos');
const result = spawnSync('dsh', ['plugin', '--profile', profile, 'add', `link:${pluginPath}`], {
  env: { ...process.env, DSH_HOME: dshHome },
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status || 1);

const patchFile = join(target, 'cordis.patch.yml');
let patch = readFileSync(patchFile, 'utf8');
const block = `\n- id: dsh-haos\n  name: dsh-haos\n  config:\n    mode: in-process\n    baseUrl: '${base}'\n    enrollmentKey: '${key}'\n    workspaceRoot: '${workspace}'\n    agentState: '${state}'\n    toolsEnabled: true\n    announceToAgent: true\n`;
if (!patch.includes('- id: dsh-haos')) patch += block;
writeFileSync(patchFile, patch);

mkdirSync(dirname(state), { recursive: true, mode: 0o700 });
console.log(`\n创建完成：${target}`);
console.log(`启动：\n  DSH_HOME=${dshHome} dsh --profile ${profile} --no-open --host 127.0.0.1 --port 30900\n`);
console.log('验证：Haos 实例页应出现该实例；它是单进程 DSH，内含 web + control + session events + tunnel。');
