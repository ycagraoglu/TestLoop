import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class ArtifactStore {
  constructor(root = process.cwd(), runId = createRunId()) {
    this.runId = runId;
    this.directory = path.join(root, '.testloop', 'runs', runId);
  }

  async initialize(metadata = {}) {
    await mkdir(this.directory, { recursive: true });
    await this.write('run.json', {
      runId: this.runId,
      createdAt: new Date().toISOString(),
      status: 'RUNNING',
      ...metadata
    });
    return this;
  }

  async write(name, value) {
    await mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, safeName(name));
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return target;
  }

  async writeText(name, value) {
    await mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, safeName(name));
    await writeFile(target, value, 'utf8');
    return target;
  }

  async read(name) {
    return JSON.parse(await readFile(path.join(this.directory, safeName(name)), 'utf8'));
  }

  async complete(summary) {
    return this.write('summary.json', {
      runId: this.runId,
      completedAt: new Date().toISOString(),
      ...summary
    });
  }
}

export function createRunId(now = new Date()) {
  return now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function safeName(name) {
  const normalized = String(name).replace(/\\/g, '/');
  if (normalized.includes('..') || normalized.startsWith('/')) throw new Error('Artifact name must be relative and safe.');
  return normalized;
}
