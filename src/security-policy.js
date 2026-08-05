import path from 'node:path';
import net from 'node:net';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const PRIVATE_IPV4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./
];

export function createSecurityPolicy(config = {}) {
  return {
    allowPrivateNetwork: config.allowPrivateNetwork === true,
    allowedHosts: new Set(config.allowedHosts ?? []),
    allowedCommands: new Set(config.allowedCommands ?? []),
    allowedCommandDirectories: (config.allowedCommandDirectories ?? []).map(item => path.resolve(item)),
    maxResponseBytes: config.maxResponseBytes ?? 2_000_000,
    maxRoleOutputBytes: config.maxRoleOutputBytes ?? 1_000_000,
    inheritedEnv: new Set(config.inheritedEnv ?? ['PATH', 'HOME', 'USERPROFILE', 'TMP', 'TEMP'])
  };
}

export function assertAllowedUrl(rawUrl, policy, purpose = 'request') {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error(`Invalid ${purpose} URL.`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${purpose} URL must use http or https.`);
  if (url.username || url.password) throw new Error(`${purpose} URL must not contain credentials.`);
  if (!policy.allowPrivateNetwork && isPrivateHost(url.hostname)) {
    throw new Error(`${purpose} URL points to a private or loopback network. Explicitly allow it in security.allowPrivateNetwork.`);
  }
  if (policy.allowedHosts.size > 0 && !policy.allowedHosts.has(url.hostname)) {
    throw new Error(`${purpose} host is not allowlisted: ${url.hostname}`);
  }
  return url;
}

export function assertAllowedCommand(command, policy) {
  if (!Array.isArray(command) || command.length === 0 || command.some(part => typeof part !== 'string' || part.length === 0)) {
    throw new Error('Role command must be a non-empty string array.');
  }
  const executable = command[0];
  const executableName = path.basename(executable);
  const resolved = path.isAbsolute(executable) ? path.resolve(executable) : null;
  const allowedByName = policy.allowedCommands.has(executable) || policy.allowedCommands.has(executableName);
  const allowedByDirectory = resolved && policy.allowedCommandDirectories.some(directory => resolved === directory || resolved.startsWith(`${directory}${path.sep}`));
  if (!allowedByName && !allowedByDirectory) throw new Error(`Role command is not allowlisted: ${executable}`);
  return command;
}

export function buildRestrictedEnvironment(policy, additions = {}) {
  const environment = {};
  for (const name of policy.inheritedEnv) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return { ...environment, ...additions };
}

function isPrivateHost(hostname) {
  const normalized = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(normalized) || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return true;
  if (net.isIP(normalized) === 4) return PRIVATE_IPV4.some(pattern => pattern.test(normalized));
  if (net.isIP(normalized) === 6) return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  return false;
}
