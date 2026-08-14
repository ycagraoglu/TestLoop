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

// Writes an adapter answering with caller-chosen statuses, for the paths where the canned
// APPLICATION_BUG/SUCCESS/APPROVED trio is not what is under test.
async function writeStatusAdapter(directory, responses, filename = 'status-adapter.mjs') {
  const target = path.join(directory, filename);
  await writeFile(target, `
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const responses = ${JSON.stringify(responses)};
  process.stdout.write(JSON.stringify(responses[process.env.TESTLOOP_ROLE] ?? { status: 'INCONCLUSIVE' }));
});
`, 'utf8');
  return target;
}

function readSummary(root, runId) {
  return readFile(path.join(root, '.testloop', 'runs', runId, 'summary.json'), 'utf8').then(JSON.parse);
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
    process.env.TESTLOOP_E2E_PASSWORD = 'b';
    const result = await runVerification({
      root,
      runId: 'e2e-run',
      baseUrl,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'] },
      auth: { type: 'login', url: `${baseUrl}/login`, body: { email: 'a', password: { $env: 'TESTLOOP_E2E_PASSWORD' } }, tokenPath: 'data.accessToken' },
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

test('propagates a captured value into a later scenario\'s path via {scenario.captured} interpolation', async () => {
  const productRequests = [];
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/products' && request.method === 'POST') {
      response.statusCode = 201;
      return response.end(JSON.stringify({ id: 'created-id-123' }));
    }
    if (request.url?.startsWith('/products/')) {
      productRequests.push(request.url);
      response.statusCode = 200;
      return response.end(JSON.stringify({ id: request.url.split('/').pop() }));
    }
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-interpolate-'));
    const result = await runVerification({
      root,
      baseUrl,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'] },
      scenarios: [
        { id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' }, capture: { productId: 'id' } },
        { id: 'get-product', method: 'GET', path: '/products/{create-product.productId}', expectedStatuses: [200] }
      ]
    });

    assert.equal(result.status, 'PASS');
    assert.equal(result.results[1].status, 'PASS');
    assert.deepEqual(productRequests, ['/products/created-id-123']);
  });
});

test('a fixed, then-approved scenario hands its captured output to the next scenario, which then runs', async () => {
  let productCalls = 0;
  const productRequests = [];
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/products' && request.method === 'POST') {
      productCalls += 1;
      response.statusCode = productCalls === 1 ? 500 : 201;
      return response.end(JSON.stringify({ id: 'fixed-product-id' }));
    }
    if (request.url?.startsWith('/products/')) {
      productRequests.push(request.url);
      response.statusCode = 200;
      return response.end(JSON.stringify({ id: request.url.split('/').pop() }));
    }
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-resume-chain-'));
    const roleAdapter = await writeRoleAdapter(root);
    const config = {
      root,
      runId: 'resume-chain-run',
      baseUrl,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'], allowedCommands: ['node'] },
      roles: {
        diagnose: { command: ['node', roleAdapter] },
        fix: { command: ['node', roleAdapter] },
        review: { command: ['node', roleAdapter] }
      },
      scenarios: [
        { id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' }, capture: { productId: 'id' } },
        { id: 'get-product', method: 'GET', path: '/products/{create-product.productId}', expectedStatuses: [200] }
      ]
    };

    const first = await runVerification(config);
    assert.equal(first.status, 'AWAITING_APPROVAL');
    assert.equal(first.results.length, 1, 'get-product must not have been attempted yet: the loop breaks at AWAITING_APPROVAL');

    const resumed = await resumeVerification({ root, runId: 'resume-chain-run', scenarioId: 'create-product', decision: 'approve' });
    assert.equal(resumed.status, 'PASS');
    assert.equal(resumed.output.productId, 'fixed-product-id');
    assert.deepEqual(productRequests, ['/products/fixed-product-id'], 'get-product must have used the fixed run\'s captured id, not a stale/missing one');

    const summaryPath = path.join(root, '.testloop', 'runs', 'resume-chain-run', 'summary.json');
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    assert.equal(summary.status, 'PASS');
    assert.deepEqual(summary.results.map(item => item.id), ['create-product', 'get-product']);
    assert.equal(summary.results[1].status, 'PASS');
  });
});

test('declining still lets an independent later scenario run', async () => {
  let healthCalls = 0;
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/products' && request.method === 'POST') { response.statusCode = 500; return response.end('{}'); }
    if (request.url === '/health') { healthCalls += 1; response.statusCode = 200; return response.end('{}'); }
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-decline-chain-'));
    const roleAdapter = await writeRoleAdapter(root);
    const config = {
      root,
      runId: 'decline-chain-run',
      baseUrl,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'], allowedCommands: ['node'] },
      roles: { diagnose: { command: ['node', roleAdapter] } },
      scenarios: [
        { id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } },
        { id: 'health-check', method: 'GET', path: '/health', expectedStatuses: [200] }
      ]
    };

    const first = await runVerification(config);
    assert.equal(first.status, 'AWAITING_APPROVAL');
    assert.equal(first.results.length, 1);

    await resumeVerification({ root, runId: 'decline-chain-run', scenarioId: 'create-product', decision: 'decline' });
    assert.equal(healthCalls, 1, 'health-check must have run after the decline, not been stranded');

    const summaryPath = path.join(root, '.testloop', 'runs', 'decline-chain-run', 'summary.json');
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    assert.deepEqual(summary.results.map(item => item.id), ['create-product', 'health-check']);
    assert.equal(summary.results[0].status, 'SKIPPED');
    assert.equal(summary.results[1].status, 'PASS');
  });
});

test('re-authenticates before the post-fix retest instead of reusing a possibly-stale token', async () => {
  let loginCalls = 0;
  let productCalls = 0;
  const productAuthHeaders = [];
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/login') {
      loginCalls += 1;
      return response.end(JSON.stringify({ token: `token-${loginCalls}` }));
    }
    if (request.url === '/products' && request.method === 'POST') {
      productCalls += 1;
      productAuthHeaders.push(request.headers.authorization);
      response.statusCode = productCalls === 1 ? 500 : 201;
      return response.end(JSON.stringify({ id: 'product-1' }));
    }
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-reauth-'));
    const roleAdapter = await writeRoleAdapter(root);
    const config = {
      root,
      runId: 'reauth-run',
      baseUrl,
      requireApproval: false,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'], allowedCommands: ['node'] },
      auth: { type: 'login', url: `${baseUrl}/login`, method: 'POST', body: {}, tokenPath: 'token' },
      roles: {
        diagnose: { command: ['node', roleAdapter] },
        fix: { command: ['node', roleAdapter] },
        review: { command: ['node', roleAdapter] }
      },
      scenarios: [{ id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } }]
    };

    const result = await runVerification(config);
    assert.equal(result.status, 'PASS');
    assert.equal(loginCalls, 2, 'once for the initial run, once again before the retest');
    assert.deepEqual(productAuthHeaders, ['Bearer token-1', 'Bearer token-2']);
  });
});

test('reports a SPEC_MISMATCH diagnosis instead of crashing the run on it', async () => {
  let productCalls = 0;
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/products' && request.method === 'POST') {
      productCalls += 1;
      response.statusCode = 500;
      return response.end('{}');
    }
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-spec-mismatch-'));
    const adapter = await writeStatusAdapter(root, { diagnose: { status: 'SPEC_MISMATCH', summary: 'Contract and runtime differ.' } });
    const result = await runVerification({
      root,
      runId: 'spec-mismatch-run',
      baseUrl,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'], allowedCommands: ['node'] },
      roles: { diagnose: { command: ['node', adapter] }, fix: { command: ['node', adapter] } },
      scenarios: [{ id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } }]
    });

    assert.equal(result.status, 'SPEC_MISMATCH', 'a spec mismatch must not be summarized as an overall PASS');
    assert.equal(result.results[0].status, 'SPEC_MISMATCH');
    assert.equal(result.results[0].fix, undefined, 'SPEC_MISMATCH is reported, never repaired');
    assert.equal(productCalls, 1, 'no retest should have happened');
    assert.equal((await readSummary(root, 'spec-mismatch-run')).status, 'SPEC_MISMATCH');
  });
});

test('a throwing role costs one scenario, not the run\'s evidence trail', async () => {
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.statusCode = request.url === '/products' && request.method === 'POST' ? 500 : 200;
    response.end('{}');
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-role-throw-'));
    const adapter = await writeStatusAdapter(root, { diagnose: { status: 'NOT_A_REAL_STATUS', summary: 'malformed' } });
    const result = await runVerification({
      root,
      runId: 'role-throw-run',
      baseUrl,
      stopOnFailure: false,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'], allowedCommands: ['node'] },
      roles: { diagnose: { command: ['node', adapter] } },
      scenarios: [
        { id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } },
        { id: 'health-check', method: 'GET', path: '/health', expectedStatuses: [200] }
      ]
    });

    assert.equal(result.results[0].status, 'ESCALATED');
    assert.equal(result.results[0].classification, 'RUNNER_ERROR');
    assert.match(result.results[0].reason, /Invalid diagnosis status/);
    assert.equal(result.results[1].status, 'PASS', 'the next scenario still ran');

    const summary = await readSummary(root, 'role-throw-run');
    assert.equal(summary.results.length, 2, 'summary.json must exist and hold the full evidence trail');
  });
});

test('smoke mode reports a confirmed defect without ever invoking the fix role', async () => {
  let productCalls = 0;
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/products' && request.method === 'POST') {
      productCalls += 1;
      response.statusCode = productCalls === 1 ? 500 : 201;
      return response.end('{"id":"product-1"}');
    }
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-smoke-'));
    const roleAdapter = await writeRoleAdapter(root);
    const result = await runVerification({
      root,
      runId: 'smoke-run',
      baseUrl,
      mode: 'smoke',
      requireApproval: false,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'], allowedCommands: ['node'] },
      roles: {
        diagnose: { command: ['node', roleAdapter] },
        fix: { command: ['node', roleAdapter] },
        review: { command: ['node', roleAdapter] }
      },
      scenarios: [{ id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } }]
    });

    assert.equal(result.results[0].status, 'FAIL');
    assert.equal(result.results[0].classification, 'APPLICATION_BUG');
    assert.equal(result.results[0].fix, undefined, 'smoke must not repair, even with requireApproval disabled');
    assert.equal(productCalls, 1, 'no retest means no fix chain ran');
  });
});

test('a declined scenario blocks its dependent instead of reporting a runner malfunction', async () => {
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.statusCode = request.url === '/products' && request.method === 'POST' ? 500 : 200;
    response.end('{}');
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-declined-dep-'));
    const roleAdapter = await writeRoleAdapter(root);
    const config = {
      root,
      runId: 'declined-dep-run',
      baseUrl,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'], allowedCommands: ['node'] },
      roles: { diagnose: { command: ['node', roleAdapter] } },
      scenarios: [
        { id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' }, capture: { productId: 'id' } },
        { id: 'get-product', method: 'GET', path: '/products/{create-product.productId}', expectedStatuses: [200] }
      ]
    };

    await runVerification(config);
    await resumeVerification({ root, runId: 'declined-dep-run', scenarioId: 'create-product', decision: 'decline' });

    const summary = await readSummary(root, 'declined-dep-run');
    assert.equal(summary.results[0].status, 'SKIPPED');
    assert.equal(summary.results[1].status, 'BLOCKED', 'an unproduced dependency is an unmet precondition, not a runner error');
    assert.equal(summary.results[1].classification, 'UNRESOLVED_DEPENDENCY');
    assert.equal(summary.status, 'BLOCKED', 'nothing actually failed: a human chose to skip');
  });
});

test('a mid-run 401 is an authentication problem, not a failure or a bug', async () => {
  await withServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.setHeader('content-type', 'application/json');
    if (request.url === '/login') return response.end(JSON.stringify({ token: 'jwt-abc' }));
    response.statusCode = 401;
    response.end(JSON.stringify({ error: 'token expired' }));
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-expired-'));
    const result = await runVerification({
      root,
      runId: 'expired-run',
      baseUrl,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'] },
      auth: { type: 'login', url: `${baseUrl}/login`, body: {}, tokenPath: 'token' },
      scenarios: [{ id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } }]
    });

    assert.equal(result.results[0].status, 'BLOCKED', 'an auth problem is an unmet precondition, never a FAIL');
    assert.equal(result.results[0].classification, 'AUTH_ERROR');
    assert.match(result.results[0].reason, /expired mid-run|role or scope/);
    assert.equal(result.status, 'BLOCKED');
  });
});

test('a scenario that deliberately expects 403 still passes', async () => {
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.statusCode = 403;
    response.end('{"error":"forbidden"}');
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-negative-'));
    const result = await runVerification({
      root,
      runId: 'negative-run',
      baseUrl,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'] },
      scenarios: [{ id: 'reader-cannot-delete', method: 'DELETE', path: '/products/1', expectedStatuses: [403] }]
    });

    assert.equal(result.status, 'PASS', 'deep mode role and tenant checks assert 401/403 on purpose');
    assert.equal(result.results[0].classification, 'PASS');
  });
});

test('never writes a literal credential into the persisted run config', async () => {
  await withServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.setHeader('content-type', 'application/json');
    if (request.url === '/login') return response.end(JSON.stringify({ token: 'jwt-abc' }));
    response.statusCode = 201;
    response.end('{"id":"p1"}');
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-nosecret-'));
    process.env.TESTLOOP_PROBE_PASSWORD = 'S3cret!';
    try {
      await runVerification({
        root,
        runId: 'nosecret-run',
        baseUrl,
        security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'] },
        auth: { type: 'login', url: `${baseUrl}/login`, body: { email: 'a@b.c', password: { $env: 'TESTLOOP_PROBE_PASSWORD' } }, tokenPath: 'token' },
        scenarios: [{ id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } }]
      });

      const persisted = await readFile(path.join(root, '.testloop', 'runs', 'nosecret-run', 'config.json'), 'utf8');
      assert.equal(persisted.includes('S3cret!'), false, 'the resolved secret must never reach disk');
      assert.equal(JSON.parse(persisted).auth.body.password.$env, 'TESTLOOP_PROBE_PASSWORD', 'the pointer survives so resume can re-authenticate');
    } finally {
      delete process.env.TESTLOOP_PROBE_PASSWORD;
    }
  });
});

test('a retest that neither passes nor reproduces the defect is inconclusive, not a failed fix', async () => {
  let productCalls = 0;
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/products' && request.method === 'POST') {
      productCalls += 1;
      // Fails first, then the entity it targeted is gone: exactly what a restart of an app with
      // ephemeral state does to a fixture created earlier in the run.
      response.statusCode = productCalls === 1 ? 500 : 404;
      return response.end('{}');
    }
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-retest-vanished-'));
    const roleAdapter = await writeRoleAdapter(root);
    const result = await runVerification({
      root,
      runId: 'retest-vanished-run',
      baseUrl,
      requireApproval: false,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'], allowedCommands: ['node'] },
      roles: {
        diagnose: { command: ['node', roleAdapter] },
        fix: { command: ['node', roleAdapter] },
        review: { command: ['node', roleAdapter] }
      },
      scenarios: [{ id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } }]
    });

    assert.equal(result.results[0].status, 'BLOCKED');
    assert.equal(result.results[0].classification, 'RETEST_INCONCLUSIVE');
    assert.match(result.results[0].reason, /preconditions no longer hold/);
    assert.equal(result.results[0].fix.status, 'SUCCESS', 'the fix and review evidence is still preserved');
  });
});

test('a retest that reproduces the original defect is still a failed fix', async () => {
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.statusCode = request.url === '/products' && request.method === 'POST' ? 500 : 404;
    response.end('{}');
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-retest-failed-'));
    const roleAdapter = await writeRoleAdapter(root);
    const result = await runVerification({
      root,
      runId: 'retest-failed-run',
      baseUrl,
      requireApproval: false,
      security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'], allowedCommands: ['node'] },
      roles: {
        diagnose: { command: ['node', roleAdapter] },
        fix: { command: ['node', roleAdapter] },
        review: { command: ['node', roleAdapter] }
      },
      scenarios: [{ id: 'create-product', method: 'POST', path: '/products', expectedStatuses: [201], body: { name: 'Widget' } }]
    });

    assert.equal(result.results[0].status, 'FAIL');
    assert.equal(result.results[0].classification, 'RETEST_FAILED');
  });
});

// A repair that fixes its target while breaking a neighbour is the most damaging outcome an
// automated repair loop can produce, and the one a green report hides best.
async function withRepairThatBreaksNeighbour(action) {
  let fixApplied = false;
  return withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/control') { fixApplied = true; response.statusCode = 200; return response.end('{}'); }
    if (request.url === '/a') { response.statusCode = fixApplied ? 500 : 201; return response.end('{}'); }
    if (request.url === '/b') { response.statusCode = fixApplied ? 201 : 500; return response.end('{}'); }
    response.statusCode = 404;
    response.end('{}');
  }, action);
}

async function writeBreakingFixAdapter(directory, baseUrl) {
  const target = path.join(directory, 'breaking-adapter.mjs');
  await writeFile(target, `
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  const role = process.env.TESTLOOP_ROLE;
  if (role === 'fix') await fetch('${baseUrl}/control');
  const responses = {
    diagnose: { status: 'APPLICATION_BUG', summary: 'Confirmed defect.' },
    fix: { status: 'SUCCESS', summary: 'Patched /b.' },
    review: { status: 'APPROVED', summary: 'Looks correct in isolation.' }
  };
  process.stdout.write(JSON.stringify(responses[role] ?? { status: 'INCONCLUSIVE' }));
});
`, 'utf8');
  return target;
}

function repairConfig({ root, baseUrl, adapter, ...overrides }) {
  return {
    root,
    baseUrl,
    requireApproval: false,
    security: { allowPrivateNetwork: true, allowedHosts: ['127.0.0.1'], allowedCommands: ['node'] },
    roles: { diagnose: { command: ['node', adapter] }, fix: { command: ['node', adapter] }, review: { command: ['node', adapter] } },
    scenarios: [
      { id: 'scenario-a', method: 'POST', path: '/a', expectedStatuses: [201] },
      { id: 'scenario-b', method: 'POST', path: '/b', expectedStatuses: [201] }
    ],
    ...overrides
  };
}

test('fails the repair when the fix breaks a scenario that had already passed', async () => {
  await withRepairThatBreaksNeighbour(async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-regression-'));
    const adapter = await writeBreakingFixAdapter(root, baseUrl);
    const result = await runVerification(repairConfig({ root, baseUrl, adapter, runId: 'regression-run' }));

    const repaired = result.results.find(item => item.id === 'scenario-b');
    assert.equal(repaired.classification, 'REGRESSION_DETECTED');
    assert.equal(repaired.status, 'FAIL', 'a repair that breaks a neighbour is not an acceptable repair');
    assert.deepEqual(repaired.regression.checked, ['scenario-a']);
    assert.equal(repaired.regression.broken[0].id, 'scenario-a');
    assert.equal(result.status, 'FAIL', 'the run must never report green after collateral damage');
  });
});

test('records the regression sweep and stays green when the fix breaks nothing', async () => {
  let productCalls = 0;
  await withServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/a') { response.statusCode = 201; return response.end('{}'); }
    if (request.url === '/b') {
      productCalls += 1;
      response.statusCode = productCalls === 1 ? 500 : 201;
      return response.end('{}');
    }
    response.statusCode = 404;
    response.end('{}');
  }, async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-regression-clean-'));
    const adapter = await writeRoleAdapter(root);
    const result = await runVerification(repairConfig({ root, baseUrl, adapter, runId: 'regression-clean-run' }));

    const repaired = result.results.find(item => item.id === 'scenario-b');
    assert.equal(repaired.status, 'PASS');
    assert.deepEqual(repaired.regression, { checked: ['scenario-a'], broken: [] });
    assert.equal(result.status, 'PASS');

    const summary = await readSummary(root, 'regression-clean-run');
    assert.deepEqual(summary.results.find(item => item.id === 'scenario-b').regression.checked, ['scenario-a']);
  });
});

test('keeps the original evidence when a scenario is re-run for the regression sweep', async () => {
  await withRepairThatBreaksNeighbour(async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-regression-evidence-'));
    const adapter = await writeBreakingFixAdapter(root, baseUrl);
    await runVerification(repairConfig({ root, baseUrl, adapter, runId: 'evidence-run' }));

    const directory = path.join(root, '.testloop', 'runs', 'evidence-run');
    const original = JSON.parse(await readFile(path.join(directory, 'scenario-a.execution.json'), 'utf8'));
    const rerun = JSON.parse(await readFile(path.join(directory, 'scenario-a.regression.execution.json'), 'utf8'));

    assert.equal(original.response.status, 201, 'the passing run must survive as evidence');
    assert.equal(rerun.response.status, 500, 'the sweep is recorded separately');
  });
});

test('regressionCheck: false skips the sweep', async () => {
  await withRepairThatBreaksNeighbour(async baseUrl => {
    const root = await mkdtemp(path.join(tmpdir(), 'testloop-regression-off-'));
    const adapter = await writeBreakingFixAdapter(root, baseUrl);
    const result = await runVerification(repairConfig({ root, baseUrl, adapter, runId: 'regression-off-run', regressionCheck: false }));

    const repaired = result.results.find(item => item.id === 'scenario-b');
    assert.equal(repaired.classification, 'PASS_AFTER_FIX');
    assert.equal(repaired.regression, undefined);
  });
});
