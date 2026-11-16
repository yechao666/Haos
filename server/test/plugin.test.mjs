import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, resolveConfig, toolDefinitions } from '../../integrations/dsh-haos/lib/index.js';

test('plugin config defaults', () => {
  const config = resolveConfig({});
  assert.equal(config.enabled, true);
  assert.equal(Array.isArray(config.profiles), true);
  assert.ok(config.profiles.length >= 1);
  assert.equal(config.baseUrl, config.active.baseUrl);
  assert.ok(config.activeProfileId);
});

test('plugin exports Haos tools', () => {
  assert.deepEqual(
    toolDefinitions.map((tool) => tool.name),
    ['haos_instance_info', 'haos_notify', 'haos_report', 'haos_org', 'haos_delegate', 'haos_task', 'haos_workspace'],
  );
});

test('plugin config overrides and trailing slash', () => {
  const config = resolveConfig({
    baseUrl: 'https://haos.example.com/',
    enrollmentKey: 'haos_enr_x',
    instanceName: 'team-server',
  });
  assert.equal(Array.isArray(config.profiles), true);
  assert.equal(config.baseUrl, config.active.baseUrl);
});

test('plugin apply registers tools without spawning when disabled', () => {
  const registered = [];
  const fake = {
    effect(fn) { return fn(); },
    inject(_names, cb) {
      cb({
        get(name) {
          if (name === 'tools') return { register: (tool) => registered.push(tool) };
          return null;
        },
        on() { return () => {}; },
        effect(fn) { return fn(); },
      });
    },
    get() { return undefined; },
    on() { return () => {}; },
  };
  apply(fake, { enabled: false, baseUrl: 'http://127.0.0.1:4600', toolsEnabled: true });
  assert.deepEqual(
    registered.map((tool) => tool.name),
    ['haos_instance_info', 'haos_notify', 'haos_report', 'haos_org', 'haos_delegate', 'haos_task', 'haos_workspace'],
  );
});
