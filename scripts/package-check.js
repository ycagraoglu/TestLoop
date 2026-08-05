import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const work = await mkdtemp(path.join(tmpdir(), 'testloop-pack-'));
try {
  const { stdout } = await execFileAsync('npm', ['pack', '--json', '--ignore-scripts'], { cwd: process.cwd(), maxBuffer: 5_000_000 });
  const [pack] = JSON.parse(stdout);
  const filenames = new Set(pack.files.map(file => file.path));
  const required = ['bin/testloop.js', 'src/orchestrator.js', 'skills/testloop/SKILL.md', 'schemas/testloop-config.schema.json', 'README.md', 'LICENSE'];
  const missing = required.filter(file => !filenames.has(file));
  if (missing.length > 0) throw new Error(`Package is missing required files: ${missing.join(', ')}`);
  const forbidden = [...filenames].filter(file => file.startsWith('.testloop/') || file.startsWith('test/') || file.includes('.env'));
  if (forbidden.length > 0) throw new Error(`Package contains forbidden files: ${forbidden.join(', ')}`);
  await readFile(path.resolve(pack.filename));
  console.log(`Package verified: ${pack.filename} (${pack.files.length} files)`);
  await rm(path.resolve(pack.filename), { force: true });
} finally {
  await rm(work, { recursive: true, force: true });
}
