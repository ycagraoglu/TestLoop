import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFixturePlan, selectFixtureCandidate } from '../src/fixture-planner.js';

const requestModel = {
  name: 'CreateProductRequest',
  properties: [
    { name: 'Name', type: 'string', required: true },
    { name: 'Price', type: 'decimal', required: true },
    { name: 'CategoryId', type: 'Guid', required: true }
  ],
  dependencies: [
    { property: 'CategoryId', entity: 'Category', resolution: 'ef-core-metadata', randomValueAllowed: false }
  ]
};

const validator = {
  rules: [
    { property: 'Name', constraints: [{ type: 'not-empty' }, { type: 'max-length', value: 30 }] },
    { property: 'Price', constraints: [{ type: 'greater-than', value: 0 }] }
  ]
};

test('blocks requests when a persisted dependency is unresolved', () => {
  const plan = buildFixturePlan({ requestModel, validator });
  assert.equal(plan.status, 'BLOCKED');
  assert.equal(plan.payload.Name, 'TestLoop Sample');
  assert.equal(plan.payload.Price, 1);
  assert.equal(plan.blocked[0].property, 'CategoryId');
  assert.equal(Object.hasOwn(plan.payload, 'CategoryId'), false);
});

test('uses only verified reusable foreign-key fixtures', () => {
  const plan = buildFixturePlan({
    requestModel,
    validator,
    reusableFixtures: {
      Category: {
        value: '11111111-1111-1111-1111-111111111111',
        source: 'safe-read-endpoint',
        verified: true,
        evidence: ['GET /api/categories returned active category']
      }
    }
  });

  assert.equal(plan.status, 'READY');
  assert.equal(plan.payload.CategoryId, '11111111-1111-1111-1111-111111111111');
  assert.deepEqual(plan.fixtureManifest.dependencies, [
    { property: 'CategoryId', source: 'safe-read-endpoint', verified: true }
  ]);
});

test('rejects random reusable fixtures', () => {
  const plan = buildFixturePlan({
    requestModel,
    validator,
    reusableFixtures: {
      Category: { value: '22222222-2222-2222-2222-222222222222', source: 'random', verified: true }
    }
  });
  assert.equal(plan.status, 'BLOCKED');
});

test('selects a stable candidate that satisfies business predicates', () => {
  const candidate = selectFixtureCandidate([
    { id: 'b', isActive: true, tenantId: 't1' },
    { id: 'a', isActive: true, tenantId: 't1' },
    { id: 'c', isActive: false, tenantId: 't1' }
  ], [
    { property: 'isActive', operator: 'truthy' },
    { property: 'tenantId', operator: 'equals', value: 't1' }
  ]);
  assert.equal(candidate.id, 'a');
});
