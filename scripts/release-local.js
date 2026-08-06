import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const VERSION_FILES = [
  'package.json',
  'package-lock.json',
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  '.codex-plugin/plugin.json',
  'skills/testloop/SKILL.md',
  'CHANGELOG.md'
];
const args = process.argv.slice(2);
const version = args.find(arg => !arg.startsWith('--'));
const dryRun = args.includes('--dry-run');
const skipGitHubRelease = args.includes('--skip-github-release');
const notesIndex = args.indexOf('--notes');
const notes = notesIndex >= 0 ? args[notesIndex + 1] : 'Maintenance release.';

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Usage: npm run release -- <version> [--notes "..."] [--dry-run] [--skip-github-release]');
}

await ensureCleanMainBranch();
await run('npm', ['whoami']);
if (!dryRun && !skipGitHubRelease) await ensureGitHubCli();

await updateVersionFiles(version, notes);
try {
  await run('npm', ['run', 'verify']);
} catch (error) {
  await restoreVersionFiles();
  throw error;
}

if (dryRun) {
  await restoreVersionFiles();
  console.log(`Dry run complete for v${version}. No files, commits, tags, packages, or remote refs were changed.`);
  process.exit(0);
}

await run('git', ['add', ...VERSION_FILES]);
await run('git', ['commit', '-m', `Release v${version}`]);
await run('git', ['tag', '-a', `v${version}`, '-m', `TestLoop v${version}`]);

try {
  await run('npm', ['publish', '--access', 'public']);
} catch (error) {
  await rollbackLocalRelease(version);
  throw error;
}

await run('git', ['push', 'origin', 'main']);
await run('git', ['push', 'origin', `v${version}`]);

if (!skipGitHubRelease) {
  await run('gh', ['release', 'create', `v${version}`, '--title', `TestLoop v${version}`, '--notes', notes]);
}

console.log(`Published TestLoop v${version} to npm and pushed the release to GitHub.`);

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

async function ensureGitHubCli() {
  await run('gh', ['--version']);
  await run('gh', ['auth', 'status']);
}

async function updateVersionFiles(nextVersion, releaseNotes) {
  await updateJson('package.json', value => ({ ...value, version: nextVersion }));
  await updateJson('package-lock.json', value => {
    value.version = nextVersion;
    if (value.packages?.['']) value.packages[''].version = nextVersion;
    return value;
  });
  await updateJson('.claude-plugin/plugin.json', value => ({ ...value, version: nextVersion }));
  await updateJson('.codex-plugin/plugin.json', value => ({ ...value, version: nextVersion }));
  await updateJson('.claude-plugin/marketplace.json', value => ({
    ...value,
    plugins: (value.plugins ?? []).map(plugin => plugin.name === 'testloop' ? { ...plugin, version: nextVersion } : plugin)
  }));
  await updateSkillVersion(nextVersion);

  const changelog = await readFile('CHANGELOG.md', 'utf8');
  if (changelog.includes(`## [${nextVersion}]`)) throw new Error(`CHANGELOG already contains ${nextVersion}.`);
  const date = new Date().toISOString().slice(0, 10);
  const section = `\n## [${nextVersion}] - ${date}\n\n- ${releaseNotes}\n`;
  const marker = '\n## ';
  const index = changelog.indexOf(marker);
  const updated = index >= 0 ? `${changelog.slice(0, index)}${section}${changelog.slice(index)}` : `${changelog.trimEnd()}${section}\n`;
  await writeFile('CHANGELOG.md', updated, 'utf8');
}

async function updateSkillVersion(nextVersion) {
  const file = 'skills/testloop/SKILL.md';
  const skill = await readFile(file, 'utf8');
  const pattern = /(\nmetadata:\n(?:[ \t]+[^\n]+\n)*?[ \t]+version:\s*)["']?[^"'\n]+["']?/;
  if (!pattern.test(skill)) throw new Error(`${file} is missing metadata.version.`);
  await writeFile(file, skill.replace(pattern, `$1"${nextVersion}"`), 'utf8');
}

async function updateJson(file, transform) {
  const value = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, `${JSON.stringify(transform(value), null, 2)}\n`, 'utf8');
}

async function restoreVersionFiles() {
  await run('git', ['checkout', '--', ...VERSION_FILES], { allowFailure: true });
}

async function rollbackLocalRelease(releaseVersion) {
  await run('git', ['tag', '-d', `v${releaseVersion}`], { allowFailure: true });
  await run('git', ['reset', '--hard', 'HEAD~1'], { allowFailure: true });
}

async function run(command, commandArgs, options = {}) {
  const invocation = resolveInvocation(command, commandArgs);
  try {
    const result = await execFileAsync(invocation.executable, invocation.args, {
      cwd: process.cwd(),
      maxBuffer: 10_000_000,
      windowsHide: true
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.stdout ?? '';
  } catch (error) {
    if (options.allowFailure) return '';
    const details = [error.stdout, error.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${commandArgs.join(' ')} failed.${details ? `\n${details}` : ''}`);
  }
}

function resolveInvocation(command, commandArgs) {
  if (command !== 'npm') return { executable: command, args: commandArgs };
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run the release through npm scripts so npm_execpath is available.');
  return { executable: process.execPath, args: [npmCli, ...commandArgs] };
}
