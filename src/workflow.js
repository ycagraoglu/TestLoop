export const STATES = Object.freeze({
  DISCOVER: 'DISCOVER',
  ANALYZE: 'ANALYZE',
  PLAN: 'PLAN',
  RESOLVE_FIXTURES: 'RESOLVE_FIXTURES',
  EXECUTE: 'EXECUTE',
  VERIFY: 'VERIFY',
  DIAGNOSE: 'DIAGNOSE',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  FIX: 'FIX',
  REVIEW: 'REVIEW',
  RETEST: 'RETEST',
  COMPLETE: 'COMPLETE',
  BLOCKED: 'BLOCKED',
  SKIPPED: 'SKIPPED',
  ESCALATED: 'ESCALATED'
});

const TRANSITIONS = Object.freeze({
  DISCOVER: { SUCCESS: 'ANALYZE', BLOCKED: 'BLOCKED' },
  ANALYZE: { SUCCESS: 'PLAN', BLOCKED: 'BLOCKED' },
  PLAN: { SUCCESS: 'RESOLVE_FIXTURES', BLOCKED: 'BLOCKED' },
  RESOLVE_FIXTURES: { SUCCESS: 'EXECUTE', BLOCKED: 'BLOCKED', INCONCLUSIVE: 'BLOCKED' },
  EXECUTE: { SUCCESS: 'VERIFY', FAILURE: 'DIAGNOSE', BLOCKED: 'BLOCKED' },
  VERIFY: { PASS: 'COMPLETE', FAILURE: 'DIAGNOSE', BLOCKED: 'BLOCKED', INCONCLUSIVE: 'BLOCKED' },
  DIAGNOSE: {
    FIXTURE_ERROR: 'RESOLVE_FIXTURES',
    AUTH_ERROR: 'RESOLVE_FIXTURES',
    ENVIRONMENT_ERROR: 'BLOCKED',
    EXPECTED_REJECTION: 'COMPLETE',
    APPLICATION_BUG: 'AWAITING_APPROVAL',
    INCONCLUSIVE: 'BLOCKED'
  },
  AWAITING_APPROVAL: { APPROVED: 'FIX', DECLINED: 'SKIPPED' },
  FIX: { SUCCESS: 'REVIEW', FAILURE: 'ESCALATED' },
  REVIEW: { APPROVED: 'RETEST', CHANGES_REQUESTED: 'FIX', REJECTED: 'ESCALATED' },
  RETEST: { PASS: 'COMPLETE', FAILURE: 'DIAGNOSE', BLOCKED: 'BLOCKED' }
});

export function createWorkflowState({ runId, target, budgets = {} }) {
  return {
    runId,
    target,
    state: STATES.DISCOVER,
    status: 'RUNNING',
    attempts: { diagnosis: 0, fix: 0, review: 0, retest: 0, agentCalls: 0 },
    budgets: {
      maxDiagnosisAttempts: budgets.maxDiagnosisAttempts ?? 2,
      maxFixAttempts: budgets.maxFixAttempts ?? 2,
      maxReviewAttempts: budgets.maxReviewAttempts ?? 2,
      maxRetestAttempts: budgets.maxRetestAttempts ?? 2,
      maxAgentCalls: budgets.maxAgentCalls ?? 8
    },
    history: []
  };
}

export function transitionWorkflow(workflow, outcome, evidence = {}) {
  assertWorkflow(workflow);
  const next = TRANSITIONS[workflow.state]?.[outcome];
  if (!next) throw new Error(`Transition not allowed: ${workflow.state} + ${outcome}`);

  const attempts = { ...workflow.attempts };
  if (workflow.state === STATES.DIAGNOSE) attempts.diagnosis += 1;
  if (workflow.state === STATES.FIX) attempts.fix += 1;
  if (workflow.state === STATES.REVIEW) attempts.review += 1;
  if (workflow.state === STATES.RETEST) attempts.retest += 1;
  if (evidence.agentCall === true) attempts.agentCalls += 1;

  const limitedState = budgetExceeded(attempts, workflow.budgets) ? STATES.ESCALATED : next;
  return {
    ...workflow,
    state: limitedState,
    status: terminalStatus(limitedState),
    attempts,
    history: [...workflow.history, { from: workflow.state, outcome, to: limitedState, at: new Date().toISOString(), evidence }]
  };
}

export function assertFixtureGate(fixtureManifest) {
  if (!fixtureManifest || !Array.isArray(fixtureManifest.dependencies)) throw new Error('Fixture manifest is required.');
  const invalid = fixtureManifest.dependencies.filter(item => !item.verified || item.source === 'random');
  if (invalid.length > 0) {
    throw new Error(`Fixture gate failed for: ${invalid.map(item => item.property).join(', ')}`);
  }
  return true;
}

export function classifyExecution({ expectedStatuses, actualStatus, fixtureVerified, authVerified, environmentHealthy }) {
  if (!environmentHealthy) return 'ENVIRONMENT_ERROR';
  if (!authVerified && [401, 403].includes(actualStatus)) return 'AUTH_ERROR';
  if (!fixtureVerified && actualStatus >= 400) return 'FIXTURE_ERROR';
  if (expectedStatuses.includes(actualStatus)) return 'PASS';
  if (actualStatus >= 500) return 'APPLICATION_BUG';
  return 'INCONCLUSIVE';
}

function budgetExceeded(attempts, budgets) {
  return attempts.diagnosis > budgets.maxDiagnosisAttempts ||
    attempts.fix > budgets.maxFixAttempts ||
    attempts.review > budgets.maxReviewAttempts ||
    attempts.retest > budgets.maxRetestAttempts ||
    attempts.agentCalls > budgets.maxAgentCalls;
}

function terminalStatus(state) {
  if (state === STATES.COMPLETE) return 'COMPLETE';
  if (state === STATES.BLOCKED) return 'BLOCKED';
  if (state === STATES.ESCALATED) return 'ESCALATED';
  if (state === STATES.SKIPPED) return 'SKIPPED';
  if (state === STATES.AWAITING_APPROVAL) return 'AWAITING_APPROVAL';
  return 'RUNNING';
}

function assertWorkflow(workflow) {
  if (!workflow || !TRANSITIONS[workflow.state]) {
    if ([STATES.COMPLETE, STATES.BLOCKED, STATES.ESCALATED, STATES.SKIPPED].includes(workflow?.state)) throw new Error(`Workflow is terminal: ${workflow.state}`);
    throw new Error('Invalid workflow state.');
  }
}
