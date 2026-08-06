import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('npm_execpath is unavailable. Run this check through npm run pack:check.');

const { stdout } = await execFileAsync(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts'], {
  cwd: process.cwd(),
  maxBuffer: 5_000_000
});
const [pack] = JSON.parse(stdout);
const filenames = new Set(pack.files.map(file => file.path));
const required = [
  'bin/testloop.js',
  'src/orchestrator.js',
  'skills/testloop/SKILL.md',
  'scripts/validate-skill.js',
  'schemas/testloop-config.schema.json',
  'README.md',
  'LICENSE'
];
const missing = required.filter(file => !filenames.has(file));
if (missing.length > 0) throw new Error(`Package is missing required files: ${missing.join(', ')}`);
const forbidden = [...filenames].filter(file => file.startsWith('.testloop/') || file.startsWith('test/') || file.includes('.env'));
if (forbidden.length > 0) throw new Error(`Package contains forbidden files: ${forbidden.join(', ')}`);
const tarball = path.resolve(pack.filename);
await readFile(tarball);
console.log(`Package verified: ${pack.filename} (${pack.files.length} files)`);
await rm(tarball, { force: true });
