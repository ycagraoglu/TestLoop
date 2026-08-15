// Reads endpoints declared straight on the application rather than on a controller:
//
//     app.MapGet("/products/{id}", (Guid id) => ...);
//     var admin = app.MapGroup("/api/admin").RequireAuthorization("Admin");
//     admin.MapPost("/products", (CreateProductRequest request) => ...);
//
// Nothing here decides a route. The test plan takes its routes from the OpenAPI document and looks
// source endpoints up by method and route, so anything this misreads simply fails to match and the
// scenario loses its enrichment. A misparse costs a request model, never a wrong request.

const MAP_ENDPOINT = /(?<receiver>\w+)\s*\.\s*Map(?<verb>Get|Post|Put|Patch|Delete)\s*\(/g;
const MAP_GROUP = /(?:var|RouteGroupBuilder|IEndpointRouteBuilder)\s+(?<name>\w+)\s*=\s*(?<receiver>\w+)\s*\.\s*MapGroup\s*\(/g;
const REQUIRES_AUTHORIZATION = /\.\s*RequireAuthorization\s*\(/;
const ALLOWS_ANONYMOUS = /\.\s*AllowAnonymous\s*\(/;
const ROLES_ARGUMENT = /\.\s*RequireAuthorization\s*\(\s*("(?:[^"]*)"(?:\s*,\s*"(?:[^"]*)")*)\s*\)/;

export function analyzeMinimalApiEndpoints(source) {
  const groups = readGroups(source);
  const endpoints = [];

  for (const match of source.matchAll(MAP_ENDPOINT)) {
    const call = readCall(source, match.index + match[0].length - 1);
    if (!call) continue;

    const route = firstStringArgument(call.args);
    if (route === null) continue;

    const group = groups.get(match.groups.receiver);
    const handler = handlerParameters(call.args);

    endpoints.push({
      operationId: `${match.groups.verb}${normalizeRoute(joinRoute(group?.prefix ?? '', route)).replace(/[^a-zA-Z0-9]+/g, '')}`,
      method: match.groups.verb.toUpperCase(),
      route: normalizeRoute(joinRoute(group?.prefix ?? '', route)),
      returnType: null,
      authorize: resolveAuthorize(call.tail, group),
      requestType: handler.requestType,
      parameters: handler.parameters
    });
  }

  return endpoints;
}

// A group can be built on another group, so prefixes and authorization are resolved through the
// chain rather than one level deep.
function readGroups(source) {
  const groups = new Map();

  for (const match of source.matchAll(MAP_GROUP)) {
    const call = readCall(source, match.index + match[0].length - 1);
    if (!call) continue;
    const prefix = firstStringArgument(call.args);
    if (prefix === null) continue;

    const parent = groups.get(match.groups.receiver);
    groups.set(match.groups.name, {
      prefix: joinRoute(parent?.prefix ?? '', prefix),
      authorize: resolveAuthorize(call.tail, parent)
    });
  }

  return groups;
}

function resolveAuthorize(tail, group) {
  if (ALLOWS_ANONYMOUS.test(tail)) return null;
  if (!REQUIRES_AUTHORIZATION.test(tail)) return group?.authorize ?? null;

  const roles = tail.match(ROLES_ARGUMENT)?.[1] ?? '';
  return {
    required: true,
    roles: [...roles.matchAll(/"([^"]*)"/g)].map(match => match[1]).filter(Boolean),
    policy: null
  };
}

// The handler is a lambda whose parameters describe the request the same way a controller action's
// signature does: a body model, route values, and services that are neither.
function handlerParameters(args) {
  const afterRoute = args.slice(args.indexOf(',') + 1);
  const open = afterRoute.indexOf('(');
  if (afterRoute.indexOf(',') === -1 && open === -1) return { requestType: null, parameters: [] };
  if (open === -1) return { requestType: null, parameters: [] };
  // Anything before the parameter list must be a lambda modifier; a method group has no list to read.
  if (!/^[\s]*(?:async\s*)?$/.test(afterRoute.slice(0, open))) return { requestType: null, parameters: [] };

  const list = balanced(afterRoute, open);
  if (list === null) return { requestType: null, parameters: [] };

  const parameters = splitTopLevel(list)
    .map(part => part.trim())
    .filter(Boolean)
    .map(toParameter)
    .filter(parameter => parameter.name && parameter.type);

  const body = parameters.find(parameter => parameter.source === 'body')
    ?? parameters.find(parameter => /(?:Request|Command|Dto)$/.test(parameter.type) && parameter.source === null);

  return { requestType: body?.type ?? null, parameters };
}

function toParameter(text) {
  const attribute = text.match(/^\[(?<name>\w+)[^\]]*\]\s*/);
  const clean = text.replace(/^(?:\[[^\]]*\]\s*)+/, '').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { name: '', type: '', source: null };

  return {
    name: parts.at(-1).replace(/=.*$/, '').trim(),
    type: parts.slice(0, -1).join(' ').trim(),
    source: parameterSource(attribute?.groups.name)
  };
}

function parameterSource(attribute) {
  if (attribute === 'FromBody') return 'body';
  if (attribute === 'FromRoute') return 'route';
  if (attribute === 'FromQuery') return 'query';
  if (attribute === 'FromHeader') return 'header';
  if (attribute === 'FromServices') return 'services';
  return null;
}

// Splits a call into its argument text and whatever is chained onto it, up to the end of the
// statement, which is where RequireAuthorization and AllowAnonymous live.
function readCall(source, openIndex) {
  const args = balanced(source, openIndex);
  if (args === null) return null;
  const afterArgs = openIndex + args.length + 2;
  const end = source.indexOf(';', afterArgs);
  return { args, tail: source.slice(afterArgs, end === -1 ? source.length : end) };
}

function balanced(text, openIndex) {
  let depth = 0;
  let inString = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && text[index - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, index);
    }
  }
  return null;
}

function firstStringArgument(args) {
  return args.match(/^\s*"([^"]*)"/)?.[1] ?? null;
}

function splitTopLevel(text) {
  const result = [];
  let start = 0;
  let depth = 0;
  let inString = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && text[index - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if ('(<[{'.includes(character)) depth += 1;
    else if (')>]}'.includes(character)) depth -= 1;
    else if (character === ',' && depth === 0) {
      result.push(text.slice(start, index));
      start = index + 1;
    }
  }

  result.push(text.slice(start));
  return result;
}

function joinRoute(prefix, route) {
  return [prefix, route].filter(part => part && part !== '/').join('/');
}

function normalizeRoute(route) {
  return `/${route}`.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}
