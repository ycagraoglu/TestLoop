const REDACTED = '[REDACTED]';

export function redactHeaders(headers = {}) {
  const result = { ...headers };
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === 'authorization') result[key] = REDACTED;
  }
  return result;
}

export function redactRequest(request) {
  return { ...request, headers: redactHeaders(request?.headers) };
}

export function redactAuth(auth) {
  if (!auth) return auth;
  const { response: _response, ...safe } = auth;
  return { ...safe, headers: redactHeaders(auth.headers) };
}
