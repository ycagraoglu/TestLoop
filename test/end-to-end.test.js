import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runVerification } from '../src/orchestrator.js';
import { resumeVerification } from '../src/resume.js';

// Written into each test's own tmpdir (never into the repo) so Node's test-file discovery,
// which recursively picks up any .js file under a directory named "test", never mistakes it
// for a test and hangs waiting on its stdin.
const ROLE_ADAPTER_SOURCE = `
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const responses = {
    diagnose: { status: 'APPLICATION_BUG', summary: 'Confirmed defect for testing.' },
    fix: { status: 'SUCCESS', summary: 'Applied fix.' },
    review: { status: 'APPROVED', summary: 'Fix looks correct.' }
  };
  const role = process.env.TESTLOOP_ROLE;
  process.stdout.write(JSON.stringify(responses[role] ?? { status: 'INCONCLUSIVE' }));
});
`;

async function writeRoleAdapter(directory) {
  const target = path.join(directory, 'role-adapter.mjs');
  await writeFile(target, ROLE_ADAPTER_SOURCE, 'utf8');
  return target;
}

// Same canned responses, but also dumps the fix role's raw input next to itself so a test can
// assert on what TestLoop actually sent (e.g. projectInstructions), same never-in-the-repo reasoning.
const CAPTURING_ROLE_ADAPTER_SOURCE = `
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  const responses = {
    diagnose: { status: 'APPLICATION_BUG', summary: 'Confirmed defect for testing.' },
    fix: { status: 'SUCCESS', summary: 'Applied fix.' },
    review: { status: 'APPROVED', summary: 'Fix looks correct.' }
  };
  const role = process.env.TESTLOOP_ROLE;
  if (role === 'fix') writeFileSync(new URL('./fix-input.json', import.meta.url), JSON.stringify(payload.input));
  process.stdout.write(JSON.stringify(responses[role] ?? { status: 'INCONCLUSIVE' }));
});
`;

async function writeCapturingRoleAdapter(directory) {
  const target = path.join(directory, 'capturing-role-adapter.mjs');
  await writeFile(target, CAPTURING_ROLE_ADAPTER_SOURCE, 'utf8');
  return target;
}

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
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'] },
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
      root,
      baseUrl,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'] },
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

test('pauses for human approval on a confirmed bug, then resumes to PASS after approval', async () => {
  let productCalls = 0;
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/products' && request.method === 'POST') {
      productCalls += 1;
      response.statusCode = productCalls === 1 ? 500 : 201;
      return response.end(JSON.stringify({ id: 'product-1' }));
    }
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-approval-'));
    const roleAdapter = await writeRoleAdapter(root);
    const config = {
      root,
      runId: 'approval-run',
      baseUrl,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'], allowedCommands: ['node'] },
      roles: {
        diagnose: { command: ['node', roleAdapter] },
        fix: { command: ['node', roleAdapter] },
        review: { command: ['node', roleAdapter] }
      },
      scenarios: [{ id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } }]
    };

    const first = await runVerification(config);
    assert.equal(first.status, 'AWAITING_APPROVAL');
    assert.equal(first.results[0].status, 'AWAITING_APPROVAL');
    assert.equal(first.results[0].diagnosis.status, 'APPLICATION_BUG');
    assert.equal(productCalls, 1, 'the fix role must not run before approval, so no retest should happen yet');

    const resumed = await resumeVerification({ root, runId: 'approval-run', scenarioId: 'create-product', decision: 'approve' });
    assert.equal(resumed.status, 'PASS');
    assert.equal(resumed.classification, 'PASS_AFTER_FIX');
    assert.equal(productCalls, 2);
  });
});

test('declining a confirmed bug marks the scenario SKIPPED and never calls the fix role', async () => {
  let fixCalls = 0;
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.statusCode = request.url === '/products' && request.method === 'POST' ? 500 : 404;
    response.end(JSON.stringify({ id: 'product-1' }));
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-decline-'));
    const roleAdapter = await writeRoleAdapter(root);
    const config = {
      root,
      runId: 'decline-run',
      baseUrl,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'], allowedCommands: ['node'] },
      roles: { diagnose: { command: ['node', roleAdapter] } },
      scenarios: [{ id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } }]
    };

    const first = await runVerification(config);
    assert.equal(first.status, 'AWAITING_APPROVAL');

    const resumed = await resumeVerification({ root, runId: 'decline-run', scenarioId: 'create-product', decision: 'decline' });
    assert.equal(resumed.status, 'SKIPPED');
    assert.equal(fixCalls, 0);
  });
});

test('requireApproval: false fixes immediately without pausing for human approval', async () => {
  let productCalls = 0;
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/products' && request.method === 'POST') {
      productCalls += 1;
      response.statusCode = productCalls === 1 ? 500 : 201;
      return response.end(JSON.stringify({ id: 'product-1' }));
    }
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-direct-fix-'));
    const roleAdapter = await writeRoleAdapter(root);
    const config = {
      root,
      runId: 'direct-fix-run',
      baseUrl,
      requireApproval: false,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'], allowedCommands: ['node'] },
      roles: {
        diagnose: { command: ['node', roleAdapter] },
        fix: { command: ['node', roleAdapter] },
        review: { command: ['node', roleAdapter] }
      },
      scenarios: [{ id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } }]
    };

    const result = await runVerification(config);
    assert.equal(result.status, 'PASS');
    assert.equal(result.results[0].status, 'PASS');
    assert.equal(result.results[0].classification, 'PASS_AFTER_FIX');
    assert.equal(productCalls, 2, 'the fix role must run immediately, in the same process, without testloop resume');
  });
});

test('passes the target project\'s AGENTS.md/SKILL.md to the fix role when present', async () => {
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.statusCode = request.url === '/products' && request.method === 'POST' ? 500 : 404;
    response.end(JSON.stringify({ id: 'product-1' }));
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-instructions-'));
    await writeFile(path.join(root, 'AGENTS.md'), '# Project rules\nUse the repository pattern.\n', 'utf8');
    const roleAdapter = await writeCapturingRoleAdapter(root);
    const config = {
      root,
      runId: 'instructions-run',
      baseUrl,
      requireApproval: false,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'], allowedCommands: ['node'] },
      roles: {
        diagnose: { command: ['node', roleAdapter] },
        fix: { command: ['node', roleAdapter] },
        review: { command: ['node', roleAdapter] }
      },
      scenarios: [{ id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } }]
    };

    await runVerification(config);
    const captured = JSON.parse(await readFile(path.join(root, 'fix-input.json'), 'utf8'));
    assert.equal(captured.projectInstructions.length, 1);
    assert.equal(captured.projectInstructions[0].file, 'AGENTS.md');
    assert.match(captured.projectInstructions[0].content, /repository pattern/);
  });
});

test('projectInstructions is null for the fix role when no AGENTS.md or SKILL.md exists', async () => {
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.statusCode = request.url === '/products' && request.method === 'POST' ? 500 : 404;
    response.end(JSON.stringify({ id: 'product-1' }));
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-no-instructions-'));
    const roleAdapter = await writeCapturingRoleAdapter(root);
    const config = {
      root,
      runId: 'no-instructions-run',
      baseUrl,
      requireApproval: false,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'], allowedCommands: ['node'] },
      roles: {
        diagnose: { command: ['node', roleAdapter] },
        fix: { command: ['node', roleAdapter] },
        review: { command: ['node', roleAdapter] }
      },
      scenarios: [{ id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } }]
    };

    await runVerification(config);
    const captured = JSON.parse(await readFile(path.join(root, 'fix-input.json'), 'utf8'));
    assert.equal(captured.projectInstructions, null);
  });
});
