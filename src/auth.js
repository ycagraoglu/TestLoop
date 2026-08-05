import { executeHttp } from './http.js';
import { readPath } from './object-path.js';

const AUTH_RESOLVERS = Object.freeze({
  none: resolveAnonymous,
  bearer: resolveBearer,
  login: resolveLogin
});

export async function resolveAuthContext(config = {}, securityPolicy = null) {
  const type = config.type ?? 'none';
  const resolver = AUTH_RESOLVERS[type];
  if (!resolver) throw new Error(`Unsupported authentication type: ${type}`);
  return resolver(config, securityPolicy);
}

function resolveAnonymous() {
  return { type: 'none', headers: {}, evidence: ['anonymous'] };
}

function resolveBearer(config) {
  if (config.token) return blocked('Inline bearer tokens are disabled. Use tokenEnv.');
  const environmentName = config.tokenEnv ?? 'TESTLOOP_BEARER_TOKEN';
  const token = process.env[environmentName];
  if (!token) return blocked(`Bearer token was not provided in ${environmentName}.`);
  return {
    type: 'bearer',
    headers: { authorization: `Bearer ${token}` },
    evidence: [`token:environment:${environmentName}`]
  };
}

async function resolveLogin(config, securityPolicy) {
  if (!config.url || !config.body) return blocked('Login authentication requires url and body.');
  const body = resolveEnvironmentReferences(config.body);
  const response = await executeHttp({
    method: config.method ?? 'POST',
    url: config.url,
    body,
    headers: config.headers
  }, { securityPolicy, purpose: 'login' });
  if (!response.ok) return blocked(`Login failed with HTTP ${response.status}.`, { response });

  const tokenPath = config.tokenPath ?? 'token';
  const token = readPath(response.body, tokenPath);
  if (typeof token !== 'string' || token.length === 0) return blocked(`Token was not found at ${tokenPath}.`, { response });

  return {
    type: 'bearer',
    headers: { authorization: `${config.scheme ?? 'Bearer'} ${token}` },
    evidence: [`login:${config.url}`, `token-path:${tokenPath}`],
    response
  };
}

function resolveEnvironmentReferences(value) {
  if (Array.isArray(value)) return value.map(resolveEnvironmentReferences);
  if (!value || typeof value !== 'object') return value;
  if (Object.keys(value).length === 1 && typeof value.$env === 'string') {
    const resolved = process.env[value.$env];
    if (resolved === undefined) throw new Error(`Required environment variable is missing: ${value.$env}`);
    return resolved;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveEnvironmentReferences(item)]));
}

function blocked(reason, extra = {}) {
  return { type: 'blocked', status: 'BLOCKED', headers: {}, reason, ...extra };
}
