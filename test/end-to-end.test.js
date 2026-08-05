import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runVerification } from '../src/orchestrator.js';

async function withServer(handler, action) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { return await action(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('runs login, verified fixture acquisition, request execution, and artifact persistence', async () => {
  const requests = [];
  await withServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });

    response.setHeader('content-type', 'application/json');
    if (request.url === '/login') return response.end(JSON.stringify({ data: { accessToken: 'abc' } }));
    if (request.url === '/categories') return response.end(JSON.stringify([{ id: 'cat-1', isActive: true, tenantId: 'tenant-1' }]));
    if (request.url === '/products' && request.method === 'POST') {
      response.statusCode = 201;
      return response.end(JSON.stringify({ id: 'product-1', name: 'TestLoop Sample' }));
    }
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-e2e-'));
    const result = await runVerification({
      root,
      runId: 'e2e-run',
      baseUrl,
      auth: { type: 'login', url: `${baseUrl}/login`, body: { email: 'a', password: 'b' }, tokenPath: 'data.accessToken' },
      scenarios: [{
        id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201],
        requestModel: {
          name: 'CreateProductRequest',
          properties: [
            { name: 'Name', type: 'string', required: true },
            { name: 'CategoryId', type: 'Guid', required: true }
          ],
          dependencies: [{ property: 'CategoryId', entity: 'Category' }]
        },
        fixtureSources: {
          Category: [{
            type: 'http-list', url: `${baseUrl}/categories`,
            predicates: [
              { property: 'isActive', operator: 'truthy' },
              { property: 'tenantId', operator: 'equals', value: 'tenant-1' }
            ]
          }]
        },
        capture: { productId: 'id' }
      }]
    });

    assert.equal(result.status, 'PASS');
    assert.equal(result.results[0].output.productId, 'product-1');
    const productRequest = requests.find(item => item.url === '/products');
    assert.equal(productRequest.authorization, 'Bearer abc');
    assert.equal(JSON.parse(productRequest.body).CategoryId, 'cat-1');
  });
});

test('does not call endpoint when persisted dependency cannot be verified', async () => {
  let endpointCalls = 0;
  await withServer((request, response) => {
    if (request.url === '/products') endpointCalls += 1;
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-blocked-'));
    const result = await runVerification({
      root, baseUrl,
      scenarios: [{
        id: 'create-product', method: 'POST', path: '/products',
        requestModel: {
          name: 'CreateProductRequest',
          properties: [{ name: 'CategoryId', type: 'Guid', required: true }],
          dependencies: [{ property: 'CategoryId', entity: 'Category' }]
        }
      }]
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(endpointCalls, 0);
  });
});
