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
  // URL.hostname wraps IPv6 literals in brackets ("[::1]"); net.isIP() and the checks below only
  // recognize the bare form, so every IPv6 check here silently no-ops without this strip.
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(normalized) || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return true;
  if (net.isIP(normalized) === 4) return PRIVATE_IPV4.some(pattern => pattern.test(normalized));
  if (net.isIP(normalized) === 6) {
    const mapped = ipv4MappedAddress(normalized);
    if (mapped) return PRIVATE_IPV4.some(pattern => pattern.test(mapped));
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }
  return false;
}

// Handles both the literal ("::ffff:127.0.0.1") and hex-compressed ("::ffff:7f00:1") forms an
// IPv4-mapped IPv6 address can take once a URL parser has canonicalized it.
function ipv4MappedAddress(address) {
  const dotted = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}
