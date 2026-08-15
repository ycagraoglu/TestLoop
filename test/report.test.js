import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReport } from '../src/report.js';

const base = { config: { baseUrl: 'http://127.0.0.1:5099', mode: 'deep', openApiUrl: 'http://127.0.0.1:5099/openapi/v1.json', cleanup: true }, runId: 'run-1' };

test('leads with the verdict and what produced it', () => {
  const report = buildReport({
    ...base,
    status: 'FAIL',
    results: [
      { id: 'create-product', status: 'PASS', response: { status: 201 } },
      { id: 'update-product', status: 'FAIL', classification: 'RETEST_FAILED', response: { status: 500 }, reason: 'The retest still failed with HTTP 500.' }
    ]
  });

  assert.match(report, /# TestLoop run `run-1`/);
  assert.match(report, /\*\*FAIL\*\* — 2 scenarios: 1 passed, 1 fail\./);
  assert.match(report, /\| `create-product` \| `201` \| \*\*PASS\*\* \|/);
  assert.match(report, /update-product.*RETEST_FAILED/s);
});

test('reports what was changed, by whom it was approved, and what the sweep found', () => {
  const report = buildReport({
    ...base,
    status: 'PASS',
    results: [{
      id: 'update-product',
      status: 'PASS',
      classification: 'PASS_AFTER_FIX',
      response: { status: 200 },
      diagnosis: { summary: 'Dereferences an unloaded navigation.' },
      fix: { status: 'SUCCESS', summary: 'Include the Category navigation.', changedFiles: ['Controllers/ProductsController.cs'] },
      review: { status: 'APPROVED', summary: 'Single-file navigation load.' },
      regression: { checked: ['create-product', 'read-product'], broken: [] }
    }]
  });

  assert.match(report, /## Changes/);
  assert.match(report, /Dereferences an unloaded navigation/);
  assert.match(report, /Controllers\/ProductsController\.cs/);
  assert.match(report, /\*\*Review\*\*: APPROVED/);
  assert.match(report, /2 previously passing scenarios re-run, all still passing/);
});

test('names a repair that broke something else', () => {
  const report = buildReport({
    ...base,
    status: 'FAIL',
    results: [{
      id: 'scenario-b',
      status: 'FAIL',
      classification: 'REGRESSION_DETECTED',
      reason: 'The fix resolved scenario-b but broke scenario-a.',
      fix: { status: 'SUCCESS' },
      regression: { checked: ['scenario-a'], broken: [{ id: 'scenario-a', status: 'FAIL' }] }
    }]
  });

  assert.match(report, /Regression sweep\*\*: broke `scenario-a`/);
  assert.match(report, /## Remaining risks[\s\S]*broke scenario-a/);
});

test('states the limits of a green run rather than only its successes', () => {
  const report = buildReport({
    config: { baseUrl: 'http://x', mode: 'standard' },
    runId: 'run-2',
    status: 'PASS',
    results: [{ id: 'create-product', status: 'PASS', response: { status: 201 } }],
    created: [{ id: 'p1', collectionUrl: 'http://x/products' }]
  });

  assert.match(report, /1 record created by this run is still in the environment/, 'a pass that littered says so');
  assert.match(report, /Response shapes were not checked against a contract/);
  assert.match(report, /Refusals were not exercised/);
});

test('says plainly that nothing was verified when the run never started', () => {
  const report = buildReport({
    config: { baseUrl: 'http://x' },
    runId: 'run-3',
    status: 'BLOCKED',
    results: [],
    blockers: ['Login failed with HTTP 401.']
  });

  assert.match(report, /\*\*BLOCKED\*\* — 0 scenarios/);
  assert.match(report, /## Not verified[\s\S]*Login failed with HTTP 401/);
  assert.equal(report.includes('## Changes'), false, 'nothing was changed, so nothing is claimed');
});

test('surfaces a pending decision as an open risk with the command that resolves it', () => {
  const report = buildReport({
    ...base,
    status: 'AWAITING_APPROVAL',
    results: [{ id: 'update-product', status: 'AWAITING_APPROVAL', classification: 'APPLICATION_BUG', response: { status: 500 } }]
  });

  assert.match(report, /waiting on a decision.*testloop resume <run-id> update-product approve\|decline/);
});

test('quotes a contract violation instead of only naming it', () => {
  const report = buildReport({
    ...base,
    status: 'SPEC_MISMATCH',
    results: [{ id: 'list-categories', status: 'SPEC_MISMATCH', classification: 'SPEC_MISMATCH', response: { status: 200 }, violations: ['body: expected an array, received an object'] }]
  });

  assert.match(report, /breaks its published contract: body: expected an array, received an object/);
});
