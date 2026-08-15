import { spawn } from 'node:child_process';
import { assertAllowedCommand, buildRestrictedEnvironment, createSecurityPolicy } from './security-policy.js';

const ALLOWED_ROLES = new Set(['diagnose', 'fix', 'review']);

export async function runRole(role, input, config = {}, securityPolicy = null) {
  if (!ALLOWED_ROLES.has(role)) throw new Error(`Unsupported role: ${role}`);
  const command = config[role]?.command;
  if (!command) return { status: 'UNAVAILABLE', role, reason: `No ${role} command configured.` };

  const policy = securityPolicy ?? createSecurityPolicy(config.security);
  const normalizedCommand = Array.isArray(command) ? command : null;
  assertAllowedCommand(normalizedCommand, policy);
  const [executable, ...args] = normalizedCommand;
  const child = spawn(executable, args, {
    cwd: config.cwd,
    env: buildRestrictedEnvironment(policy, { ...(config.env ?? {}), TESTLOOP_ROLE: role }),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true
  });
  let stdout = '';
  let stderr = '';
  const maxOutputBytes = policy.maxRoleOutputBytes;
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > maxOutputBytes) child.kill('SIGKILL');
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
    if (Buffer.byteLength(stderr) > maxOutputBytes) child.kill('SIGKILL');
  });
  child.stdin.end(`${JSON.stringify({ role, input })}\n`);

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${role} role timed out.`));
    }, config.timeoutMs ?? 120000);
    child.once('error', error => reject(explainSpawnFailure(error, executable)));
    child.once('exit', value => { clearTimeout(timer); resolve(value); });
  });

  if (Buffer.byteLength(stdout) > maxOutputBytes || Buffer.byteLength(stderr) > maxOutputBytes) {
    throw new Error(`${role} role exceeded output limit.`);
  }
  if (code !== 0) throw new Error(`${role} role failed with code ${code}: ${stderr.trim()}`);
  const result = JSON.parse(stdout);
  validateRoleResult(role, result);
  return result;
}

// `shell: false` is deliberate — it is what keeps a role command from being a shell expression — but
// it also means Windows cannot start a wrapper like npm or npx, which exist there only as .cmd
// shims. Raw ENOENT gives no hint of that, so the cause is spelled out.
function explainSpawnFailure(error, executable) {
  if (error.code !== 'ENOENT') return error;
  return new Error(
    `Role command not found: ${executable}. It must be an executable file, not a shell builtin, alias, or wrapper script. ` +
    'On Windows npm, npx and similar are .cmd shims that cannot start without a shell; point the command at the interpreter instead, for example ["node", "./agents/diagnose.mjs"].'
  );
}

export function validateRoleResult(role, result) {
  if (!result || typeof result !== 'object' || typeof result.status !== 'string') throw new Error(`${role} result requires status.`);
  if (role === 'diagnose' && !['FIXTURE_ERROR', 'AUTH_ERROR', 'ENVIRONMENT_ERROR', 'EXPECTED_REJECTION', 'SPEC_MISMATCH', 'APPLICATION_BUG', 'INCONCLUSIVE'].includes(result.status)) {
    throw new Error(`Invalid diagnosis status: ${result.status}`);
  }
  if (role === 'fix' && !['SUCCESS', 'FAILURE'].includes(result.status)) throw new Error(`Invalid fix status: ${result.status}`);
  if (role === 'review' && !['APPROVED', 'CHANGES_REQUESTED', 'REJECTED'].includes(result.status)) throw new Error(`Invalid review status: ${result.status}`);
  return true;
}
