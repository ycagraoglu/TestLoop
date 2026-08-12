import { ArtifactStore } from './artifact-store.js';
import { resolveAuthContext } from './auth.js';
import { redactValue } from './redaction.js';
import { summarizeStatus } from './orchestrator.js';
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
  const scenario = config.scenarios.find(item => item.id === scenarioId);

  if (!scenario) throw new Error(`Scenario ${scenarioId} was not found in the persisted run configuration.`);
  if (!diagnosis || diagnosis.status !== 'APPLICATION_BUG' || !pending) {
    throw new Error(`Scenario ${scenarioId} has no pending approval in run ${runId}.`);
  }

  const securityPolicy = createSecurityPolicy(config.security);

  const result = decision === 'decline'
    ? { id: scenarioId, status: 'SKIPPED', classification: 'DECLINED_BY_USER', diagnosis, reason: 'Human declined the confirmed application bug fix.' }
    : await approveAndRetest({ config, scenario, diagnosis, pending, store, securityPolicy });

  await store.write(`${scenarioId}.resume.json`, redactValue(result));
  await updateSummary(store, result);
  return result;
}

async function approveAndRetest({ config, scenario, diagnosis, pending, store, securityPolicy }) {
  const auth = await resolveAuthContext(config.auth ?? { type: 'none' }, securityPolicy);
  const request = { ...pending.request, headers: { ...pending.request.headers, ...auth.headers } };
  const context = { config, store, securityPolicy };
  return runApprovedFix({ scenario, diagnosis, request, expectedStatuses: pending.expectedStatuses, context });
}

async function updateSummary(store, result) {
  const summary = await readOptional(store, 'summary.json');
  if (!summary || !Array.isArray(summary.results)) return;
  const results = summary.results.map(item => (item.id === result.id ? result : item));
  const blockers = summary.blockers ?? [];
  await store.complete({ status: summarizeStatus(results, blockers), results, blockers });
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
