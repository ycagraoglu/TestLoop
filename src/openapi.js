const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

export async function loadOpenApi(source, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(source, { signal: controller.signal });
    if (!response.ok) throw new Error(`OpenAPI request failed: HTTP ${response.status}`);
    const document = await response.json();
    validateOpenApi(document);
    return document;
  } finally {
    clearTimeout(timer);
  }
}

export function validateOpenApi(document) {
  if (!document || typeof document !== 'object') throw new Error('OpenAPI document must be an object.');
  if (!document.openapi && !document.swagger) throw new Error('Document is not OpenAPI/Swagger.');
  if (!document.paths || typeof document.paths !== 'object') throw new Error('OpenAPI document has no paths object.');
}

export function listOperations(document) {
  validateOpenApi(document);
  const operations = [];
  for (const [route, pathItem] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const operation = pathItem?.[method];
      if (!operation) continue;
      operations.push({
        id: operation.operationId ?? `${method.toUpperCase()} ${route}`,
        method: method.toUpperCase(),
        route,
        tags: operation.tags ?? [],
        deprecated: operation.deprecated === true,
        requestBodyRequired: operation.requestBody?.required === true,
        security: operation.security ?? document.security ?? []
      });
    }
  }
  return operations;
}
