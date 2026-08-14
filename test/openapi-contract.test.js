import assert from 'node:assert/strict';
import test from 'node:test';
import { buildResponseContract, findResponseViolations } from '../src/openapi-contract.js';

const document = {
  openapi: '3.0.1',
  paths: {
    '/api/products/{id}': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } } } } } },
    '/api/products': { get: { responses: { '2XX': { content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } } } } } } } },
    '/api/tree': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } } } } }
  },
  components: {
    schemas: {
      Product: {
        type: 'object',
        required: ['id', 'name', 'price'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          price: { type: 'number' },
          stock: { type: 'integer' },
          state: { type: 'string', enum: ['active', 'retired'] },
          discontinuedAt: { type: 'string', nullable: true }
        }
      },
      Node: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } }
      }
    }
  }
};

const contract = buildResponseContract(document);
const check = (pathname, body, status = 200) => findResponseViolations(contract, { method: 'GET', pathname, status, body });
const product = { id: 'p1', name: 'Hammer', price: 9.99, stock: 5, state: 'active', discontinuedAt: null };

test('accepts a body that honours the declared contract', () => {
  assert.deepEqual(check('/api/products/p1', product), []);
  assert.deepEqual(check('/api/products', [product, product]), [], 'a 2XX response range still resolves');
});

test('reports missing required properties and wrong primitive types', () => {
  assert.match(check('/api/products/p1', { id: 'p1', name: 'Hammer' })[0], /price: required property is missing/);
  assert.match(check('/api/products/p1', { ...product, price: '9.99' })[0], /price: expected number, received a string/);
  assert.match(check('/api/products/p1', { ...product, stock: 2.5 })[0], /stock: expected integer/);
  assert.match(check('/api/products/p1', { ...product, state: 'archived' })[0], /is not one of/);
});

test('reports a container that is the wrong shape entirely', () => {
  assert.match(check('/api/products', product)[0], /expected an array, received an object/);
  assert.match(check('/api/products/p1', [product])[0], /expected an object, received an array/);
});

test('checks every element of an array, not just the first', () => {
  const violations = check('/api/products', [product, { id: 'p2', name: 'Saw' }]);
  assert.match(violations[0], /body\[1\]\.price: required property is missing/);
});

test('descends into a self-referencing schema as far as the data goes', () => {
  const violations = check('/api/tree', { name: 'root', children: [{ name: 'a' }, { children: [] }] });
  assert.deepEqual(violations, ['body.children[1].name: required property is missing']);
});

test('stays silent where a disagreement would be arguable', () => {
  assert.deepEqual(check('/api/products/p1', { ...product, extra: 'unexpected' }), [], 'extra fields are not a contract break');
  assert.deepEqual(check('/api/products/p1', { ...product, discontinuedAt: null }), [], 'nullable means nullable');
  assert.deepEqual(check('/api/unknown/path', { anything: true }), [], 'an unmapped path has no contract to check');
  assert.deepEqual(check('/api/products/p1', product, 418), [], 'a status with no declared response is skipped');

  const branching = buildResponseContract({
    paths: { '/x': { get: { responses: { 200: { content: { 'application/json': { schema: { oneOf: [{ type: 'string' }, { type: 'number' }] } } } } } } } }
  });
  assert.deepEqual(findResponseViolations(branching, { method: 'GET', pathname: '/x', status: 200, body: { neither: true } }), [],
    'which branch was intended is a judgement, not a fact');
});

test('has no contract to apply when no document was configured', () => {
  assert.deepEqual(findResponseViolations(null, { method: 'GET', pathname: '/api/products/p1', status: 200, body: {} }), []);
});
