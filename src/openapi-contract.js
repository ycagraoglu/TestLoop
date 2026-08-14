// Checks a response body against the contract the API publishes for it. This is deterministic work,
// so it belongs in code rather than in a role: a missing required field or an array where an object
// was promised is a fact, not a judgement.
//
// The checks are deliberately narrow. A false SPEC_MISMATCH is worse than a missed one, because it
// sends someone to debug an endpoint that is behaving correctly, so anything ambiguous is skipped:
// oneOf/anyOf, additionalProperties, string formats, patterns and numeric bounds. What remains is
// structure and primitive types, where a disagreement is unarguable.

const MAX_ARRAY_ITEMS = 20;
// Recursion follows the response body, not the schema, so a self-referencing schema terminates on
// its own once the data runs out. This only guards against a pathologically deep body.
const MAX_DEPTH = 24;

export function buildResponseContract(document) {
  const paths = Object.entries(document?.paths ?? {}).map(([template, item]) => ({
    pattern: toPattern(template),
    item
  }));

  return {
    schemaFor(method, pathname, status) {
      const entry = paths.find(candidate => candidate.pattern.test(pathname));
      const operation = entry?.item?.[method.toLowerCase()];
      const responses = operation?.responses;
      if (!responses) return null;

      const response = responses[String(status)] ?? responses[`${String(status)[0]}XX`] ?? responses.default;
      const content = response?.content ?? {};
      const jsonType = Object.keys(content).find(type => /\bjson\b/i.test(type));
      return jsonType ? content[jsonType].schema ?? null : null;
    },
    document
  };
}

export function findResponseViolations(contract, { method, pathname, status, body }) {
  const schema = contract?.schemaFor(method, pathname, status);
  if (!schema) return [];
  const violations = [];
  inspect(schema, body, 'body', contract.document, violations, 0);
  return violations;
}

function inspect(rawSchema, value, location, document, violations, depth) {
  if (depth > MAX_DEPTH) return;
  const schema = resolve(rawSchema, document);
  if (!schema) return;

  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) inspect(part, value, location, document, violations, depth + 1);
    return;
  }

  // A branching schema can be satisfied in several shapes; deciding which branch was intended is a
  // judgement call, so it is left to a human or to the diagnose role.
  if (schema.oneOf || schema.anyOf || schema.not) return;

  if (value === null) {
    if (isNullable(schema)) return;
    violations.push(`${location}: expected ${describe(schema)}, received null`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${location}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
    return;
  }

  const type = declaredType(schema);
  if (!type) return;

  if (type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      violations.push(`${location}: expected an object, received ${describeValue(value)}`);
      return;
    }
    for (const property of schema.required ?? []) {
      if (!Object.hasOwn(value, property)) violations.push(`${location}.${property}: required property is missing`);
    }
    for (const [property, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, property)) inspect(propertySchema, value[property], `${location}.${property}`, document, violations, depth + 1);
    }
    return;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      violations.push(`${location}: expected an array, received ${describeValue(value)}`);
      return;
    }
    if (!schema.items) return;
    for (const [index, item] of value.slice(0, MAX_ARRAY_ITEMS).entries()) {
      inspect(schema.items, item, `${location}[${index}]`, document, violations, depth + 1);
    }
    return;
  }

  if (!matchesPrimitive(type, value)) {
    violations.push(`${location}: expected ${type}, received ${describeValue(value)}`);
  }
}

function resolve(schema, document) {
  if (!schema || typeof schema !== 'object') return null;
  if (typeof schema.$ref !== 'string') return schema;

  const target = schema.$ref.replace(/^#\//, '').split('/')
    .reduce((current, part) => current?.[decodeURIComponent(part.replace(/~1/g, '/').replace(/~0/g, '~'))], document);
  return resolve(target, document);
}

function declaredType(schema) {
  const type = Array.isArray(schema.type) ? schema.type.find(item => item !== 'null') : schema.type;
  if (type) return type;
  if (schema.properties || schema.required) return 'object';
  if (schema.items) return 'array';
  return null;
}

function isNullable(schema) {
  return schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes('null'));
}

function matchesPrimitive(type, value) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return true;
}

function describe(schema) {
  return declaredType(schema) ?? 'a value';
}

function describeValue(value) {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

function toPattern(template) {
  const source = template
    .split(/\{[^}]+\}/)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${source}$`);
}
