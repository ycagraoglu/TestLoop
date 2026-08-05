import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../src/artifact-store.js';
import { assertSafeEnvironment } from '../src/process-manager.js';
import { validateRoleResult } from '../src/role-runner.js';
import { buildTestPlan } from '../src/test-planner.js';

test('refuses production API lifecycle', () => {
  assert.throws(() => assertSafeEnvironment('Production'), /refuses/);
  assert.doesNotThrow(() => assertSafeEnvironment('Development'));
});

test('persists and reads structured run artifacts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'testloop-store-'));
  const store = await new ArtifactStore(root, 'run-1').initialize({ mode: 'standard' });
  await store.write('evidence.json', { verified: true });
  assert.deepEqual(await store.read('evidence.json'), { verified: true });
  await assert.rejects(store.write('../escape.json', {}), /safe/);
});

test('groups endpoint operations into feature lifecycles', () => {
  const plan = buildTestPlan({
    operations: [
      { method: 'GET', route: '/api/products/{id}', tags: ['Products'] },
      { method: 'DELETE', route: '/api/products/{id}', tags: ['Products'] },
      { method: 'POST', route: '/api/products', tags: ['Products'], requestBodyRequired: true }
    ]
  });
  assert.deepEqual(plan.groups[0].operations.map(x => x.method), ['POST', 'GET', 'DELETE']);
  assert.equal(plan.summary.destructive, 1);
});

test('enforces machine-readable role contracts', () => {
  assert.equal(validateRoleResult('diagnose', { status: 'APPLICATION_BUG' }), true);
  assert.throws(() => validateRoleResult('review', { status: 'PASS' }), /Invalid review/);
});
