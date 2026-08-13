import { isEnvReference } from './env-reference.js';

const REDACTED = '[REDACTED]';
export const SENSITIVE_KEYS = /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)$/i;

// The same vocabulary matched *inside* a string instead of as an object key. A form-encoded body
// ("grant_type=password&client_secret=abc") carries its credentials in the text itself, so key-based
// checks see only a harmless key named "body" and wave the secret straight through to disk.
// Requires a value after the "=", so "grant_type=password" (where password is the grant name, not a
// credential) does not trip it.
export const EMBEDDED_SECRET = /\b(password|passwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)\s*=\s*\S/i;

// The persisted run configuration is reloaded by `testloop resume` in a later process, so it cannot
// simply be redacted: an { "$env": "NAME" } pointer has to survive for re-authentication to work.
// A literal value under a sensitive key is a real secret, though, and never belongs in an artifact
// that gets committed, attached to a ticket, or shared as evidence.
export function redactConfig(value, seen = new WeakSet()) {
  if (typeof value === 'string') return EMBEDDED_SECRET.test(value) ? REDACTED : value;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) return value.map(item => redactConfig(item, seen));

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const keepAsPointer = isEnvReference(item);
    result[key] = SENSITIVE_KEYS.test(key) && !keepAsPointer ? REDACTED : redactConfig(item, seen);
  }
  return result;
}

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
