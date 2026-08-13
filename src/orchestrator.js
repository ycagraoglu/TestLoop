import { ArtifactStore } from './artifact-store.js';
import { resolveAuthContext } from './auth.js';
import { redactAuth, redactConfig } from './redaction.js';
import { runScenario } from './scenario-runner.js';
import { createSecurityPolicy } from './security-policy.js';
import { validateVerificationConfig } from './verification-config.js';

export async function runVerification(config, dependencies = {}) {
  validateVerificationConfig(config);

  const securityPolicy = createSecurityPolicy(config.security);
  const store = dependencies.store ?? new ArtifactStore(config.root ?? process.cwd(), config.runId);
  await store.initialize({ mode: config.mode ?? 'standard', baseUrl: config.baseUrl });
  // Persisted so `testloop resume` can reload it in a later process. `{ "$env": "..." }` pointers
  // survive; anything literal under a sensitive key is stripped before it reaches disk.
  await store.write('config.json', redactConfig(config));

  const auth = await resolveAuthContext(config.auth ?? { type: 'none' }, securityPolicy);
  await store.write('auth.json', redactAuth(auth));
  if (auth.status === 'BLOCKED') return completeRun(store, 'BLOCKED', [], [auth.reason]);

  const context = createContext(config, auth, store, securityPolicy);
  const { results, blockers } = await runScenarios(config, context, config.scenarios);

  return completeRun(store, summarizeStatus(results, blockers), results, blockers);
}

export function createContext(config, auth, store, securityPolicy) {
  return {
    config,
    auth,
    outputs: {},
    store,
    securityPolicy,
    entityCache: new Map(),
    maxCreationDepth: config.maxCreationDepth ?? 3
  };
}

// Shared by runVerification (starts at scenario 0) and `testloop resume` (starts after the
// scenario it just resolved), so both walk the same loop with the same stop/output-capture rules.
export async function runScenarios(config, context, scenarios) {
  const results = [];
  const blockers = [];

  for (const scenario of scenarios) {
    // Role adapters are external processes: a bad status, a timeout or a non-zero exit throws.
    // That must cost one scenario, not the whole run's evidence trail (summary.json is only
    // written once the loop returns).
    const result = await runScenario(scenario, context).catch(error => runnerError(scenario.id, error));
    results.push(result);
    if (result.output) context.outputs[scenario.id] = result.output;
    if (result.status === 'BLOCKED') blockers.push(`${scenario.id}: ${result.reason}`);
    if (shouldStop(config, result)) break;
  }

  return { results, blockers };
}

export function runnerError(scenarioId, error) {
  return { id: scenarioId, status: 'ESCALATED', classification: 'RUNNER_ERROR', reason: error.message };
}

export function shouldStop(config, result) {
  return config.stopOnFailure !== false && ['FAIL', 'ESCALATED', 'AWAITING_APPROVAL'].includes(result.status);
}

export function summarizeStatus(results, blockers) {
  if (results.some(result => result.status === 'AWAITING_APPROVAL')) return 'AWAITING_APPROVAL';
  if (results.some(result => ['FAIL', 'ESCALATED'].includes(result.status))) return 'FAIL';
  if (results.some(result => result.status === 'SPEC_MISMATCH')) return 'SPEC_MISMATCH';
  if (blockers.length > 0) return 'BLOCKED';
  return 'PASS';
}

async function completeRun(store, status, results, blockers) {
  const summary = { status, results, blockers };
  await store.complete(summary);
  return { runId: store.runId, artifactDirectory: store.directory, ...summary };
}
