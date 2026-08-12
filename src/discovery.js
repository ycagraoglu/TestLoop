import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { collectProjectFiles } from './project-files.js';

export async function discoverDotnetProjects(root = process.cwd()) {
  const files = await collectProjectFiles(root);
  return {
    root: path.resolve(root),
    solutions: files.filter(file => file.endsWith('.sln')).map(file => path.relative(root, file)),
    projects: await Promise.all(files.filter(file => file.endsWith('.csproj')).map(inspectProject))
  };
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
