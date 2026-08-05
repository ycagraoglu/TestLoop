import { ArtifactStore } from './artifact-store.js';
import { resolveAuthContext } from './auth.js';
import { redactAuth } from './redaction.js';
import { runScenario } from './scenario-runner.js';
import { validateVerificationConfig } from './verification-config.js';

export async function runVerification(config, dependencies = {}) {
  validateVerificationConfig(config);

  const store = dependencies.store ?? new ArtifactStore(config.root ?? process.cwd(), config.runId);
  await store.initialize({ mode: config.mode ?? 'standard', baseUrl: config.baseUrl });

  const auth = await resolveAuthContext(config.auth ?? { type: 'none' });
  await store.write('auth.json', redactAuth(auth));
  if (auth.status === 'BLOCKED') return completeRun(store, 'BLOCKED', [], [auth.reason]);

  const context = {
    config,
    auth,
    outputs: {},
    store,
    dependencies
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
  return config.stopOnFailure !== false && ['FAIL', 'ESCALATED'].includes(result.status);
}

function summarizeStatus(results, blockers) {
  if (results.some(result => ['FAIL', 'ESCALATED'].includes(result.status))) return 'FAIL';
  if (blockers.length > 0) return 'BLOCKED';
  return 'PASS';
}

async function completeRun(store, status, results, blockers) {
  const summary = { status, results, blockers };
  await store.complete(summary);
  return { runId: store.runId, artifactDirectory: store.directory, ...summary };
}
