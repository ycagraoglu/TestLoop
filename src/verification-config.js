export function validateVerificationConfig(config) {
  if (!config?.baseUrl) throw new Error('baseUrl is required.');
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
}
