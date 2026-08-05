import { executeHttp } from './http.js';

export async function resolveAuthContext(config = {}) {
  if (config.type === 'none' || !config.type) return { type: 'none', headers: {}, evidence: ['anonymous'] };

  if (config.type === 'bearer') {
    const token = config.token ?? process.env[config.tokenEnv ?? 'TESTLOOP_BEARER_TOKEN'];
    if (!token) return blocked('Bearer token was not provided.');
    return {
      type: 'bearer',
      headers: { authorization: `Bearer ${token}` },
      evidence: [`token:${config.token ? 'config' : 'environment'}`]
    };
  }

  if (config.type === 'login') {
    if (!config.url || !config.body) return blocked('Login authentication requires url and body.');
    const response = await executeHttp({ method: config.method ?? 'POST', url: config.url, body: config.body, headers: config.headers });
    if (!response.ok) return blocked(`Login failed with HTTP ${response.status}.`, { response });
    const token = readPath(response.body, config.tokenPath ?? 'token');
    if (typeof token !== 'string' || token.length === 0) return blocked(`Token was not found at ${config.tokenPath ?? 'token'}.`, { response });
    return {
      type: 'bearer',
      headers: { authorization: `${config.scheme ?? 'Bearer'} ${token}` },
      evidence: [`login:${config.url}`, `token-path:${config.tokenPath ?? 'token'}`],
      response
    };
  }

  throw new Error(`Unsupported authentication type: ${config.type}`);
}

function blocked(reason, extra = {}) {
  return { type: 'blocked', status: 'BLOCKED', headers: {}, reason, ...extra };
}

function readPath(value, path) {
  return String(path).split('.').reduce((current, part) => current?.[part], value);
}
