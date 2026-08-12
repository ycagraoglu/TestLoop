const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)$/i;

export function redactAuth(auth) {
  if (!auth) return auth;
  const { response: _response, ...safe } = auth;
  return redactValue(safe);
}

export function redactValue(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) return value.map(item => redactValue(item, seen));

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEYS.test(key) ? REDACTED : redactValue(item, seen);
  }
  return result;
}
