import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireFixture } from './fixture-acquisition.js';
import { resolveAuthContext } from './auth.js';
import { buildFixturePlan } from './fixture-planner.js';
import { executeHttp } from './http.js';
import { capturePaths, interpolatePath } from './object-path.js';
import { redactValue } from './redaction.js';
import { runRole } from './role-runner.js';
import { expectedStatusesFor } from './verification-config.js';
import { classifyExecution } from './workflow.js';

export async function runScenario(scenario, context) {
  const fixtures = await resolveFixtures(scenario, context);
  const fixturePlan = createFixturePlan(scenario, fixtures);
  await context.store.write(`${scenario.id}.fixture.json`, redactValue(fixturePlan));

  if (fixturePlan.status !== 'READY') return blockedScenario(scenario, fixturePlan);

  let request;
  try {
    request = createRequest(scenario, context, fixturePlan.payload);
  } catch (error) {
    if (error.code !== 'PATH_UNRESOLVED') throw error;
    return {
      id: scenario.id,
      status: 'BLOCKED',
      classification: 'UNRESOLVED_DEPENDENCY',
      reason: `${error.message}. The producing scenario did not run, was skipped, or captured no output.`
    };
  }

  const response = await executeRequest(request, scenario, context, true);
  const expectedStatuses = expectedStatusesFor(scenario);
  const classification = classifyExecution({
    expectedStatuses,
    actualStatus: response.status,
    fixtureVerified: true,
    environmentHealthy: true
  });

  if (classification === 'PASS') {
    return { id: scenario.id, status: 'PASS', classification, response, output: capturePaths(response.body, scenario.capture) };
  }

  return handleFailure({ scenario, request, response, fixturePlan, classification, expectedStatuses, context });
}

async function resolveFixtures(scenario, context) {
  const fixtures = { ...(scenario.fixtures ?? {}) };
  for (const requirement of scenario.requestModel?.dependencies ?? []) {
    if (fixtures[requirement.property] || fixtures[requirement.entity]) continue;
    const sources = scenario.fixtureSources?.[requirement.property] ?? scenario.fixtureSources?.[requirement.entity] ?? [];
    const acquired = await acquireFixture(requirement, sources, {
      headers: context.auth.headers,
      outputs: context.outputs,
      securityPolicy: context.securityPolicy,
      entityCache: context.entityCache,
      maxCreationDepth: context.maxCreationDepth
    });
    if (acquired.verified) fixtures[requirement.property] = acquired;
  }
  return fixtures;
}

function createFixturePlan(scenario, reusableFixtures) {
  if (!scenario.requestModel) return { status: 'READY', payload: scenario.body, fixtureManifest: { dependencies: [] }, blocked: [] };
  return buildFixturePlan({ requestModel: scenario.requestModel, validator: scenario.validator, supplied: scenario.body ?? {}, reusableFixtures });
}

function createRequest(scenario, context, body) {
  // Interpolate {scenario.captured} placeholders on the raw path template BEFORE handing it to
  // URL(): the URL parser percent-encodes literal { and } on the way in, so a placeholder search
  // run afterward on the constructed URL string would never find anything to replace.
  const interpolatedPath = interpolatePath(scenario.path, { ...context.outputs, ...(scenario.pathParameters ?? {}) });
  return {
    method: scenario.method,
    url: new URL(interpolatedPath, context.config.baseUrl).toString(),
    headers: { ...context.auth.headers, ...(scenario.headers ?? {}) },
    body
  };
}

async function executeRequest(request, scenario, context, persistRequest) {
  const response = await executeHttp(request, {
    timeoutMs: scenario.timeoutMs ?? context.config.timeoutMs ?? 30000,
    securityPolicy: context.securityPolicy,
    purpose: 'scenario'
  });
  const name = persistRequest ? `${scenario.id}.execution.json` : `${scenario.id}.retest.json`;
  const artifact = persistRequest ? { request: redactValue(request), response: redactValue(response) } : redactValue(response);
  await context.store.write(name, artifact);
  return response;
}

async function handleFailure({ scenario, request, response, fixturePlan, classification, expectedStatuses, context }) {
  if (classification !== 'APPLICATION_BUG' || !context.config.roles?.diagnose) {
    return {
      id: scenario.id,
      status: PRECONDITION_CLASSIFICATIONS.has(classification) ? 'BLOCKED' : 'FAIL',
      classification,
      response,
      reason: failureReason(classification, response.status)
    };
  }

  const diagnosis = await runAndStoreRole('diagnose', scenario, { scenario, request: redactValue(request), response: redactValue(response), fixturePlan: redactValue(fixturePlan) }, context);
  if (diagnosis.status !== 'APPLICATION_BUG') {
    return { id: scenario.id, status: diagnosisResultStatus(diagnosis.status), classification: diagnosis.status, response, diagnosis };
  }

  // smoke reports defects, it never repairs them, so it stops short of both the approval gate
  // and the fix chain.
  if (context.config.mode === 'smoke') {
    return {
      id: scenario.id,
      status: 'FAIL',
      classification: diagnosis.status,
      response,
      diagnosis,
      reason: 'Confirmed application bug. smoke mode reports defects without repairing them.'
    };
  }

  // By default a confirmed application defect stops the run here: TestLoop never invokes the fix role
  // on its own initiative. A human must approve via `testloop resume <run-id> <scenario-id> approve`
  // (or decline it, which marks the scenario SKIPPED) before the fix/review/retest chain continues.
  // Setting `requireApproval: false` opts out of the gate and fixes immediately.
  if (context.config.requireApproval === false) {
    return runApprovedFix({ scenario, diagnosis, request, expectedStatuses, context });
  }

  await context.store.write(`${scenario.id}.resume-state.json`, { request, expectedStatuses });
  return {
    id: scenario.id,
    status: 'AWAITING_APPROVAL',
    classification: diagnosis.status,
    response,
    diagnosis,
    reason: 'Confirmed application bug. Awaiting human approval before invoking the fix agent.',
    resumeHint: `testloop resume <run-id> ${scenario.id} approve|decline`
  };
}

export async function runApprovedFix({ scenario, diagnosis, request, expectedStatuses, context }) {
  const projectInstructions = await readProjectInstructions(context.config.root ?? process.cwd());
  const fix = await runAndStoreRole('fix', scenario, { scenario, diagnosis, projectInstructions }, context);
  if (fix.status !== 'SUCCESS') return { id: scenario.id, status: 'ESCALATED', diagnosis, fix };

  const review = await runAndStoreRole('review', scenario, { scenario, diagnosis, fix }, context);
  if (review.status !== 'APPROVED') return { id: scenario.id, status: 'ESCALATED', diagnosis, fix, review };

  // Re-resolve auth here rather than trusting the caller's `request`: fix + review can be slow,
  // real external agent calls, and a short-lived token captured before diagnosis may have expired.
  const auth = await resolveAuthContext(context.config.auth ?? { type: 'none' }, context.securityPolicy);
  const retestRequest = { ...request, headers: { ...request.headers, ...auth.headers } };
  const retest = await executeRequest(retestRequest, scenario, context, false);
  const outcome = classifyExecution({
    expectedStatuses,
    actualStatus: retest.status,
    fixtureVerified: true,
    environmentHealthy: true
  });

  if (outcome === 'PASS') {
    return { id: scenario.id, status: 'PASS', classification: 'PASS_AFTER_FIX', response: retest, diagnosis, fix, review, output: capturePaths(retest.body, scenario.capture) };
  }

  if (outcome === 'APPLICATION_BUG') {
    return { id: scenario.id, status: 'FAIL', classification: 'RETEST_FAILED', response: retest, diagnosis, fix, review, reason: `The retest still failed with HTTP ${retest.status}.` };
  }

  // The retest neither met the expectation nor reproduced the defect, so it proves nothing either
  // way. Its preconditions moved underneath it -- an entity created earlier in the run is gone if
  // the fix restarted an application whose state does not survive a restart, and the replayed
  // request now points at nothing. Calling that FAIL would assert the fix did not work, which this
  // evidence cannot support.
  return {
    id: scenario.id,
    status: 'BLOCKED',
    classification: 'RETEST_INCONCLUSIVE',
    response: retest,
    diagnosis,
    fix,
    review,
    reason: `The retest returned HTTP ${retest.status}, which neither meets the expectation nor reproduces the defect. The scenario's preconditions no longer hold, so the fix could not be judged.`
  };
}

// ponytail: root-level only, no nested skills/*/SKILL.md scan; broaden if projects keep rules elsewhere.
async function readProjectInstructions(root) {
  const found = await Promise.all(['AGENTS.md', 'SKILL.md'].map(async file => {
    try { return { file, content: await readFile(path.join(root, file), 'utf8') }; }
    catch { return null; }
  }));
  const present = found.filter(Boolean);
  return present.length > 0 ? present : null;
}

async function runAndStoreRole(role, scenario, input, context) {
  const result = await runRole(role, input, context.config.roles, context.securityPolicy);
  await context.store.write(`${scenario.id}.${role}.json`, redactValue(result));
  return result;
}

// An unmet precondition is never the application's fault, so it is reported as BLOCKED rather than
// as a failure. This is the trust rule: TestLoop says "I could not establish this" instead of
// blaming code it never managed to exercise properly.
const PRECONDITION_CLASSIFICATIONS = new Set(['AUTH_ERROR', 'FIXTURE_ERROR', 'ENVIRONMENT_ERROR', 'INCONCLUSIVE']);

function failureReason(classification, status) {
  if (classification === 'AUTH_ERROR') {
    return `HTTP ${status} although the authentication context resolved successfully. The token may have expired mid-run, or it lacks the role or scope this endpoint requires.`;
  }
  return `Unexpected HTTP ${status}.`;
}

// A diagnosis that is not APPLICATION_BUG ends the scenario without repair. EXPECTED_REJECTION means
// the API was right to refuse; SPEC_MISMATCH is a reportable finding in its own right (docs: REPORT);
// everything else means the evidence could not support a verdict, which is BLOCKED, never FAIL.
function diagnosisResultStatus(status) {
  if (status === 'EXPECTED_REJECTION') return 'PASS';
  if (status === 'SPEC_MISMATCH') return 'SPEC_MISMATCH';
  return 'BLOCKED';
}

function blockedScenario(scenario, fixturePlan) {
  return { id: scenario.id, status: 'BLOCKED', reason: fixturePlan.blocked.map(item => item.reason).join(' '), fixturePlan };
}
