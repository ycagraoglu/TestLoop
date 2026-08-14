import assert from 'node:assert/strict';
import test from 'node:test';
import { scaffoldRunConfig } from '../src/config-scaffolder.js';
import { validateVerificationConfig } from '../src/verification-config.js';

const sourceManifest = {
  requestModels: [{
    name: 'CreateProductRequest',
    validator: 'CreateProductRequestValidator',
    properties: [{ name: 'Name', type: 'string', required: true }, { name: 'CategoryId', type: 'Guid', required: true }],
    dependencies: [{ property: 'CategoryId', entity: 'Category' }]
  }],
  validators: [{ name: 'CreateProductRequestValidator', rules: [{ property: 'Name', constraints: [{ type: 'not-empty' }] }] }]
};

function planOf(...operations) {
  return { mode: 'standard', groups: [{ feature: 'Shop', operations }] };
}

const createProduct = { method: 'POST', route: '/api/Products', requiresBody: true, destructive: false, source: { requestType: 'CreateProductRequest', authorize: null } };
const getProduct = { method: 'GET', route: '/api/Products/{id}', requiresBody: false, destructive: false, source: { authorize: null } };
const listCategories = { method: 'GET', route: '/api/Categories', requiresBody: false, destructive: false, source: { authorize: null } };

test('scaffolds a configuration the runtime accepts', () => {
  const config = scaffoldRunConfig({
    plan: planOf(createProduct, listCategories),
    sourceManifest,
    baseUrl: 'http://127.0.0.1:5099'
  });

  assert.doesNotThrow(() => validateVerificationConfig(config));
  assert.equal(config.security.allowedHosts[0], '127.0.0.1');
});

test('carries the analyzed request model, validator and dependency into the scenario', () => {
  const config = scaffoldRunConfig({ plan: planOf(createProduct, listCategories), sourceManifest, baseUrl: 'http://127.0.0.1:5099' });
  const scenario = config.scenarios.find(item => item.method === 'POST');

  assert.equal(scenario.requestModel.name, 'CreateProductRequest');
  assert.deepEqual(scenario.validator.rules[0].constraints, [{ type: 'not-empty' }]);
  assert.equal(scenario.fixtureSources.Category[0].url, 'http://127.0.0.1:5099/api/Categories', 'the collection endpoint for the entity is proposed');
  assert.equal(scenario.fixtureSources.Category[0].type, 'http-list');
});

test('chains a parameterized route to the POST that creates what it addresses', () => {
  const config = scaffoldRunConfig({ plan: planOf(createProduct, getProduct), sourceManifest, baseUrl: 'http://127.0.0.1:5099' });
  const [post, get] = config.scenarios;

  assert.deepEqual(post.capture, { id: 'id' });
  assert.equal(get.path, '/api/Products/{post-api-products.id}');
  assert.equal(get.capture, undefined, 'only the producer captures');
});

test('leaves a parameterized route alone when nothing in the plan produces it', () => {
  const config = scaffoldRunConfig({ plan: planOf(getProduct), sourceManifest, baseUrl: 'http://127.0.0.1:5099' });
  assert.equal(config.scenarios[0].path, '/api/Products/{id}', 'inventing an id would defeat the fixture gate');
});

test('omits destructive operations and credential endpoints', () => {
  const config = scaffoldRunConfig({
    plan: planOf(
      createProduct,
      { method: 'DELETE', route: '/api/Products/{id}', destructive: true, source: { authorize: null } },
      { method: 'POST', route: '/api/Auth/token', requiresBody: true, destructive: false, source: { authorize: null } }
    ),
    sourceManifest,
    baseUrl: 'http://127.0.0.1:5099'
  });

  const paths = config.scenarios.map(item => `${item.method} ${item.path}`);
  assert.equal(paths.some(item => item.startsWith('DELETE')), false, 'deleting is opted into by hand');
  assert.equal(paths.some(item => item.includes('/Auth/token')), false, 'generated credentials would only ever produce a false 401');
});

test('adds a credential-free auth skeleton only when an endpoint requires authorization', () => {
  const anonymous = scaffoldRunConfig({ plan: planOf(createProduct), sourceManifest, baseUrl: 'http://127.0.0.1:5099' });
  assert.equal(anonymous.auth, undefined);

  const protectedPlan = planOf(
    { ...createProduct, source: { requestType: 'CreateProductRequest', authorize: { required: true, roles: ['Admin'] } } },
    { method: 'POST', route: '/api/Auth/token', destructive: false, source: { authorize: null } }
  );
  const config = scaffoldRunConfig({ plan: protectedPlan, sourceManifest, baseUrl: 'http://127.0.0.1:5099' });

  assert.equal(config.auth.url, 'http://127.0.0.1:5099/api/Auth/token', 'the discovered token endpoint is used');
  assert.deepEqual(config.auth.body.password, { $env: 'TESTLOOP_LOGIN_PASSWORD' });
  assert.doesNotThrow(() => validateVerificationConfig(config), 'a scaffold must never carry an inline credential');
});

test('refuses to scaffold a plan with nothing safe to test', () => {
  assert.throws(
    () => scaffoldRunConfig({ plan: planOf({ method: 'DELETE', route: '/api/Products/{id}', destructive: true }), baseUrl: 'http://127.0.0.1:5099' }),
    /no non-destructive operations/
  );
});
