import { recordCreation } from './cleanup.js';
import { executeHttp } from './http.js';
import { selectFixtureCandidate } from './fixture-planner.js';
import { readPath } from './object-path.js';

const SOURCE_RESOLVERS = Object.freeze({
  static: resolveStatic,
  'workflow-output': resolveWorkflowOutput,
  'http-list': resolveHttpList,
  'ensure-entity': resolveEnsureEntity
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
  }, {
    securityPolicy: context.securityPolicy,
    purpose: 'fixture source'
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
  ]);
}

async function resolveEnsureEntity(requirement, source, context) {
  const cacheKey = source.cacheKey ?? requirement.entity ?? requirement.property;
  const cache = context.entityCache instanceof Map ? context.entityCache : null;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);

  const listed = source.list ? await resolveHttpList(requirement, source.list, context) : null;
  if (listed) {
    cache?.set(cacheKey, listed);
    return listed;
  }

  if (!source.create) return null;

  const depth = context.creationDepth ?? 0;
  const maxDepth = context.maxCreationDepth ?? 3;
  if (depth >= maxDepth) {
    throw new Error(`Fixture creation depth limit (${maxDepth}) exceeded while ensuring ${requirement.entity ?? requirement.property}; check for a dependency cycle.`);
  }

  const created = await createEntity(source.create, { ...context, creationDepth: depth + 1 });
  if (!created?.verified) return null;

  recordCreation(context, {
    entity: requirement.entity ?? requirement.property,
    id: created.value,
    collectionUrl: source.create.url,
    createdBy: 'ensure-entity'
  });

  const result = fixture(
    requirement,
    created.value,
    created.source ?? 'ensure-entity:created',
    created.evidence ?? [`created ${requirement.entity ?? requirement.property} because no verified candidate existed`]
  );
  cache?.set(cacheKey, result);
  return result;
}

async function createEntity(createSpec, context) {
  const response = await executeHttp({
    method: createSpec.method ?? 'POST',
    url: createSpec.url,
    headers: { ...(context.headers ?? {}), ...(createSpec.headers ?? {}) },
    body: createSpec.body
  }, {
    securityPolicy: context.securityPolicy,
    purpose: 'fixture creation'
  });

  if (!response.ok) {
    return { verified: false, reason: `Fixture creation request failed with HTTP ${response.status}.` };
  }

  const idPath = createSpec.idProperty ?? 'id';
  const value = readPath(response.body, idPath);
  if (value === undefined) return { verified: false, reason: `Created entity response did not contain ${idPath}.` };

  return {
    verified: true,
    value,
    source: `ensure-entity:create:${createSpec.url}`,
    evidence: [`HTTP ${response.status}`, `created via ${createSpec.method ?? 'POST'} ${createSpec.url}`]
  };
}

function fixture(requirement, value, source, evidence) {
  return {
    verified: true,
    property: requirement.property,
    entity: requirement.entity ?? null,
    value,
    source,
    evidence
  };
}

function normalizeCandidates(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}
