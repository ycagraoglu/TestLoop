import { executeHttp } from './http.js';
import { selectFixtureCandidate } from './fixture-planner.js';

export async function acquireFixture(requirement, sources, context = {}) {
  for (const source of sources ?? []) {
    const result = await trySource(requirement, source, context);
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

async function trySource(requirement, source, context) {
  if (source.type === 'static') {
    if (source.verified !== true || source.value === undefined || source.source === 'random') return null;
    return fixture(requirement, source.value, source.source ?? 'static', source.evidence ?? []);
  }

  if (source.type === 'workflow-output') {
    const value = readPath(context.outputs, source.path ?? requirement.property);
    if (value === undefined) return null;
    return fixture(requirement, value, `workflow-output:${source.path ?? requirement.property}`, ['captured from successful producer operation']);
  }

  if (source.type === 'http-list') {
    const response = await executeHttp({
      method: source.method ?? 'GET',
      url: source.url,
      headers: { ...(context.headers ?? {}), ...(source.headers ?? {}) }
    });
    if (!response.ok) return null;
    const candidates = normalizeCandidates(readPath(response.body, source.itemsPath ?? ''));
    const selected = selectFixtureCandidate(candidates, source.predicates ?? []);
    if (!selected) return null;
    const value = selected[source.idProperty ?? 'id'] ?? selected.Id;
    if (value === undefined) return null;
    return fixture(requirement, value, `http-list:${source.url}`, [
      `HTTP ${response.status}`,
      `candidate:${source.idProperty ?? 'id'}`,
      ...(source.predicates ?? []).map(p => `predicate:${p.property}:${p.operator}`)
    ], selected);
  }

  return null;
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

function readPath(value, path) {
  if (!path) return value;
  return String(path).split('.').reduce((current, part) => current?.[part], value);
}
