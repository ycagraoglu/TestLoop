import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireFixture } from './fixture-acquisition.js';
import { buildFixturePlan } from './fixture-planner.js';
import { executeHttp } from './http.js';
import { capturePaths, interpolatePath } from './object-path.js';
import { redactRequest, redactValue } from './redaction.js';
import { runRole } from './role-runner.js';
import { expectedStatusesFor } from './verification-config.js';
import { classifyExecution } from './workflow.js';

export async function runScenario(scenario, context) {
  const fixtures = await resolveFixtures(scenario, context);
  const fixturePlan = createFixturePlan(scenario, fixtures);
  await context.store.write(`${scenario.id}.fixture.json`, redactValue(fixturePlan));

  if (fixturePlan.status !== 'READY') return blockedScenario(scenario, fixturePlan);

  const request = createRequest(scenario, context, fixturePlan.payload);
  const response = await executeRequest(request, scenario, context, true);
  const expectedStatuses = expectedStatusesFor(scenario);
  const classification = classifyExecution({
    expectedStatuses,
    actualStatus: response.status,
    fixtureVerified: true,
    authVerified: context.auth.type !== 'blocked',
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
      maxCreationDepth: context.maxCreationDepth,
      createEntity: context.createEntity
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
  const rawUrl = new URL(scenario.path, context.config.baseUrl).toString();
  return {
    method: scenario.method,
    url: interpolatePath(rawUrl, { ...context.outputs, ...(scenario.pathParameters ?? {}) }),
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
  const artifact = persistRequest ? { request: redactRequest(request), response: redactValue(response) } : redactValue(response);
  await context.store.write(name, artifact);
  return response;
}

async function handleFailure({ scenario, request, response, fixturePlan, classification, expectedStatuses, context }) {
  if (classification !== 'APPLICATION_BUG' || !context.config.roles?.diagnose) {
    return { id: scenario.id, status: classification === 'INCONCLUSIVE' ? 'BLOCKED' : 'FAIL', classification, response, reason: `Unexpected HTTP ${response.status}.` };
  }

  const diagnosis = await runAndStoreRole('diagnose', scenario, { scenario, request: redactRequest(request), response: redactValue(response), fixturePlan: redactValue(fixturePlan) }, context);
  if (diagnosis.status !== 'APPLICATION_BUG') {
    return { id: scenario.id, status: diagnosis.status === 'EXPECTED_REJECTION' ? 'PASS' : 'BLOCKED', classification: diagnosis.status, response, diagnosis };
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

  const retest = await executeRequest(request, scenario, context, false);
  return expectedStatuses.includes(retest.status)
    ? { id: scenario.id, status: 'PASS', classification: 'PASS_AFTER_FIX', response: retest, diagnosis, fix, review }
    : { id: scenario.id, status: 'FAIL', classification: 'RETEST_FAILED', response: retest, diagnosis, fix, review };
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

function blockedScenario(scenario, fixturePlan) {
  return { id: scenario.id, status: 'BLOCKED', reason: fixturePlan.blocked.map(item => item.reason).join(' '), fixturePlan };
}
