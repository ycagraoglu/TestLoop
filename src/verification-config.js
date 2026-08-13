import { isEnvReference } from './env-reference.js';
import { EMBEDDED_SECRET, SENSITIVE_KEYS } from './redaction.js';

const VALID_MODES = new Set(['smoke', 'standard', 'deep']);
const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export function validateVerificationConfig(config) {
  if (!config?.baseUrl) throw new Error('baseUrl is required.');
  if (config.mode !== undefined && !VALID_MODES.has(config.mode)) {
    throw new Error(`mode must be one of ${[...VALID_MODES].join(', ')}.`);
  }
  if (config.stopOnFailure !== undefined && typeof config.stopOnFailure !== 'boolean') {
    throw new Error('stopOnFailure must be a boolean.');
  }
  if (config.requireApproval !== undefined && typeof config.requireApproval !== 'boolean') {
    throw new Error('requireApproval must be a boolean.');
  }
  if (config.maxCreationDepth !== undefined && (!Number.isInteger(config.maxCreationDepth) || config.maxCreationDepth < 0 || config.maxCreationDepth > 10)) {
    throw new Error('maxCreationDepth must be an integer between 0 and 10.');
  }
  if (!Array.isArray(config.scenarios) || config.scenarios.length === 0) {
    throw new Error('At least one scenario is required.');
  }

  assertNoInlineSecrets(config.auth, 'auth');
  for (const scenario of config.scenarios) validateScenario(scenario);
  return config;
}

// Credentials belong in the environment, never in the run config: the config is read from a file,
// committed, and copied between machines. Refused here rather than at login time, so the run stops
// before it creates any artifact. Same stance the inline bearer token already takes.
function assertNoInlineSecrets(value, pathLabel) {
  // A raw string body is the only way to send form-encoded content today, and it hides its
  // credentials from every key-based check, so it is inspected as text.
  if (typeof value === 'string') {
    if (EMBEDDED_SECRET.test(value)) {
      throw new Error(`${pathLabel} embeds a credential in a plain string. Put the secret in an environment variable and reference it with { "$env": "VARIABLE_NAME" }.`);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    const location = `${pathLabel}.${key}`;
    if (SENSITIVE_KEYS.test(key) && !isEnvReference(item)) {
      throw new Error(`${location} must not hold an inline secret. Use { "$env": "VARIABLE_NAME" } instead.`);
    }
    if (!isEnvReference(item)) assertNoInlineSecrets(item, location);
  }
}

export function expectedStatusesFor(scenario) {
  if (Array.isArray(scenario.expectedStatuses) && scenario.expectedStatuses.length > 0) {
    return scenario.expectedStatuses;
  }
  return scenario.method === 'POST' ? [200, 201, 202, 204] : [200, 202, 204];
}

function validateScenario(scenario) {
  if (!scenario?.id || !scenario.method || !scenario.path) {
    throw new Error('Every scenario requires id, method, and path.');
  }
  if (!VALID_METHODS.has(scenario.method)) {
    throw new Error(`Scenario ${scenario.id} has an invalid method: ${scenario.method}.`);
  }
  if (scenario.expectedStatuses !== undefined) {
    const valid = Array.isArray(scenario.expectedStatuses) &&
      scenario.expectedStatuses.every(status => Number.isInteger(status) && status >= 100 && status <= 599);
    if (!valid) throw new Error(`Scenario ${scenario.id} has invalid expectedStatuses.`);
  }
}
