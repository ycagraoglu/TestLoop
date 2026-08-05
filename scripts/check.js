import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const files = [path.resolve('bin/testloop.js'), ...(await collect(path.resolve('src'))), ...(await collect(path.resolve('scripts'))).filter(file => !file.endsWith('check.js'))];
for (const file of files) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) process.exit(code ?? 1);
}
console.log(`Syntax checked ${files.length} files.`);

async function collect(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...await collect(full));
    else if (entry.name.endsWith('.js')) results.push(full);
  }
  return results;
}
