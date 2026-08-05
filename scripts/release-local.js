import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const version = args.find(arg => !arg.startsWith('--'));
const dryRun = args.includes('--dry-run');
const notesIndex = args.indexOf('--notes');
const notes = notesIndex >= 0 ? args[notesIndex + 1] : 'Maintenance release.';

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Usage: npm run release -- <version> [--notes "..."] [--dry-run]');
}

await ensureCleanMainBranch();
await run('npm', ['whoami']);
await updateVersionFiles(version, notes);
await run('npm', ['run', 'verify']);

if (dryRun) {
  console.log(`Dry run complete for v${version}. Version files were updated locally but no commit, tag, publish, or push was performed.`);
  process.exit(0);
}

await run('git', ['add', 'package.json', 'package-lock.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'CHANGELOG.md']);
await run('git', ['commit', '-m', `Release v${version}`]);
await run('git', ['tag', '-a', `v${version}`, '-m', `TestLoop v${version}`]);

try {
  await run('npm', ['publish', '--access', 'public', '--provenance']);
} catch (error) {
  await run('git', ['tag', '-d', `v${version}`], { allowFailure: true });
  await run('git', ['reset', '--hard', 'HEAD~1'], { allowFailure: true });
  throw error;
}

await run('git', ['push', 'origin', 'main']);
await run('git', ['push', 'origin', `v${version}`]);
console.log(`Published and pushed TestLoop v${version}.`);

async function ensureCleanMainBranch() {
  const branch = (await run('git', ['branch', '--show-current'])).trim();
  if (branch !== 'main') throw new Error(`Local releases must run from main. Current branch: ${branch || '(detached)'}`);
  const status = (await run('git', ['status', '--porcelain'])).trim();
  if (status) throw new Error('Working tree must be clean before releasing.');
  await run('git', ['fetch', 'origin', 'main']);
  const local = (await run('git', ['rev-parse', 'main'])).trim();
  const remote = (await run('git', ['rev-parse', 'origin/main'])).trim();
  if (local !== remote) throw new Error('Local main must exactly match origin/main before releasing.');
}

async function updateVersionFiles(nextVersion, releaseNotes) {
  await updateJson('package.json', value => ({ ...value, version: nextVersion }));
  await updateJson('package-lock.json', value => {
    value.version = nextVersion;
    if (value.packages?.['']) value.packages[''].version = nextVersion;
    return value;
  });
  await updateJson('.claude-plugin/plugin.json', value => ({ ...value, version: nextVersion }));
  await updateJson('.claude-plugin/marketplace.json', value => ({
    ...value,
    plugins: (value.plugins ?? []).map(plugin => plugin.name === 'testloop' ? { ...plugin, version: nextVersion } : plugin)
  }));

  const changelog = await readFile('CHANGELOG.md', 'utf8');
  if (changelog.includes(`## [${nextVersion}]`)) throw new Error(`CHANGELOG already contains ${nextVersion}.`);
  const date = new Date().toISOString().slice(0, 10);
  const section = `\n## [${nextVersion}] - ${date}\n\n- ${releaseNotes}\n`;
  const marker = '\n## ';
  const index = changelog.indexOf(marker);
  const updated = index >= 0 ? `${changelog.slice(0, index)}${section}${changelog.slice(index)}` : `${changelog.trimEnd()}${section}\n`;
  await writeFile('CHANGELOG.md', updated, 'utf8');
}

async function updateJson(file, transform) {
  const value = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, `${JSON.stringify(transform(value), null, 2)}\n`, 'utf8');
}

async function run(command, commandArgs, options = {}) {
  const executable = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command;
  try {
    const result = await execFileAsync(executable, commandArgs, { cwd: process.cwd(), maxBuffer: 10_000_000 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.stdout ?? '';
  } catch (error) {
    if (options.allowFailure) return '';
    const details = [error.stdout, error.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${commandArgs.join(' ')} failed.${details ? `\n${details}` : ''}`);
  }
}
