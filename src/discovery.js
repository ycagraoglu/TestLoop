import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const IGNORED = new Set(['.git', 'bin', 'obj', 'node_modules', '.testloop']);

export async function discoverDotnetProjects(root = process.cwd()) {
  const projects = [];
  const solutions = [];

  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.csproj')) projects.push(await inspectProject(full));
      else if (entry.name.endsWith('.sln')) solutions.push(path.relative(root, full));
    }
  }

  await walk(root);
  return { root: path.resolve(root), solutions, projects };
}

async function inspectProject(file) {
  const xml = await readFile(file, 'utf8');
  const sdk = xml.match(/<Project\s+Sdk="([^"]+)"/)?.[1] ?? null;
  const targetFramework = xml.match(/<TargetFramework>([^<]+)<\/TargetFramework>/)?.[1] ?? null;
  const outputType = xml.match(/<OutputType>([^<]+)<\/OutputType>/)?.[1] ?? null;
  const isWeb = sdk?.includes('Microsoft.NET.Sdk.Web') ?? false;
  return {
    path: file,
    name: path.basename(file, '.csproj'),
    sdk,
    targetFramework,
    outputType,
    isWeb
  };
}

export async function ensureDirectoryExists(directory) {
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${directory}`);
}
