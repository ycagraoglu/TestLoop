import test from 'node:test';
import assert from 'node:assert/strict';
import { listOperations } from '../src/openapi.js';

test('lists operations without inventing metadata', () => {
  const operations = listOperations({
    openapi: '3.0.1',
    paths: {
      '/api/products': {
        get: { operationId: 'Products_List', tags: ['Products'] },
        post: { tags: ['Products'], requestBody: { required: true } }
      }
    }
  });
  assert.deepEqual(operations, [
    {
      id: 'Products_List', method: 'GET', route: '/api/products', tags: ['Products'],
      deprecated: false, requestBodyRequired: false, security: []
    },
    {
      id: 'POST /api/products', method: 'POST', route: '/api/products', tags: ['Products'],
      deprecated: false, requestBodyRequired: true, security: []
    }
  ]);
});
