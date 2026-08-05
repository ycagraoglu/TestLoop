import assert from 'node:assert/strict';
import test from 'node:test';
import { redactValue } from '../src/redaction.js';
import { assertAllowedCommand, assertAllowedUrl, buildRestrictedEnvironment, createSecurityPolicy } from '../src/security-policy.js';

const lockedPolicy = createSecurityPolicy({ allowedHosts: ['api.example.com'], allowedCommands: ['node'] });

test('redacts nested secrets without changing public fields', () => {
  const value = redactValue({
    authorization: 'Bearer secret',
    nested: { password: 'p', apiKey: 'k', name: 'visible' },
    items: [{ refreshToken: 'r' }]
  });
  assert.equal(value.authorization, '[REDACTED]');
  assert.equal(value.nested.password, '[REDACTED]');
  assert.equal(value.nested.apiKey, '[REDACTED]');
  assert.equal(value.nested.name, 'visible');
  assert.equal(value.items[0].refreshToken, '[REDACTED]');
});

test('blocks private URLs and credentials by default', () => {
  assert.throws(() => assertAllowedUrl('http://127.0.0.1:5000', lockedPolicy), /private or loopback/);
  assert.throws(() => assertAllowedUrl('https://user:pass@api.example.com', lockedPolicy), /credentials/);
  assert.doesNotThrow(() => assertAllowedUrl('https://api.example.com/v1', lockedPolicy));
});

test('requires array commands and an explicit allowlist', () => {
  assert.throws(() => assertAllowedCommand('node script.js', lockedPolicy), /string array/);
  assert.throws(() => assertAllowedCommand(['bash', '-c', 'echo hi'], lockedPolicy), /not allowlisted/);
  assert.doesNotThrow(() => assertAllowedCommand(['node', 'agent.js'], lockedPolicy));
});

test('inherits only explicitly selected environment variables', () => {
  const environment = buildRestrictedEnvironment(createSecurityPolicy({ inheritedEnv: [] }), { TESTLOOP_ROLE: 'review' });
  assert.deepEqual(environment, { TESTLOOP_ROLE: 'review' });
});
