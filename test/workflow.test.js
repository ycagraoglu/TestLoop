import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFixtureGate, classifyExecution, createWorkflowState, transitionWorkflow } from '../src/workflow.js';

test('enforces gated happy path', () => {
  let workflow = createWorkflowState({ runId: 'run-1', target: 'POST /api/products' });
  for (const outcome of ['SUCCESS', 'SUCCESS', 'SUCCESS', 'SUCCESS', 'SUCCESS', 'PASS']) {
    workflow = transitionWorkflow(workflow, outcome);
  }
  assert.equal(workflow.state, 'COMPLETE');
  assert.equal(workflow.status, 'COMPLETE');
});

test('rejects random or unverified foreign key fixtures', () => {
  assert.throws(() => assertFixtureGate({ dependencies: [
    { property: 'CategoryId', source: 'random', verified: false }
  ] }), /CategoryId/);
});

test('classifies failures without false application bugs', () => {
  assert.equal(classifyExecution({ expectedStatuses: [201], actualStatus: 400, fixtureVerified: false, authVerified: true, environmentHealthy: true }), 'FIXTURE_ERROR');
  assert.equal(classifyExecution({ expectedStatuses: [201], actualStatus: 500, fixtureVerified: true, authVerified: true, environmentHealthy: true }), 'APPLICATION_BUG');
});

test('escalates when fix budget is exceeded', () => {
  let workflow = createWorkflowState({ runId: 'run-2', target: 'POST /api/products', budgets: { maxFixAttempts: 0 } });
  workflow = { ...workflow, state: 'FIX' };
  workflow = transitionWorkflow(workflow, 'SUCCESS', { agentCall: true });
  assert.equal(workflow.state, 'ESCALATED');
});
