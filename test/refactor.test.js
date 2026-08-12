import assert from 'node:assert/strict';
import test from 'node:test';
import { capturePaths, interpolatePath, readPath } from '../src/object-path.js';
import { redactAuth, redactValue } from '../src/redaction.js';
import { expectedStatusesFor, validateVerificationConfig } from '../src/verification-config.js';

test('object path utilities share one deterministic implementation', () => {
  const value = { data: { item: { id: '42' } } };
  assert.equal(readPath(value, 'data.item.id'), '42');
  assert.equal(interpolatePath('/api/items/{data.item.id}', value), '/api/items/42');
  assert.deepEqual(capturePaths(value, { itemId: 'data.item.id' }), { itemId: '42' });
});

test('redaction handles authorization headers case-insensitively without mutating input', () => {
  const headers = { Authorization: 'Bearer secret', accept: 'application/json' };
  assert.deepEqual(redactValue(headers), { Authorization: '[REDACTED]', accept: 'application/json' });
  assert.equal(headers.Authorization, 'Bearer secret');
  assert.equal(redactValue({ headers }).headers.Authorization, '[REDACTED]');
  assert.equal(redactAuth({ headers, response: { token: 'secret' } }).response, undefined);
});

test('verification configuration keeps only current MVP validation rules', () => {
  const config = { baseUrl: 'http://localhost', scenarios: [{ id: 'health', method: 'GET', path: '/health' }] };
  assert.equal(validateVerificationConfig(config), config);
  assert.deepEqual(expectedStatusesFor(config.scenarios[0]), [200, 202, 204]);
  assert.deepEqual(expectedStatusesFor({ method: 'POST' }), [200, 201, 202, 204]);
  assert.throws(() => validateVerificationConfig({ baseUrl: 'http://localhost', scenarios: [] }), /At least one/);
});

test('rejects config shapes the schema documents but the old validator let through', () => {
  const base = { baseUrl: 'http://localhost', scenarios: [{ id: 'health', method: 'GET', path: '/health' }] };
  assert.throws(() => validateVerificationConfig({ ...base, mode: 'thorough' }), /mode must be one of/);
  assert.throws(() => validateVerificationConfig({ ...base, stopOnFailure: 'yes' }), /stopOnFailure must be a boolean/);
  assert.throws(() => validateVerificationConfig({ ...base, requireApproval: 'no' }), /requireApproval must be a boolean/);
  assert.throws(() => validateVerificationConfig({ ...base, maxCreationDepth: 99 }), /maxCreationDepth must be/);
  assert.throws(
    () => validateVerificationConfig({ baseUrl: 'http://localhost', scenarios: [{ id: 'x', method: 'FETCH', path: '/x' }] }),
    /invalid method/
  );
  assert.throws(
    () => validateVerificationConfig({ baseUrl: 'http://localhost', scenarios: [{ id: 'x', method: 'GET', path: '/x', expectedStatuses: [999] }] }),
    /invalid expectedStatuses/
  );
  assert.equal(validateVerificationConfig({ ...base, mode: 'deep', requireApproval: false, maxCreationDepth: 5 }).mode, 'deep');
});
