import { ArtifactStore } from './artifact-store.js';
import { resolveAuthContext } from './auth.js';
import { redactValue } from './redaction.js';
import { checkForRegressions, createContext, loadContract, runnerError, runScenarios, shouldStop, summarizeStatus } from './orchestrator.js';
import { runApprovedFix } from './scenario-runner.js';
import { createSecurityPolicy } from './security-policy.js';

const DECISIONS = new Set(['approve', 'decline']);

export async function resumeVerification({ root = process.cwd(), runId, scenarioId, decision }) {
  if (!runId) throw new Error('runId is required.');
  if (!scenarioId) throw new Error('scenarioId is required.');
  if (!DECISIONS.has(decision)) throw new Error('decision must be "approve" or "decline".');

  const store = new ArtifactStore(root, runId);
  const config = await readRequired(store, 'config.json', `No persisted configuration found for run ${runId}.`);
  const diagnosis = await readOptional(store, `${scenarioId}.diagnose.json`);
  const pending = await readOptional(store, `${scenarioId}.resume-state.json`);
  const scenarioIndex = config.scenarios.findIndex(item => item.id === scenarioId);

  if (scenarioIndex === -1) throw new Error(`Scenario ${scenarioId} was not found in the persisted run configuration.`);
  if (!diagnosis || diagnosis.status !== 'APPLICATION_BUG' || !pending) {
    throw new Error(`Scenario ${scenarioId} has no pending approval in run ${runId}.`);
  }

  const securityPolicy = createSecurityPolicy(config.security);
  const auth = await resolveAuthContext(config.auth ?? { type: 'none' }, securityPolicy);
  const context = createContext(config, auth, store, securityPolicy);
  context.contract = await loadContract(config, securityPolicy);

  // Same reasoning as the scenario loop: a throwing fix/review role must not cost the run its
  // summary, and here it would also strand every scenario queued behind this one.
  const result = decision === 'decline'
    ? { id: scenarioId, status: 'SKIPPED', classification: 'DECLINED_BY_USER', diagnosis, reason: 'Human declined the confirmed application bug fix.' }
    : await runApprovedFix({ scenario: config.scenarios[scenarioIndex], diagnosis, request: pending.request, expectedStatuses: pending.expectedStatuses, context })
      .catch(error => runnerError(scenarioId, error));

  if (result.output) context.outputs[result.id] = result.output;
  const resolved = await continueRun({ store, config, context, scenarioIndex, result });
  await store.write(`${scenarioId}.resume.json`, redactValue(resolved));
  return resolved;
}

// Resuming resolves only the one scenario the run paused on. A human decision on that scenario
// shouldn't strand everything configured after it, so pick the original scenario loop back up
// from there too -- unless the resolved result itself says to stop, same rule the first run used.
async function continueRun({ store, config, context, scenarioIndex, result }) {
  const summary = await readOptional(store, 'summary.json');
  const priorResults = Array.isArray(summary?.results) ? summary.results : [];
  for (const item of priorResults) {
    if (item.output) context.outputs[item.id] = item.output;
  }

  // The approved fix ran outside the scenario loop, so its regression check has to be invoked here.
  const checked = await checkForRegressions({ config, context, result, priorResults });
  const results = priorResults.map(item => (item.id === checked.id ? checked : item));
  const blockers = [...(summary?.blockers ?? [])];

  if (!shouldStop(config, checked)) {
    const attempted = new Set(results.map(item => item.id));
    const remaining = config.scenarios.slice(scenarioIndex + 1).filter(scenario => !attempted.has(scenario.id));
    const continued = await runScenarios(config, context, remaining, results);
    results.push(...continued.results);
    blockers.push(...continued.blockers);
  }

  await store.complete({ status: summarizeStatus(results, blockers), results, blockers });
  return checked;
}

async function readOptional(store, name) {
  try { return await store.read(name); }
  catch { return null; }
}

async function readRequired(store, name, message) {
  const value = await readOptional(store, name);
  if (!value) throw new Error(message);
  return value;
}
