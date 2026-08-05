import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverDotnetProjects } from '../src/discovery.js';

test('discovers ASP.NET Core web projects and ignores build folders', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'testloop-'));
  await mkdir(path.join(root, 'Api'));
  await writeFile(path.join(root, 'Api', 'Api.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>');
  await mkdir(path.join(root, 'Api', 'obj'));
  await writeFile(path.join(root, 'Api', 'obj', 'Ignored.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web" />');
  const result = await discoverDotnetProjects(root);
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].isWeb, true);
  assert.equal(result.projects[0].targetFramework, 'net8.0');
});
