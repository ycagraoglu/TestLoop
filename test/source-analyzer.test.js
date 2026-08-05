import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeAspNetSource } from '../src/source-analyzer.js';

test('extracts endpoints, request dependencies, validators and EF foreign keys', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'testloop-source-'));
  await mkdir(path.join(root, 'Controllers'));
  await writeFile(path.join(root, 'Controllers', 'ProductsController.cs'), `
[ApiController]
[Route("api/[controller]")]
[Authorize(Roles = "Admin")]
public class ProductsController : ControllerBase
{
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateProductRequest request) { }

    [HttpGet("{id}")]
    public IActionResult Get([FromRoute] Guid id) { }
}

public sealed class CreateProductRequest
{
    [Required]
    public string Name { get; init; }
    public Guid CategoryId { get; init; }
}

public sealed class CreateProductRequestValidator : AbstractValidator<CreateProductRequest>
{
    public CreateProductRequestValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(100);
    }
}

public class Product
{
    public Guid Id { get; set; }
    public Guid CategoryId { get; set; }
}

public class Category
{
    public Guid Id { get; set; }
}

public sealed class ProductConfiguration
{
    public void Configure(EntityTypeBuilder<Product> builder)
    {
        builder.HasOne<Category>().WithMany().HasForeignKey<Product>(x => x.CategoryId);
    }
}`);

  const result = await analyzeAspNetSource(root);
  assert.equal(result.summary.controllers, 1);
  assert.equal(result.summary.endpoints, 2);
  assert.equal(result.controllers[0].endpoints[0].route, '/api/Products');
  assert.equal(result.controllers[0].endpoints[0].requestType, 'CreateProductRequest');
  assert.deepEqual(result.controllers[0].authorize.roles, ['Admin']);
  assert.equal(result.requestModels[0].validator, 'CreateProductRequestValidator');
  assert.deepEqual(result.requestModels[0].dependencies[0], {
    property: 'CategoryId',
    entity: 'Category',
    resolution: 'ef-core-metadata',
    confidence: 'high',
    randomValueAllowed: false
  });
  assert.deepEqual(result.validators[0].rules[0].constraints, [
    { type: 'not-empty' },
    { type: 'max-length', value: 100 }
  ]);
});
