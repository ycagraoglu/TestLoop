import { readdir } from 'node:fs/promises';
import path from 'node:path';

// Build output and tooling directories never hold source worth analyzing, and .testloop holds this
// tool's own artifacts, so walking into any of them only produces noise and false matches.
const IGNORED = new Set(['.git', 'bin', 'obj', 'node_modules', '.testloop']);

export async function collectProjectFiles(root) {
  const files = [];

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  }

  await walk(root);
  return files;
}
