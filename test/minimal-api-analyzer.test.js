import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeMinimalApiEndpoints } from '../src/minimal-api-analyzer.js';

const byRoute = endpoints => Object.fromEntries(endpoints.map(item => [`${item.method} ${item.route}`, item]));

test('resolves group prefixes, including a group built on a group', () => {
  const endpoints = byRoute(analyzeMinimalApiEndpoints(`
var api = app.MapGroup("/api");
var products = api.MapGroup("/products");
products.MapGet("/{id}", (Guid id) => Results.Ok());
app.MapGet("/health", () => Results.Ok());`));

  assert.equal(Object.hasOwn(endpoints, 'GET /api/products/{id}'), true);
  assert.equal(Object.hasOwn(endpoints, 'GET /health'), true, 'an endpoint mapped on the app itself has no prefix');
});

test('inherits authorization from the group and lets an endpoint opt out', () => {
  const endpoints = byRoute(analyzeMinimalApiEndpoints(`
var api = app.MapGroup("/api").RequireAuthorization();
var admin = api.MapGroup("/admin").RequireAuthorization("Admin", "Owner");
api.MapGet("/products", () => Results.Ok());
api.MapGet("/status", () => Results.Ok()).AllowAnonymous();
admin.MapDelete("/products/{id}", (Guid id) => Results.NoContent());`));

  assert.equal(endpoints['GET /api/products'].authorize.required, true);
  assert.deepEqual(endpoints['GET /api/products'].authorize.roles, []);
  assert.equal(endpoints['GET /api/status'].authorize, null, 'AllowAnonymous overrides the group');
  assert.deepEqual(endpoints['DELETE /api/admin/products/{id}'].authorize.roles, ['Admin', 'Owner']);
});

test('reads the request model out of the handler signature', () => {
  const endpoints = byRoute(analyzeMinimalApiEndpoints(`
app.MapPost("/products", (CreateProductRequest request) => Results.Created());
app.MapPut("/products/{id}", async (Guid id, [FromBody] UpdateProductRequest request) => Results.Ok());
app.MapGet("/products", (IProductService service) => Results.Ok());`));

  assert.equal(endpoints['POST /products'].requestType, 'CreateProductRequest');
  assert.equal(endpoints['PUT /products/{id}'].requestType, 'UpdateProductRequest', 'an async lambda with [FromBody] reads the same');
  assert.equal(endpoints['GET /products'].requestType, null, 'an injected service is not a request body');
  assert.deepEqual(
    endpoints['PUT /products/{id}'].parameters.map(item => `${item.type} ${item.name}`),
    ['Guid id', 'UpdateProductRequest request']
  );
});

test('ignores a map call it cannot read rather than inventing a route', () => {
  const endpoints = analyzeMinimalApiEndpoints(`
app.MapGet(RouteConstants.Products, () => Results.Ok());
app.MapControllers();
app.MapOpenApi();
app.MapGet("/ok", () => Results.Ok());`);

  assert.deepEqual(endpoints.map(item => item.route), ['/ok'],
    'a route held in a constant is skipped; the plan takes its routes from OpenAPI anyway');
});

test('handles a handler that is a method group', () => {
  const endpoints = analyzeMinimalApiEndpoints('app.MapGet("/products", ProductHandlers.GetAll);');
  assert.equal(endpoints[0].route, '/products');
  assert.equal(endpoints[0].requestType, null);
  assert.deepEqual(endpoints[0].parameters, []);
});

test('a minimal API project reaches deep mode with the same enrichment a controller gets', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const { analyzeAspNetSource } = await import('../src/source-analyzer.js');
  const { buildTestPlan } = await import('../src/test-planner.js');
  const { scaffoldRunConfig } = await import('../src/config-scaffolder.js');

  const root = await mkdtemp(nodePath.join(os.tmpdir(), 'testloop-minimal-deep-'));
  await mkdir(nodePath.join(root, 'Api'));
  await writeFile(nodePath.join(root, 'Api', 'ProductEndpoints.cs'), `
public record CreateProductRequest(string Name, decimal Price, Guid CategoryId);

public static class ProductEndpoints
{
    public static void MapProductEndpoints(this IEndpointRouteBuilder app)
    {
        var products = app.MapGroup("/api/products").RequireAuthorization();
        products.MapPost("/", (CreateProductRequest request) => Results.Created());
    }
}

public class CreateProductRequestValidator : AbstractValidator<CreateProductRequest>
{
    public CreateProductRequestValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(80);
    }
}`);

  const sourceManifest = await analyzeAspNetSource(root);
  const plan = buildTestPlan({
    operations: [{ id: 'CreateProduct', method: 'POST', route: '/api/products', requestBodyRequired: true }],
    sourceManifest,
    mode: 'deep'
  });
  const config = scaffoldRunConfig({ plan, sourceManifest, baseUrl: 'http://127.0.0.1:5099' });
  const ids = config.scenarios.map(scenario => scenario.id);

  assert.equal(plan.groups[0].operations[0].source !== null, true, 'the OpenAPI operation found its minimal-API source');
  assert.equal(config.scenarios[0].requestModel.name, 'CreateProductRequest', 'the positional record became a request model');
  assert.equal(config.scenarios[0].validator.rules.length, 1, 'its validator came with it');
  assert.equal(ids.includes('post-api-products-rejects-anonymous'), true, 'RequireAuthorization on the group became an anonymous check');
  assert.equal(ids.includes('post-api-products-rejects-name-not-empty'), true, 'the validator rule became a boundary check');
});
