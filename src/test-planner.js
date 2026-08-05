const METHOD_ORDER = new Map([['POST', 0], ['GET', 1], ['PUT', 2], ['PATCH', 3], ['DELETE', 4]]);

export function buildTestPlan({ operations, sourceManifest = null, mode = 'standard' }) {
  if (!Array.isArray(operations)) throw new Error('operations must be an array.');
  const sourceEndpoints = new Map();
  for (const controller of sourceManifest?.controllers ?? []) {
    for (const endpoint of controller.endpoints ?? []) {
      sourceEndpoints.set(key(endpoint.method, endpoint.route), { ...endpoint, controller: controller.name });
    }
  }

  const normalized = operations
    .filter(operation => mode !== 'smoke' || ['GET', 'POST'].includes(operation.method))
    .map(operation => ({
      ...operation,
      source: sourceEndpoints.get(key(operation.method, operation.route)) ?? null,
      destructive: operation.method === 'DELETE',
      requiresBody: operation.requestBodyRequired === true || ['POST', 'PUT', 'PATCH'].includes(operation.method)
    }));

  const groups = new Map();
  for (const operation of normalized) {
    const group = operation.tags?.[0] ?? operation.source?.controller?.replace(/Controller$/, '') ?? routeRoot(operation.route);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(operation);
  }

  return {
    mode,
    groups: [...groups.entries()].map(([feature, items]) => ({
      feature,
      operations: items.slice().sort(compareOperations)
    })),
    summary: {
      operations: normalized.length,
      features: groups.size,
      destructive: normalized.filter(x => x.destructive).length
    }
  };
}

function compareOperations(left, right) {
  const method = (METHOD_ORDER.get(left.method) ?? 99) - (METHOD_ORDER.get(right.method) ?? 99);
  return method || left.route.localeCompare(right.route);
}

function key(method, route) {
  return `${String(method).toUpperCase()} ${normalizeRoute(route)}`;
}

function normalizeRoute(route) {
  return `/${String(route).replace(/^\/+|\/+$/g, '')}`;
}

function routeRoot(route) {
  return normalizeRoute(route).split('/').filter(Boolean)[0] ?? 'root';
}
