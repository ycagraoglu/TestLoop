import { ArtifactStore } from './artifact-store.js';
import { resolveAuthContext } from './auth.js';
import { redactAuth } from './redaction.js';
import { runScenario } from './scenario-runner.js';
import { createSecurityPolicy } from './security-policy.js';
import { validateVerificationConfig } from './verification-config.js';

export async function runVerification(config, dependencies = {}) {
  validateVerificationConfig(config);

  const securityPolicy = createSecurityPolicy(config.security);
  const store = dependencies.store ?? new ArtifactStore(config.root ?? process.cwd(), config.runId);
  await store.initialize({ mode: config.mode ?? 'standard', baseUrl: config.baseUrl });
  // Persisted verbatim (not redacted) so `testloop resume` can reload it in a later process.
  // No inline secrets should ever be present here: auth bodies must use `{ "$env": "..." }` references.
  await store.write('config.json', config);

  const auth = await resolveAuthContext(config.auth ?? { type: 'none' }, securityPolicy);
  await store.write('auth.json', redactAuth(auth));
  if (auth.status === 'BLOCKED') return completeRun(store, 'BLOCKED', [], [auth.reason]);

  const context = {
    config,
    auth,
    outputs: {},
    store,
    securityPolicy,
    entityCache: new Map(),
    maxCreationDepth: config.maxCreationDepth ?? 3
  };
  const results = [];
  const blockers = [];

  for (const scenario of config.scenarios) {
    const result = await runScenario(scenario, context);
    results.push(result);
    if (result.output) context.outputs[scenario.id] = result.output;
    if (result.status === 'BLOCKED') blockers.push(`${scenario.id}: ${result.reason}`);
    if (shouldStop(config, result)) break;
  }

  return completeRun(store, summarizeStatus(results, blockers), results, blockers);
}

function shouldStop(config, result) {
  return config.stopOnFailure !== false && ['FAIL', 'ESCALATED', 'AWAITING_APPROVAL'].includes(result.status);
}

export function summarizeStatus(results, blockers) {
  if (results.some(result => result.status === 'AWAITING_APPROVAL')) return 'AWAITING_APPROVAL';
  if (results.some(result => ['FAIL', 'ESCALATED'].includes(result.status))) return 'FAIL';
  if (blockers.length > 0) return 'BLOCKED';
  return 'PASS';
}

async function completeRun(store, status, results, blockers) {
  const summary = { status, results, blockers };
  await store.complete(summary);
  return { runId: store.runId, artifactDirectory: store.directory, ...summary };
}
