import assert from 'node:assert/strict';
import test from 'node:test';
import { scaffoldRunConfig } from '../src/config-scaffolder.js';
import { buildNegativeScenarios } from '../src/negative-scenarios.js';
import { classifyExecution } from '../src/workflow.js';
import { validateVerificationConfig } from '../src/verification-config.js';

const protectedCreate = {
  method: 'POST',
  route: '/api/Products',
  requiresBody: true,
  destructive: false,
  source: { requestType: 'CreateProductRequest', authorize: { required: true, roles: ['Admin'] } }
};

const createScenario = {
  id: 'post-api-products',
  method: 'POST',
  path: '/api/Products',
  requestModel: {
    name: 'CreateProductRequest',
    properties: [{ name: 'Name', type: 'string' }, { name: 'Price', type: 'decimal' }, { name: 'CategoryId', type: 'Guid' }],
    dependencies: [{ property: 'CategoryId', entity: 'Category' }]
  },
  validator: {
    rules: [
      { property: 'Name', constraints: [{ type: 'not-empty' }, { type: 'max-length', value: 80 }] },
      { property: 'Price', constraints: [{ type: 'greater-than', value: 0 }] },
      { property: 'CategoryId', constraints: [{ type: 'not-empty' }] }
    ]
  },
  fixtureSources: { Category: [{ type: 'http-list', url: 'http://127.0.0.1:5099/api/Categories' }] }
};

function generate(operation, scenario) {
  return buildNegativeScenarios({ operation, scenario, baseScenarioId: scenario.id });
}

test('asserts that a protected endpoint still refuses an unauthenticated caller', () => {
  const anonymous = generate(protectedCreate, createScenario).find(item => item.anonymous);

  assert.equal(anonymous.id, 'post-api-products-rejects-anonymous');
  assert.deepEqual(anonymous.expectedStatuses, [401, 403], 'either answer means refused');
  assert.equal(anonymous.requestModel.name, 'CreateProductRequest', 'a valid body, so only the missing token can explain the outcome');
});

test('generates no anonymous check for an endpoint that is meant to be open', () => {
  const open = { ...protectedCreate, source: { requestType: 'CreateProductRequest', authorize: null } };
  assert.deepEqual(generate(open, createScenario).filter(item => item.anonymous), []);
});

test('breaks one validation rule at a time, leaving the rest of the request valid', () => {
  const violations = generate(protectedCreate, createScenario).filter(item => item.body);

  assert.deepEqual(violations.map(item => item.id), [
    'post-api-products-rejects-name-not-empty',
    'post-api-products-rejects-name-max-length',
    'post-api-products-rejects-price-greater-than'
  ], 'a foreign key is excluded: overriding it would test the fixture gate, not the validator');

  assert.deepEqual(violations[0].body, { Name: '' });
  assert.equal(violations[1].body.Name.length, 81, 'one character past the declared maximum');
  assert.equal(violations[2].body.Price, 0, 'the boundary itself violates "greater than"');
  for (const violation of violations) {
    assert.deepEqual(violation.expectedStatuses, [400, 422]);
    assert.equal(violation.fixtureSources.Category[0].type, 'http-list', 'the foreign key is still resolved properly');
  }
});

test('asks a lookup route for something that cannot exist', () => {
  const lookup = {
    method: 'GET',
    route: '/api/Products/{id}',
    destructive: false,
    source: { authorize: { required: true, roles: [] }, parameters: [{ name: 'id', type: 'Guid' }] }
  };
  const missing = generate(lookup, { id: 'get-api-products-id', method: 'GET', path: '/api/Products/{x.id}' })
    .find(item => item.id.endsWith('missing-is-not-found'));

  assert.equal(missing.path, '/api/Products/00000000-0000-0000-0000-000000000000');
  assert.deepEqual(missing.expectedStatuses, [404]);
});

test('deep mode adds the negatives to a scaffold; standard mode does not', () => {
  const inputs = {
    sourceManifest: {
      requestModels: [{ name: 'CreateProductRequest', validator: 'V', properties: createScenario.requestModel.properties, dependencies: createScenario.requestModel.dependencies }],
      validators: [{ name: 'V', rules: createScenario.validator.rules }]
    },
    baseUrl: 'http://127.0.0.1:5099'
  };
  const plan = mode => ({ mode, groups: [{ feature: 'Shop', operations: [protectedCreate] }] });

  const standard = scaffoldRunConfig({ plan: plan('standard'), ...inputs });
  const deep = scaffoldRunConfig({ plan: plan('deep'), ...inputs });

  assert.equal(standard.scenarios.length, 1);
  assert.equal(deep.scenarios.length > 1, true);
  assert.equal(deep.scenarios[0].id, 'post-api-products', 'the happy path is established before anything is disproved');
  assert.doesNotThrow(() => validateVerificationConfig({ ...deep, baseUrl: 'http://127.0.0.1:5099' }));
});

test('a call that succeeds where the scenario demands refusal is a definite fault, not an unknown', () => {
  const refusalExpected = { expectedStatuses: [401, 403], fixtureVerified: true, environmentHealthy: true };
  assert.equal(classifyExecution({ ...refusalExpected, actualStatus: 200 }), 'REJECTION_NOT_ENFORCED');
  assert.equal(classifyExecution({ ...refusalExpected, actualStatus: 201 }), 'REJECTION_NOT_ENFORCED');
  assert.equal(classifyExecution({ ...refusalExpected, actualStatus: 403 }), 'PASS', 'the refusal it asked for');
  assert.equal(classifyExecution({ ...refusalExpected, actualStatus: 500 }), 'APPLICATION_BUG', 'a crash is still a crash');
  assert.equal(
    classifyExecution({ expectedStatuses: [200], actualStatus: 201, fixtureVerified: true, environmentHealthy: true }),
    'INCONCLUSIVE',
    'a positive scenario meeting a different success status is not a missing guard'
  );
});
