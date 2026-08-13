// TestLoop configuration never carries a secret literally. Wherever a credential is needed, the
// config holds an { "$env": "VARIABLE_NAME" } pointer that is resolved from the environment at the
// moment it is used, so the value exists only in memory and never reaches an artifact on disk.

export function isEnvReference(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && typeof value.$env === 'string';
}

export function resolveEnvironmentReferences(value) {
  if (Array.isArray(value)) return value.map(resolveEnvironmentReferences);
  if (!value || typeof value !== 'object') return value;
  if (isEnvReference(value)) {
    const resolved = process.env[value.$env];
    if (resolved === undefined) throw new Error(`Required environment variable is missing: ${value.$env}`);
    return resolved;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveEnvironmentReferences(item)]));
}
