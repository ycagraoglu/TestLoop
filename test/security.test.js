import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { executeHttp } from '../src/http.js';
import { redactConfig, redactValue } from '../src/redaction.js';
import { validateVerificationConfig } from '../src/verification-config.js';
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

test('keeps $env pointers in the persisted config but never a literal secret', () => {
  const config = {
    auth: { type: 'login', url: 'https://api.example.com/token', body: { email: { $env: 'LOGIN_EMAIL' }, password: { $env: 'LOGIN_PASSWORD' } } },
    scenarios: [{ id: 'x', headers: { authorization: 'Bearer leaked-literal' }, body: { name: 'Widget', apiKey: 'literal-key' } }]
  };
  const persisted = redactConfig(config);

  assert.deepEqual(persisted.auth.body.password, { $env: 'LOGIN_PASSWORD' }, 'resume needs the pointer to survive');
  assert.deepEqual(persisted.auth.body.email, { $env: 'LOGIN_EMAIL' });
  assert.equal(persisted.scenarios[0].headers.authorization, '[REDACTED]');
  assert.equal(persisted.scenarios[0].body.apiKey, '[REDACTED]');
  assert.equal(persisted.scenarios[0].body.name, 'Widget', 'non-secret fields stay readable as evidence');
  assert.equal(JSON.stringify(persisted).includes('leaked-literal'), false);
  assert.equal(JSON.stringify(persisted).includes('literal-key'), false);
});

test('refuses a run configured with an inline credential', () => {
  const base = { baseUrl: 'http://localhost', scenarios: [{ id: 'x', method: 'GET', path: '/x' }] };
  assert.throws(
    () => validateVerificationConfig({ ...base, auth: { type: 'login', url: 'http://localhost/token', body: { email: 'a@b.c', password: 'S3cret!' } } }),
    /auth\.body\.password must not hold an inline secret/
  );
  assert.doesNotThrow(
    () => validateVerificationConfig({ ...base, auth: { type: 'login', url: 'http://localhost/token', body: { email: 'a@b.c', password: { $env: 'PW' } } } })
  );
});

test('refuses a credential hidden inside a plain-string body, where key checks cannot see it', () => {
  const base = { baseUrl: 'http://localhost', scenarios: [{ id: 'x', method: 'GET', path: '/x' }] };
  const withBody = body => ({ ...base, auth: { type: 'login', url: 'http://localhost/connect/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body } });

  assert.throws(
    () => validateVerificationConfig(withBody('grant_type=password&username=admin&password=S3cret!')),
    /auth\.body embeds a credential in a plain string/
  );
  assert.throws(
    () => validateVerificationConfig(withBody('grant_type=client_credentials&client_id=x&client_secret=abc123')),
    /embeds a credential/
  );
  assert.throws(
    () => validateVerificationConfig({ ...base, auth: { type: 'login', url: 'http://localhost/token?access_token=leaked', body: {} } }),
    /auth\.url embeds a credential/
  );
});

test('does not mistake credential-shaped words for credentials', () => {
  const base = { baseUrl: 'http://localhost', scenarios: [{ id: 'x', method: 'GET', path: '/x' }] };
  // "password" as a grant name, a token endpoint path, and tokenPath naming a response field are all
  // legitimate: none of them is a secret followed by a value.
  assert.doesNotThrow(() => validateVerificationConfig({
    ...base,
    auth: {
      type: 'login',
      url: 'https://id.corp.com/connect/token',
      body: 'grant_type=password',
      tokenPath: 'access_token'
    }
  }));
});

test('strips an embedded credential from a persisted string, not just from keyed fields', () => {
  const persisted = redactConfig({
    scenarios: [{ id: 'x', body: 'username=admin&password=S3cret!', path: '/api/products' }]
  });
  assert.equal(persisted.scenarios[0].body, '[REDACTED]');
  assert.equal(persisted.scenarios[0].path, '/api/products', 'ordinary strings are untouched');
});
