import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runVerification } from '../src/orchestrator.js';
import { resumeVerification } from '../src/resume.js';

// A store that answers like a REST collection, so creations and deletions are observable.
function withApi(action, { failFirstProduct = false } = {}) {
  const products = new Map();
  const categories = new Map([['cat-seed', { id: 'cat-seed', isActive: true }]]);
  let productPosts = 0;

  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.setHeader('content-type', 'application/json');
    const [, collection, id] = request.url.split('/');

    if (request.method === 'POST' && collection === 'products') {
      productPosts += 1;
      if (failFirstProduct && productPosts === 1) { response.statusCode = 500; return response.end('{}'); }
      const created = `product-${productPosts}`;
      products.set(created, { id: created });
      response.statusCode = 201;
      return response.end(JSON.stringify({ id: created }));
    }
    if (request.method === 'POST' && collection === 'categories') {
      const created = `cat-${categories.size + 1}`;
      categories.set(created, { id: created, isActive: true });
      response.statusCode = 201;
      return response.end(JSON.stringify({ id: created }));
    }
    if (request.method === 'GET' && collection === 'categories' && !id) {
      return response.end(JSON.stringify([...categories.values()]));
    }
    if (request.method === 'DELETE') {
      const store = collection === 'products' ? products : categories;
      response.statusCode = store.delete(id) ? 204 : 404;
      return response.end('{}');
    }
    response.statusCode = 404;
    response.end('{}');
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      try { resolve(await action({ baseUrl, products, categories })); }
      catch (error) { reject(error); }
      finally { server.close(); }
    });
  });
}

const security = { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'], allowedCommands: ['node'] };

function readArtifact(root, runId, name) {
  return readFile(path.join(root, '.testloop', 'runs', runId, name), 'utf8').then(JSON.parse);
}

test('records what a run created even when it is told not to remove anything', async () => {
  await withApi(async ({ baseUrl, products }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-ledger-'));
    await runVerification({
      root, runId: 'ledger-run', baseUrl, security,
      scenarios: [{ id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } }]
    });

    const created = await readArtifact(root, 'ledger-run', 'created.json');
    assert.equal(created.length, 1);
    assert.equal(created[0].id, 'product-1');
    assert.equal(created[0].createdBy, 'scenario:create-product');
    assert.equal(products.size, 1, 'the record is still there: recording is not removing');
  });
});

test('removes what it created when cleanup is enabled, leaving pre-existing data alone', async () => {
  await withApi(async ({ baseUrl, products, categories }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-cleanup-'));
    await runVerification({
      root, runId: 'cleanup-run', baseUrl, cleanup: true, security,
      scenarios: [{ id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } }]
    });

    assert.equal(products.size, 0, 'the run left nothing behind');
    assert.deepEqual([...categories.keys()], ['cat-seed'], 'data the run did not create is never touched');

    const outcome = await readArtifact(root, 'cleanup-run', 'cleanup.json');
    assert.equal(outcome.removed.length, 1);
    assert.deepEqual(outcome.failed, []);
  });
});

test('cleans up an entity that ensure-entity had to create', async () => {
  await withApi(async ({ baseUrl, categories }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-cleanup-fixture-'));
    await runVerification({
      root, runId: 'fixture-cleanup-run', baseUrl, cleanup: true, security,
      scenarios: [{
        id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201],
        requestModel: {
          name: 'CreateProductRequest',
          properties: [{ name: 'CategoryId', type: 'Guid', required: true }],
          dependencies: [{ property: 'CategoryId', entity: 'Category' }]
        },
        fixtureSources: {
          Category: [{
            type: 'ensure-entity',
            list: { url: `${baseUrl}/categories`, predicates: [{ property: 'isActive', operator: 'equals', value: 'no-match' }] },
            create: { url: `${baseUrl}/categories`, body: { name: 'Auto' } }
          }]
        }
      }]
    });

    const created = await readArtifact(root, 'fixture-cleanup-run', 'created.json');
    assert.equal(created.some(item => item.createdBy === 'ensure-entity'), true);
    assert.deepEqual([...categories.keys()], ['cat-seed'], 'the category it had to invent is gone again');
  });
});

test('makes a run repeatable: the same config twice leaves the same state', async () => {
  await withApi(async ({ baseUrl, products }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-repeatable-'));
    const config = {
      root, baseUrl, cleanup: true, security,
      scenarios: [{ id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } }]
    };

    await runVerification({ ...config, runId: 'first' });
    const afterFirst = products.size;
    await runVerification({ ...config, runId: 'second' });

    assert.equal(afterFirst, 0);
    assert.equal(products.size, 0, 'a second run must not inherit the first run\'s leftovers');
  });
});

test('never deletes while a decision is pending, then finishes the job on resume', async () => {
  await withApi(async ({ baseUrl, products }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-cleanup-pause-'));
    const adapter = path.join(root, 'adapter.mjs');
    await writeFile(adapter, `
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const responses = {
    diagnose: { status: 'APPLICATION_BUG', summary: 'Confirmed defect.' },
    fix: { status: 'SUCCESS', summary: 'Applied fix.' },
    review: { status: 'APPROVED', summary: 'Correct.' }
  };
  process.stdout.write(JSON.stringify(responses[process.env.TESTLOOP_ROLE] ?? { status: 'INCONCLUSIVE' }));
});
`, 'utf8');

    const config = {
      root, runId: 'pause-run', baseUrl, cleanup: true, security,
      roles: { diagnose: { command: ['node', adapter] }, fix: { command: ['node', adapter] }, review: { command: ['node', adapter] } },
      scenarios: [{ id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } }]
    };

    const paused = await runVerification(config);
    assert.equal(paused.status, 'AWAITING_APPROVAL');
    const ledger = await readArtifact(root, 'pause-run', 'created.json');
    assert.deepEqual(ledger, [], 'the failing POST created nothing to record');

    await resumeVerification({ root, runId: 'pause-run', scenarioId: 'create-product', decision: 'approve' });
    assert.equal(products.size, 0, 'the record the retest created is removed once the run is really over');
  }, { failFirstProduct: true });
});

test('a failed deletion is reported, not thrown', async () => {
  await withApi(async ({ baseUrl }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-cleanup-fail-'));
    const result = await runVerification({
      root, runId: 'cleanup-fail-run', baseUrl, cleanup: true, security,
      // /widgets accepts the POST but has no delete route, so cleanup cannot succeed.
      scenarios: [{ id: 'create-widget', method: 'POST', path: '/widgets', expectedStatuses: [404] }]
    });

    assert.equal(result.status, 'PASS', 'cleanup trouble never rewrites the verification verdict');
    const outcome = await readArtifact(root, 'cleanup-fail-run', 'cleanup.json');
    assert.deepEqual(outcome, { attempted: false, removed: [], failed: [] }, 'a non-2xx POST created nothing');
  });
});
