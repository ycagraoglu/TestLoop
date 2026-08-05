import { spawn } from 'node:child_process';
import { once } from 'node:events';

export async function buildProject(projectPath, options = {}) {
  return runCommand(options.dotnet ?? 'dotnet', ['build', projectPath, '--nologo', '--configuration', options.configuration ?? 'Debug'], {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 120000
  });
}

export async function startApi({ projectPath, url, environment = 'Development', cwd, dotnet = 'dotnet', startupTimeoutMs = 60000 }) {
  assertSafeEnvironment(environment);
  if (!projectPath) throw new Error('projectPath is required.');
  if (!url) throw new Error('url is required.');

  const output = [];
  const child = spawn(dotnet, ['run', '--no-build', '--project', projectPath, '--urls', url], {
    cwd,
    env: { ...process.env, ASPNETCORE_ENVIRONMENT: environment, DOTNET_ENVIRONMENT: environment },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => output.push(chunk.toString()));
  child.stderr.on('data', chunk => output.push(chunk.toString()));

  try {
    await waitForHttp(url, startupTimeoutMs, child);
    return {
      pid: child.pid,
      url,
      environment,
      output,
      stop: async () => stopProcess(child)
    };
  } catch (error) {
    await stopProcess(child);
    error.output = output.join('');
    throw error;
  }
}

export function assertSafeEnvironment(environment) {
  if (/^production$/i.test(String(environment))) throw new Error('TestLoop refuses to start an API in Production.');
}

async function waitForHttp(baseUrl, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  const healthCandidates = [baseUrl, new URL('/swagger/v1/swagger.json', baseUrl).toString()];
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API process exited with code ${child.exitCode}.`);
    for (const candidate of healthCandidates) {
      try {
        const response = await fetch(candidate, { signal: AbortSignal.timeout(1500) });
        if (response.status < 500) return;
      } catch { /* retry */ }
    }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error(`API did not become ready within ${timeoutMs}ms.`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function runCommand(command, args, { cwd, timeoutMs }) {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  const result = { command, args, code, stdout, stderr, ok: code === 0 };
  if (!result.ok) {
    const error = new Error(`${command} ${args.join(' ')} failed with code ${code}.`);
    error.result = result;
    throw error;
  }
  return result;
}
