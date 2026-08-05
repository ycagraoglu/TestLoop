import { spawn } from 'node:child_process';

const ALLOWED_ROLES = new Set(['diagnose', 'fix', 'review']);

export async function runRole(role, input, config = {}) {
  if (!ALLOWED_ROLES.has(role)) throw new Error(`Unsupported role: ${role}`);
  const command = config[role]?.command;
  if (!command) return { status: 'UNAVAILABLE', role, reason: `No ${role} command configured.` };

  const [executable, ...args] = Array.isArray(command) ? command : shellSplit(command);
  const child = spawn(executable, args, {
    cwd: config.cwd,
    env: { ...process.env, ...(config.env ?? {}), TESTLOOP_ROLE: role },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify({ role, input })}\n`);

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${role} role timed out.`));
    }, config.timeoutMs ?? 120000);
    child.once('error', reject);
    child.once('exit', value => { clearTimeout(timer); resolve(value); });
  });

  if (code !== 0) throw new Error(`${role} role failed with code ${code}: ${stderr.trim()}`);
  const result = JSON.parse(stdout);
  validateRoleResult(role, result);
  return result;
}

export function validateRoleResult(role, result) {
  if (!result || typeof result !== 'object' || typeof result.status !== 'string') throw new Error(`${role} result requires status.`);
  if (role === 'diagnose' && !['FIXTURE_ERROR', 'AUTH_ERROR', 'ENVIRONMENT_ERROR', 'EXPECTED_REJECTION', 'APPLICATION_BUG', 'INCONCLUSIVE'].includes(result.status)) {
    throw new Error(`Invalid diagnosis status: ${result.status}`);
  }
  if (role === 'fix' && !['SUCCESS', 'FAILURE'].includes(result.status)) throw new Error(`Invalid fix status: ${result.status}`);
  if (role === 'review' && !['APPROVED', 'CHANGES_REQUESTED', 'REJECTED'].includes(result.status)) throw new Error(`Invalid review status: ${result.status}`);
  return true;
}

function shellSplit(value) {
  return String(value).match(/(?:[^\s"]+|"[^"]*")+/g)?.map(item => item.replace(/^"|"$/g, '')) ?? [];
}
