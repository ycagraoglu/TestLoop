import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { acquireFixture } from '../src/fixture-acquisition.js';

async function withServer(handler, action) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { return await action(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('ensure-entity uses an existing verified candidate without creating one', async () => {
  const calls = [];
  await withServer((request, response) => {
    calls.push(request.url);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/categories') return response.end(JSON.stringify([{ id: 'cat-1', isActive: true }]));
    response.statusCode = 500;
    response.end('{}');
  }, async baseUrl => {
    const result = await acquireFixture(
      { property: 'CategoryId', entity: 'Category' },
      [{
        type: 'ensure-entity',
        list: { url: `${baseUrl}/categories`, predicates: [{ property: 'isActive', operator: 'truthy' }] },
        create: { url: `${baseUrl}/categories`, body: { name: 'Auto Category' } }
      }],
      { entityCache: new Map() }
    );

    assert.equal(result.verified, true);
    assert.equal(result.value, 'cat-1');
    assert.equal(calls.includes('/categories'), true);
  });
});

test('ensure-entity creates the entity when no verified candidate exists', async () => {
  const requests = [];
  await withServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, body });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/categories' && request.method === 'GET') return response.end(JSON.stringify([]));
    if (request.url === '/categories' && request.method === 'POST') {
      response.statusCode = 201;
      return response.end(JSON.stringify({ id: 'cat-created' }));
    }
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const result = await acquireFixture(
      { property: 'CategoryId', entity: 'Category' },
      [{
        type: 'ensure-entity',
        list: { url: `${baseUrl}/categories` },
        create: { method: 'POST', url: `${baseUrl}/categories`, body: { name: 'Auto Category' } }
      }],
      { entityCache: new Map() }
    );

    assert.equal(result.verified, true);
    assert.equal(result.value, 'cat-created');
    assert.equal(result.source, `ensure-entity:create:${baseUrl}/categories`);
    const createRequest = requests.find(item => item.method === 'POST');
    assert.equal(JSON.parse(createRequest.body).name, 'Auto Category');
  });
});

test('ensure-entity reuses a cached entity across repeated requirements', async () => {
  let createCalls = 0;
  await withServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/categories' && request.method === 'GET') return response.end(JSON.stringify([]));
    if (request.url === '/categories' && request.method === 'POST') {
      createCalls += 1;
      response.statusCode = 201;
      return response.end(JSON.stringify({ id: 'cat-shared' }));
    }
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const entityCache = new Map();
    const sources = [{
      type: 'ensure-entity',
      list: { url: `${baseUrl}/categories` },
      create: { url: `${baseUrl}/categories`, body: { name: 'Auto Category' } }
    }];

    const first = await acquireFixture({ property: 'CategoryId', entity: 'Category' }, sources, { entityCache });
    const second = await acquireFixture({ property: 'ParentCategoryId', entity: 'Category' }, sources, { entityCache });

    assert.equal(first.value, 'cat-shared');
    assert.equal(second.value, 'cat-shared');
    assert.equal(createCalls, 1);
  });
});

test('ensure-entity refuses to recurse past the creation depth limit', async () => {
  await assert.rejects(
    () => acquireFixture(
      { property: 'CategoryId', entity: 'Category' },
      [{
        type: 'ensure-entity',
        create: { url: 'http://127.0.0.1:1/categories', body: {} }
      }],
      { entityCache: new Map(), creationDepth: 2, maxCreationDepth: 2 }
    ),
    /depth limit/
  );
});

test('ensure-entity is blocked when creation fails and no candidate exists', async () => {
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') return response.end(JSON.stringify([]));
    response.statusCode = 500;
    response.end('{}');
  }, async baseUrl => {
    const result = await acquireFixture(
      { property: 'CategoryId', entity: 'Category' },
      [{
        type: 'ensure-entity',
        list: { url: `${baseUrl}/categories` },
        create: { url: `${baseUrl}/categories`, body: {} }
      }],
      { entityCache: new Map() }
    );

    assert.equal(result.verified, false);
    assert.equal(result.status, 'BLOCKED');
  });
});
