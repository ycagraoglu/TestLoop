import { ArtifactStore } from './artifact-store.js';
import { resolveAuthContext } from './auth.js';
import { acquireFixture } from './fixture-acquisition.js';
import { buildFixturePlan } from './fixture-planner.js';
import { executeHttp } from './http.js';
import { runRole } from './role-runner.js';
import { classifyExecution } from './workflow.js';

export async function runVerification(config, dependencies = {}) {
  validateConfig(config);
  const store = dependencies.store ?? new ArtifactStore(config.root ?? process.cwd(), config.runId);
  await store.initialize({ mode: config.mode ?? 'standard', baseUrl: config.baseUrl });

  const auth = await resolveAuthContext(config.auth ?? { type: 'none' });
  await store.write('auth.json', redactAuth(auth));
  if (auth.status === 'BLOCKED') return finish(store, 'BLOCKED', [], [auth.reason]);

  const results = [];
  const outputs = {};
  const blockers = [];

  for (const scenario of config.scenarios) {
    const result = await executeScenario(scenario, { config, auth, outputs, store, dependencies });
    results.push(result);
    if (result.output) outputs[scenario.id] = result.output;
    if (result.status === 'BLOCKED') blockers.push(`${scenario.id}: ${result.reason}`);
    if (config.stopOnFailure !== false && ['FAIL', 'ESCALATED'].includes(result.status)) break;
  }

  const status = results.some(x => x.status === 'FAIL' || x.status === 'ESCALATED')
    ? 'FAIL'
    : blockers.length > 0
      ? 'BLOCKED'
      : 'PASS';
  return finish(store, status, results, blockers);
}

async function executeScenario(scenario, context) {
  const { config, auth, outputs, store } = context;
  const reusableFixtures = { ...(scenario.fixtures ?? {}) };

  for (const requirement of scenario.requestModel?.dependencies ?? []) {
    if (reusableFixtures[requirement.property] || reusableFixtures[requirement.entity]) continue;
    const acquired = await acquireFixture(requirement, scenario.fixtureSources?.[requirement.property] ?? scenario.fixtureSources?.[requirement.entity] ?? [], {
      headers: auth.headers,
      outputs
    });
    if (acquired.verified) reusableFixtures[requirement.property] = acquired;
  }

  const fixturePlan = scenario.requestModel
    ? buildFixturePlan({
        requestModel: scenario.requestModel,
        validator: scenario.validator,
        supplied: scenario.body ?? {},
        reusableFixtures
      })
    : { status: 'READY', payload: scenario.body, fixtureManifest: { dependencies: [] }, blocked: [] };

  await store.write(`${scenario.id}.fixture.json`, fixturePlan);
  if (fixturePlan.status !== 'READY') {
    return { id: scenario.id, status: 'BLOCKED', reason: fixturePlan.blocked.map(x => x.reason).join(' '), fixturePlan };
  }

  const url = interpolate(new URL(scenario.path, config.baseUrl).toString(), { ...outputs, ...(scenario.pathParameters ?? {}) });
  const request = {
    method: scenario.method,
    url,
    headers: { ...auth.headers, ...(scenario.headers ?? {}) },
    body: fixturePlan.payload
  };
  const response = await executeHttp(request, { timeoutMs: scenario.timeoutMs ?? config.timeoutMs ?? 30000 });
  await store.write(`${scenario.id}.execution.json`, { request: redactRequest(request), response });

  const expectedStatuses = scenario.expectedStatuses ?? defaultExpectedStatuses(scenario.method);
  const classification = classifyExecution({
    expectedStatuses,
    actualStatus: response.status,
    fixtureVerified: true,
    authVerified: auth.type !== 'blocked',
    environmentHealthy: true
  });

  if (classification === 'PASS') {
    const output = captureOutput(response.body, scenario.capture ?? {});
    return { id: scenario.id, status: 'PASS', classification, response, output };
  }

  if (classification !== 'APPLICATION_BUG' || !config.roles?.diagnose) {
    return { id: scenario.id, status: classification === 'INCONCLUSIVE' ? 'BLOCKED' : 'FAIL', classification, response, reason: `Unexpected HTTP ${response.status}.` };
  }

  const diagnosis = await runRole('diagnose', { scenario, request: redactRequest(request), response, fixturePlan }, config.roles);
  await store.write(`${scenario.id}.diagnosis.json`, diagnosis);
  if (diagnosis.status !== 'APPLICATION_BUG') {
    return { id: scenario.id, status: diagnosis.status === 'EXPECTED_REJECTION' ? 'PASS' : 'BLOCKED', classification: diagnosis.status, response, diagnosis };
  }

  const fix = await runRole('fix', { scenario, diagnosis }, config.roles);
  await store.write(`${scenario.id}.fix.json`, fix);
  if (fix.status !== 'SUCCESS') return { id: scenario.id, status: 'ESCALATED', diagnosis, fix };

  const review = await runRole('review', { scenario, diagnosis, fix }, config.roles);
  await store.write(`${scenario.id}.review.json`, review);
  if (review.status !== 'APPROVED') return { id: scenario.id, status: 'ESCALATED', diagnosis, fix, review };

  const retest = await executeHttp(request, { timeoutMs: scenario.timeoutMs ?? config.timeoutMs ?? 30000 });
  await store.write(`${scenario.id}.retest.json`, retest);
  return expectedStatuses.includes(retest.status)
    ? { id: scenario.id, status: 'PASS', classification: 'PASS_AFTER_FIX', response: retest, diagnosis, fix, review }
    : { id: scenario.id, status: 'FAIL', classification: 'RETEST_FAILED', response: retest, diagnosis, fix, review };
}

async function finish(store, status, results, blockers) {
  const summary = { status, results, blockers };
  await store.complete(summary);
  return { runId: store.runId, artifactDirectory: store.directory, ...summary };
}

function validateConfig(config) {
  if (!config?.baseUrl) throw new Error('baseUrl is required.');
  if (!Array.isArray(config.scenarios) || config.scenarios.length === 0) throw new Error('At least one scenario is required.');
  for (const scenario of config.scenarios) {
    if (!scenario.id || !scenario.method || !scenario.path) throw new Error('Every scenario requires id, method, and path.');
  }
}

function interpolate(value, context) {
  return value.replace(/\{([^}]+)\}/g, (_, key) => {
    const resolved = readPath(context, key);
    if (resolved === undefined) throw new Error(`Path value was not resolved: ${key}`);
    return encodeURIComponent(String(resolved));
  });
}

function captureOutput(body, capture) {
  return Object.fromEntries(Object.entries(capture).map(([name, path]) => [name, readPath(body, path)]));
}

function readPath(value, path) {
  return String(path).split('.').reduce((current, part) => current?.[part], value);
}

function defaultExpectedStatuses(method) {
  return method === 'POST' ? [200, 201, 202, 204] : [200, 202, 204];
}

function redactAuth(auth) {
  return { ...auth, headers: auth.headers?.authorization ? { authorization: '[REDACTED]' } : auth.headers, response: undefined };
}

function redactRequest(request) {
  return { ...request, headers: request.headers?.authorization ? { ...request.headers, authorization: '[REDACTED]' } : request.headers };
}
