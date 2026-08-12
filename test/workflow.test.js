import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyExecution } from '../src/workflow.js';

test('classifies failures without false application bugs', () => {
  assert.equal(classifyExecution({ expectedStatuses: [201], actualStatus: 400, fixtureVerified: false, authVerified: true, environmentHealthy: true }), 'FIXTURE_ERROR');
  assert.equal(classifyExecution({ expectedStatuses: [201], actualStatus: 500, fixtureVerified: true, authVerified: true, environmentHealthy: true }), 'APPLICATION_BUG');
});

test('attributes a failure to its failed precondition before blaming the application', () => {
  const base = { expectedStatuses: [201], fixtureVerified: true, authVerified: true, environmentHealthy: true };
  assert.equal(classifyExecution({ ...base, actualStatus: 500, environmentHealthy: false }), 'ENVIRONMENT_ERROR');
  assert.equal(classifyExecution({ ...base, actualStatus: 401, authVerified: false }), 'AUTH_ERROR');
  assert.equal(classifyExecution({ ...base, actualStatus: 201 }), 'PASS');
  assert.equal(classifyExecution({ ...base, actualStatus: 404 }), 'INCONCLUSIVE');
});
