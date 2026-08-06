import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const manifests = [
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  '.codex-plugin/plugin.json'
];

const parsed = new Map();
for (const filename of manifests) {
  const value = JSON.parse(await readFile(filename, 'utf8'));
  parsed.set(filename, value);
}

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const claude = parsed.get('.claude-plugin/plugin.json');
const marketplace = parsed.get('.claude-plugin/marketplace.json');
const codex = parsed.get('.codex-plugin/plugin.json');
const errors = [];

for (const [filename, manifest] of parsed) {
  if (manifest.name !== 'testloop') errors.push(`${filename}: name must be testloop.`);
}

for (const [filename, manifest] of [
  ['.claude-plugin/plugin.json', claude],
  ['.codex-plugin/plugin.json', codex]
]) {
  if (manifest.version !== packageJson.version) errors.push(`${filename}: version must match package.json.`);
}

const marketplacePlugin = marketplace.plugins?.find(plugin => plugin.name === 'testloop');
if (!marketplacePlugin) errors.push('.claude-plugin/marketplace.json: testloop plugin entry is required.');
else {
  if (marketplacePlugin.source !== './') errors.push('.claude-plugin/marketplace.json: source must be ./');
  if (marketplacePlugin.version !== packageJson.version) errors.push('.claude-plugin/marketplace.json: version must match package.json.');
}

if (codex.skills !== './skills/') errors.push('.codex-plugin/plugin.json: skills must point to ./skills/.');
if (!Array.isArray(codex.interface?.defaultPrompt) || codex.interface.defaultPrompt.length === 0) {
  errors.push('.codex-plugin/plugin.json: interface.defaultPrompt must contain at least one prompt.');
}

for (const requiredPath of ['skills/testloop/SKILL.md', 'bin/testloop.js', 'AGENTS.md']) {
  try {
    await access(path.resolve(requiredPath));
  } catch {
    errors.push(`required plugin resource is missing: ${requiredPath}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`Plugin validation error: ${error}`);
  process.exit(1);
}

console.log('Claude marketplace and Codex plugin manifests validated.');
