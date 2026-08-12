import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { executeHttp } from '../src/http.js';
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

test('blocks IPv6 private/loopback targets, including IPv4-mapped ones', () => {
  const openPolicy = createSecurityPolicy({});
  for (const url of ['http://[::1]:5099/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.0.0.5]/']) {
    assert.throws(() => assertAllowedUrl(url, openPolicy), /private or loopback/, url);
  }
  assert.doesNotThrow(() => assertAllowedUrl('http://[2001:4860:4860::8888]/', openPolicy));
  assert.doesNotThrow(() => assertAllowedUrl('http://[::ffff:8.8.8.8]/', openPolicy));
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

test('bounds memory for a chunked response with no content-length, instead of buffering it first', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200); // no content-length -> chunked transfer-encoding
    response.write('x'.repeat(50));
    setTimeout(() => response.write('x'.repeat(50)), 5); // arrives as a second chunk
    setTimeout(() => response.end(), 10);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const policy = createSecurityPolicy({ allowPrivateNetwork: true, maxResponseBytes: 60 });
    await assert.rejects(
      executeHttp({ method: 'GET', url: `http://127.0.0.1:${port}/` }, { securityPolicy: policy }),
      /exceeds 60 bytes/
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
