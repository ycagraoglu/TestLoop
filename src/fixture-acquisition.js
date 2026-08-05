import { executeHttp } from './http.js';
import { selectFixtureCandidate } from './fixture-planner.js';
import { readPath } from './object-path.js';

const SOURCE_RESOLVERS = Object.freeze({
  static: resolveStatic,
  'workflow-output': resolveWorkflowOutput,
  'http-list': resolveHttpList
});

export async function acquireFixture(requirement, sources, context = {}) {
  for (const source of sources ?? []) {
    const resolver = SOURCE_RESOLVERS[source.type];
    if (!resolver) continue;
    const result = await resolver(requirement, source, context);
    if (result?.verified) return result;
  }

  return {
    verified: false,
    status: 'BLOCKED',
    property: requirement.property,
    entity: requirement.entity ?? null,
    reason: `No verified fixture could be acquired for ${requirement.property}.`
  };
}

function resolveStatic(requirement, source) {
  if (source.verified !== true || source.value === undefined || source.source === 'random') return null;
  return fixture(requirement, source.value, source.source ?? 'static', source.evidence ?? []);
}

function resolveWorkflowOutput(requirement, source, context) {
  const path = source.path ?? requirement.property;
  const value = readPath(context.outputs, path);
  if (value === undefined) return null;
  return fixture(requirement, value, `workflow-output:${path}`, ['captured from successful producer operation']);
}

async function resolveHttpList(requirement, source, context) {
  const response = await executeHttp({
    method: source.method ?? 'GET',
    url: source.url,
    headers: { ...(context.headers ?? {}), ...(source.headers ?? {}) }
  });
  if (!response.ok) return null;

  const candidates = normalizeCandidates(readPath(response.body, source.itemsPath ?? ''));
  const selected = selectFixtureCandidate(candidates, source.predicates ?? []);
  if (!selected) return null;

  const idProperty = source.idProperty ?? 'id';
  const value = selected[idProperty] ?? selected.Id;
  if (value === undefined) return null;

  return fixture(requirement, value, `http-list:${source.url}`, [
    `HTTP ${response.status}`,
    `candidate:${idProperty}`,
    ...(source.predicates ?? []).map(predicate => `predicate:${predicate.property}:${predicate.operator}`)
  ], selected);
}

function fixture(requirement, value, source, evidence, record = null) {
  return {
    verified: true,
    property: requirement.property,
    entity: requirement.entity ?? null,
    value,
    source,
    evidence,
    record
  };
}

function normalizeCandidates(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}
