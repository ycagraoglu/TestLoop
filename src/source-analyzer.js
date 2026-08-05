import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const IGNORED = new Set(['.git', 'bin', 'obj', 'node_modules', '.testloop']);
const HTTP_ATTRIBUTES = new Map([
  ['HttpGet', 'GET'],
  ['HttpPost', 'POST'],
  ['HttpPut', 'PUT'],
  ['HttpPatch', 'PATCH'],
  ['HttpDelete', 'DELETE']
]);

export async function analyzeAspNetSource(root = process.cwd()) {
  const files = await collectCsFiles(root);
  const parsed = await Promise.all(files.map(async file => parseSourceFile(root, file, await readFile(file, 'utf8'))));

  const controllers = parsed.flatMap(x => x.controllers);
  const requestModels = parsed.flatMap(x => x.requestModels);
  const validators = parsed.flatMap(x => x.validators);
  const entities = parsed.flatMap(x => x.entities);
  const foreignKeys = parsed.flatMap(x => x.foreignKeys);

  const validatorByModel = new Map(validators.map(v => [v.model, v]));
  const entityByName = new Map(entities.map(e => [e.name, e]));

  for (const model of requestModels) {
    model.validator = validatorByModel.get(model.name)?.name ?? null;
    model.dependencies = model.properties
      .filter(property => /Id$/.test(property.name))
      .map(property => inferDependency(property, entityByName, foreignKeys));
  }

  return {
    root: path.resolve(root),
    generatedAt: new Date().toISOString(),
    controllers,
    requestModels,
    validators,
    entities,
    foreignKeys,
    summary: {
      controllers: controllers.length,
      endpoints: controllers.reduce((sum, controller) => sum + controller.endpoints.length, 0),
      requestModels: requestModels.length,
      validators: validators.length,
      entities: entities.length,
      foreignKeys: foreignKeys.length
    }
  };
}

async function collectCsFiles(root) {
  const results = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.name.endsWith('.cs')) results.push(fullPath);
    }
  }
  await walk(root);
  return results;
}

function parseSourceFile(root, file, source) {
  const relativePath = path.relative(root, file);
  return {
    controllers: parseControllers(relativePath, source),
    requestModels: parseRequestModels(relativePath, source),
    validators: parseValidators(relativePath, source),
    entities: parseEntities(relativePath, source),
    foreignKeys: parseForeignKeys(relativePath, source)
  };
}

function parseControllers(file, source) {
  const results = [];
  const classRegex = /(?<attributes>(?:\s*\[[^\]]+\]\s*)*)\s*public\s+(?:sealed\s+)?class\s+(?<name>\w+Controller)\b[^\{]*\{/g;
  for (const match of source.matchAll(classRegex)) {
    const body = extractBlock(source, match.index + match[0].lastIndexOf('{'));
    const classAttributes = parseAttributes(match.groups.attributes);
    const routeTemplate = getAttributeArgument(classAttributes, 'Route') ?? 'api/[controller]';
    const controllerName = match.groups.name.replace(/Controller$/, '');
    const baseRoute = normalizeRoute(routeTemplate.replace('[controller]', controllerName));
    const authorize = parseAuthorize(classAttributes);

    results.push({
      name: match.groups.name,
      file,
      route: baseRoute,
      authorize,
      endpoints: parseActions(body, baseRoute, authorize)
    });
  }
  return results;
}

function parseActions(body, baseRoute, inheritedAuthorize) {
  const endpoints = [];
  const methodRegex = /(?<attributes>(?:\s*\[[^\]]+\]\s*)+)\s*public\s+(?:async\s+)?(?<returnType>[\w<>,?\.\[\]\s]+?)\s+(?<name>\w+)\s*\((?<params>[\s\S]*?)\)\s*(?:\{|=>)/g;
  for (const match of body.matchAll(methodRegex)) {
    const attributes = parseAttributes(match.groups.attributes);
    const httpAttribute = attributes.find(attribute => HTTP_ATTRIBUTES.has(attribute.name));
    if (!httpAttribute) continue;

    const parameters = parseParameters(match.groups.params);
    const requestBody = parameters.find(parameter => parameter.source === 'body') ?? inferBodyParameter(parameters, HTTP_ATTRIBUTES.get(httpAttribute.name));
    const actionRoute = httpAttribute.argument ?? '';
    const authorize = parseAuthorize(attributes) ?? inheritedAuthorize;

    endpoints.push({
      operationId: match.groups.name,
      method: HTTP_ATTRIBUTES.get(httpAttribute.name),
      route: joinRoute(baseRoute, actionRoute),
      returnType: compactType(match.groups.returnType),
      authorize,
      requestType: requestBody?.type ?? null,
      parameters
    });
  }
  return endpoints;
}

function parseRequestModels(file, source) {
  const results = [];
  const classRegex = /public\s+(?:sealed\s+)?(?:class|record)\s+(?<name>\w+(?:Request|Command|Dto))\b[^\{]*\{/g;
  for (const match of source.matchAll(classRegex)) {
    const body = extractBlock(source, match.index + match[0].lastIndexOf('{'));
    results.push({ name: match.groups.name, file, properties: parseProperties(body), validator: null, dependencies: [] });
  }
  return results;
}

function parseEntities(file, source) {
  const results = [];
  const classRegex = /public\s+(?:sealed\s+)?class\s+(?<name>\w+)\b[^\{]*\{/g;
  for (const match of source.matchAll(classRegex)) {
    const name = match.groups.name;
    if (/Controller$|Request$|Command$|Dto$|Validator$/.test(name)) continue;
    const body = extractBlock(source, match.index + match[0].lastIndexOf('{'));
    const properties = parseProperties(body);
    if (!properties.some(property => property.name === 'Id')) continue;
    results.push({ name, file, properties });
  }
  return results;
}

function parseValidators(file, source) {
  const results = [];
  const regex = /public\s+(?:sealed\s+)?class\s+(?<name>\w+Validator)\s*:\s*AbstractValidator<(?<model>[^>]+)>/g;
  for (const match of source.matchAll(regex)) {
    const body = extractBlock(source, source.indexOf('{', match.index));
    const rules = [];
    const ruleRegex = /RuleFor\s*\(\s*\w+\s*=>\s*\w+\.(?<property>\w+)\s*\)(?<chain>[\s\S]*?);/g;
    for (const rule of body.matchAll(ruleRegex)) {
      rules.push({ property: rule.groups.property, constraints: parseRuleChain(rule.groups.chain) });
    }
    results.push({ name: match.groups.name, model: compactType(match.groups.model), file, rules });
  }
  return results;
}

function parseForeignKeys(file, source) {
  const results = [];
  const regex = /HasOne(?:<(?<targetGeneric>[^>]+)>)?\s*\([^\)]*\)\s*[\s\S]{0,500}?\.HasForeignKey(?:<(?<sourceGeneric>[^>]+)>)?\s*\(\s*\w+\s*=>\s*\w+\.(?<property>\w+)\s*\)/g;
  for (const match of source.matchAll(regex)) {
    results.push({
      file,
      property: match.groups.property,
      sourceEntity: compactType(match.groups.sourceGeneric ?? '') || null,
      targetEntity: compactType(match.groups.targetGeneric ?? '') || null,
      confidence: match.groups.targetGeneric || match.groups.sourceGeneric ? 'high' : 'medium'
    });
  }
  return results;
}

function parseProperties(body) {
  const properties = [];
  const regex = /(?<attributes>(?:\s*\[[^\]]+\]\s*)*)\s*public\s+(?<type>[\w<>,?\.\[\]]+)\s+(?<name>\w+)\s*\{\s*get;\s*(?:init|set);\s*\}/g;
  for (const match of body.matchAll(regex)) {
    const attributes = parseAttributes(match.groups.attributes);
    properties.push({
      name: match.groups.name,
      type: compactType(match.groups.type),
      required: attributes.some(attribute => attribute.name === 'Required') || !match.groups.type.endsWith('?'),
      attributes: attributes.map(attribute => attribute.name)
    });
  }
  return properties;
}

function parseParameters(text) {
  return splitTopLevel(text).filter(Boolean).map(parameter => {
    const attributeMatch = parameter.match(/^\s*\[(?<attribute>[^\]]+)\]\s*/);
    const source = attributeMatch ? parameterSource(attributeMatch.groups.attribute) : null;
    const clean = parameter.replace(/^\s*\[[^\]]+\]\s*/, '').trim();
    const parts = clean.split(/\s+/);
    return { name: parts.at(-1)?.replace(/=.*/, '') ?? '', type: compactType(parts.slice(0, -1).join(' ')), source };
  });
}

function inferBodyParameter(parameters, method) {
  if (!['POST', 'PUT', 'PATCH'].includes(method)) return null;
  return parameters.find(parameter => /Request$|Command$|Dto$/.test(parameter.type) && parameter.source !== 'route' && parameter.source !== 'query') ?? null;
}

function inferDependency(property, entityByName, foreignKeys) {
  const entityName = property.name.replace(/Id$/, '');
  const explicit = foreignKeys.find(foreignKey => foreignKey.property === property.name);
  return {
    property: property.name,
    entity: explicit?.targetEntity ?? (entityByName.has(entityName) ? entityName : null),
    resolution: explicit ? 'ef-core-metadata' : entityByName.has(entityName) ? 'name-and-entity-match' : 'unresolved',
    confidence: explicit?.confidence ?? (entityByName.has(entityName) ? 'medium' : 'low'),
    randomValueAllowed: false
  };
}

function parseAttributes(text = '') {
  const attributes = [];
  const regex = /\[(?<name>\w+)(?:\((?<argument>[\s\S]*?)\))?\]/g;
  for (const match of text.matchAll(regex)) {
    attributes.push({ name: match.groups.name, argument: unquote(match.groups.argument?.trim()) });
  }
  return attributes;
}

function parseAuthorize(attributes) {
  const attribute = attributes.find(item => item.name === 'Authorize');
  if (!attribute) return null;
  const roles = attribute.argument?.match(/Roles\s*=\s*"([^"]+)"/)?.[1]?.split(',').map(value => value.trim()) ?? [];
  const policy = attribute.argument?.match(/Policy\s*=\s*"([^"]+)"/)?.[1] ?? null;
  return { required: true, roles, policy };
}

function getAttributeArgument(attributes, name) {
  return attributes.find(attribute => attribute.name === name)?.argument ?? null;
}

function parseRuleChain(chain) {
  const constraints = [];
  if (/\.NotEmpty\s*\(/.test(chain)) constraints.push({ type: 'not-empty' });
  if (/\.NotNull\s*\(/.test(chain)) constraints.push({ type: 'not-null' });
  const max = chain.match(/\.MaximumLength\s*\(\s*(\d+)\s*\)/)?.[1];
  if (max) constraints.push({ type: 'max-length', value: Number(max) });
  const min = chain.match(/\.MinimumLength\s*\(\s*(\d+)\s*\)/)?.[1];
  if (min) constraints.push({ type: 'min-length', value: Number(min) });
  const greater = chain.match(/\.GreaterThan\s*\(\s*([\d.]+)\s*\)/)?.[1];
  if (greater) constraints.push({ type: 'greater-than', value: Number(greater) });
  return constraints;
}

function parameterSource(attribute) {
  if (attribute.startsWith('FromBody')) return 'body';
  if (attribute.startsWith('FromRoute')) return 'route';
  if (attribute.startsWith('FromQuery')) return 'query';
  if (attribute.startsWith('FromHeader')) return 'header';
  if (attribute.startsWith('FromServices')) return 'services';
  return null;
}

function extractBlock(source, openingBraceIndex) {
  let depth = 0;
  for (let index = openingBraceIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openingBraceIndex + 1, index);
    }
  }
  return source.slice(openingBraceIndex + 1);
}

function splitTopLevel(text) {
  const result = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if ('(<[{'.includes(character)) depth += 1;
    else if (')>]}'.includes(character)) depth -= 1;
    else if (character === ',' && depth === 0) {
      result.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(text.slice(start).trim());
  return result;
}

function joinRoute(base, action) {
  return normalizeRoute([base, action].filter(Boolean).join('/'));
}

function normalizeRoute(route) {
  return `/${route}`.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

function unquote(value) {
  if (!value) return value;
  const stringLiteral = value.match(/^"([\s\S]*)"$/)?.[1];
  return stringLiteral ?? value;
}

function compactType(value) {
  return value.replace(/\s+/g, ' ').trim();
}
