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

  for (const scenario of config.scenarios) validateScenario(scenario);
  return config;
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
