import { buildNegativeScenarios } from './negative-scenarios.js';
import { normalizeRoute } from './source-analyzer.js';

const AUTH_ROUTE = /\b(auth|token|login|signin|connect)\b/i;

// Turns a test plan plus the source manifest into a runnable configuration. The output is a draft
// for a human to review, never an authority: it proposes where fixtures might come from, and the
// runtime still refuses to use any of them without evidence. Anything it cannot infer is left out
// rather than guessed, so the run blocks with a clear reason instead of testing a fiction.
export function scaffoldRunConfig({ plan, sourceManifest = null, baseUrl, runId, openApiUrl }) {
  if (!plan?.groups) throw new Error('A test plan with groups is required.');
  if (!baseUrl) throw new Error('baseUrl is required.');

  const operations = plan.groups.flatMap(group => group.operations ?? []);
  // Two exclusions, both because a scenario here would be a false failure or an unrequested side
  // effect: destructive operations are opted into by hand, and a credential endpoint answers 401 to
  // the generated values TestLoop would send, which is not a defect worth reporting.
  const testable = operations.filter(operation => !operation.destructive && !isCredentialEndpoint(operation));
  if (testable.length === 0) throw new Error('The plan contains no non-destructive operations to scaffold.');

  const collectionRoutes = operations.filter(operation => operation.method === 'GET' && !operation.route.includes('{'));
  const { consumerToProducer, producerIds } = findProducers(testable);
  const models = new Map((sourceManifest?.requestModels ?? []).map(model => [model.name, model]));
  const validators = new Map((sourceManifest?.validators ?? []).map(validator => [validator.name, validator]));

  const positives = testable.map(operation => buildScenario({ operation, consumerToProducer, producerIds, collectionRoutes, models, validators, baseUrl }));
  // Negatives are grouped after the happy path, so a run establishes that the API works before it
  // starts proving what the API refuses.
  const negatives = plan.mode === 'deep'
    ? testable.flatMap((operation, index) => buildNegativeScenarios({ operation, scenario: positives[index], baseScenarioId: positives[index].id }))
    : [];
  const scenarios = [...positives, ...negatives];
  const config = {
    runId: runId ?? `scaffold-${new Date().toISOString().slice(0, 10)}`,
    mode: plan.mode ?? 'standard',
    baseUrl,
    security: buildSecurity(baseUrl),
    scenarios
  };

  // The document was already read to build the plan, so wiring it in costs nothing and gives every
  // scenario response-shape checking for free.
  if (openApiUrl) config.openApiUrl = openApiUrl;

  const auth = buildAuth(operations, baseUrl);
  if (auth) config.auth = auth;
  return config;
}

function buildScenario({ operation, consumerToProducer, producerIds, collectionRoutes, models, validators, baseUrl }) {
  const id = scenarioId(operation);
  const scenario = {
    id,
    method: operation.method,
    path: resolvePath(operation, consumerToProducer)
  };

  // Only the creating POST captures an id; the scenarios that consume it have nothing to hand on.
  if (producerIds.has(id)) scenario.capture = { id: 'id' };

  // A model with no readable properties is worse than none: the payload builder would send an empty
  // body and the endpoint would reject it for a reason that has nothing to do with the test.
  const model = models.get(operation.source?.requestType);
  if (operation.requiresBody && model?.properties?.length > 0) {
    scenario.requestModel = {
      name: model.name,
      properties: model.properties,
      dependencies: model.dependencies ?? []
    };

    const validator = validators.get(model.validator);
    if (validator) scenario.validator = { rules: validator.rules };

    const fixtureSources = proposeFixtureSources(model.dependencies ?? [], collectionRoutes, baseUrl);
    if (Object.keys(fixtureSources).length > 0) scenario.fixtureSources = fixtureSources;
  }

  return scenario;
}

// A dependency names an entity; a collection endpoint whose last segment matches that entity is the
// natural place to read one from. The proposal is only a URL: whatever comes back still has to be a
// real record, so a wrong guess resolves nothing and the scenario blocks.
function proposeFixtureSources(dependencies, collectionRoutes, baseUrl) {
  const sources = {};
  for (const dependency of dependencies) {
    if (!dependency.entity) continue;
    const match = collectionRoutes.find(operation => lastSegment(operation.route) && pluralCandidates(dependency.entity).includes(lastSegment(operation.route).toLowerCase()));
    if (!match) continue;
    sources[dependency.entity] = [{
      type: 'http-list',
      url: new URL(match.route, baseUrl).toString(),
      predicates: []
    }];
  }
  return sources;
}

// A parameterized route needs a value from somewhere. When the collection route above it is created
// by a POST in the same plan, that POST's captured id is the only honest source for it.
function resolvePath(operation, consumerToProducer) {
  const producer = consumerToProducer.get(routeKey(operation.method, operation.route));
  if (!producer) return operation.route;
  return operation.route.replace(/\{[^}]+\}$/, `{${producer}.id}`);
}

// Pairs each `/things/{id}` route with the `POST /things` that creates what it addresses, which is
// the only place in the plan an id for it can honestly come from.
function findProducers(operations) {
  const creators = new Map();
  for (const operation of operations) {
    if (operation.method !== 'POST' || operation.route.includes('{')) continue;
    creators.set(normalizeRoute(operation.route).toLowerCase(), scenarioId(operation));
  }

  const consumerToProducer = new Map();
  const producerIds = new Set();
  for (const operation of operations) {
    if (!/\/\{[^}]+\}$/.test(operation.route)) continue;
    const collection = normalizeRoute(operation.route.replace(/\/\{[^}]+\}$/, '')).toLowerCase();
    const creator = creators.get(collection);
    if (!creator) continue;
    consumerToProducer.set(routeKey(operation.method, operation.route), creator);
    producerIds.add(creator);
  }
  return { consumerToProducer, producerIds };
}

function isCredentialEndpoint(operation) {
  return AUTH_ROUTE.test(operation.route);
}

function buildAuth(operations, baseUrl) {
  if (!operations.some(operation => operation.source?.authorize?.required)) return null;
  const tokenEndpoint = operations.find(operation => operation.method === 'POST' && AUTH_ROUTE.test(operation.route) && !operation.source?.authorize?.required);

  return {
    type: 'login',
    url: new URL(tokenEndpoint?.route ?? '/api/auth/token', baseUrl).toString(),
    method: 'POST',
    // Credentials are never written into a configuration file; the run refuses to start if they are.
    body: { username: 'REPLACE_WITH_A_TEST_ACCOUNT', password: { $env: 'TESTLOOP_LOGIN_PASSWORD' } },
    tokenPath: 'REPLACE_WITH_THE_TOKEN_PATH_IN_THE_LOGIN_RESPONSE'
  };
}

function buildSecurity(baseUrl) {
  const { hostname } = new URL(baseUrl);
  return {
    allowPrivateNetwork: true,
    allowedHosts: [hostname],
    inheritedEnv: ['PATH', 'HOME', 'USERPROFILE', 'TMP', 'TEMP']
  };
}

function scenarioId(operation) {
  return `${operation.method}-${operation.route}`
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-|-$/g, '');
}

function routeKey(method, route) {
  return `${method} ${normalizeRoute(route).toLowerCase()}`;
}

function lastSegment(route) {
  return normalizeRoute(route).split('/').filter(Boolean).at(-1) ?? '';
}

function pluralCandidates(entity) {
  const name = entity.toLowerCase();
  return [name, `${name}s`, `${name}es`, name.replace(/y$/, 'ies')];
}
