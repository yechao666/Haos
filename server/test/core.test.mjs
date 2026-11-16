import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, sha256, verifyPassword } from '../src/lib/crypto.mjs';
import { nextInstanceName, normalizeScope, pluginInstallCommand, scopeLabel, shellQuote } from '../src/instances.mjs';

test('password hashing verifies only the right password', () => {
  const hash = hashPassword('haos-demo');
  assert.equal(verifyPassword('haos-demo', hash), true);
  assert.equal(verifyPassword('wrong', hash), false);
  assert.equal(verifyPassword('haos-demo', 'bad'), false);
});

test('sha256 is stable', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('scope normalization and labels', () => {
  assert.equal(normalizeScope('team'), 'team');
  assert.equal(normalizeScope('bogus'), 'personal');
  assert.equal(scopeLabel('public'), '公共');
});

test('shell quoting handles single quotes', () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test('plugin installer targets an existing DSH profile without an Agent process', () => {
  const command = pluginInstallCommand('haos_api_x');
  assert.match(command, /install-dsh-plugin\.mjs/);
  assert.match(command, /haos_api_x/);
  assert.doesNotMatch(command, /haos-agent/);
  assert.doesNotMatch(command, /--name/);
});

test('server instance names use the next free sequence', () => {
  const rows = [{ name: 'dsh-0007' }, { name: 'haos-inproc' }, { name: 'dsh-0003' }];
  const db = { prepare: () => ({ all: () => rows }) };
  assert.equal(nextInstanceName(db), 'dsh-0008');
});
