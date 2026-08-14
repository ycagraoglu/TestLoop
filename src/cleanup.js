import { executeHttp } from './http.js';
import { readPath } from './object-path.js';

// TestLoop creates records to satisfy foreign keys and to exercise POST endpoints, and the
// regression sweep repeats those writes on every repair. Two separate concerns follow from that.
//
// Recording what was created is unconditional: a run must be able to say exactly what it left
// behind, which is what the fixture evidence rules mean by creation responsibility.
//
// Removing it is not. Deleting is a destructive operation, and this tool does not perform those
// unless asked, so cleanup runs only when `cleanup: true`. The delete route is inferred from the
// collection that produced the record (`DELETE <collection>/<id>`), which is a convention rather
// than a fact, so every attempt is recorded with its outcome and a failure never fails the run.

export function recordCreation(context, entry) {
  if (!Array.isArray(context.created)) return;
  if (entry.id === undefined || entry.id === null || typeof entry.id === 'object') return;
  if (context.created.some(item => item.collectionUrl === entry.collectionUrl && String(item.id) === String(entry.id))) return;
  context.created.push(entry);
}

// A 2xx POST to a collection that answers with an id is how a REST API says "I made this".
export function recordScenarioCreation(context, scenario, request, response) {
  if (scenario.method !== 'POST' || !response.ok) return;
  const id = readPath(response.body, 'id') ?? readPath(response.body, 'Id');
  recordCreation(context, {
    entity: scenario.id,
    id,
    collectionUrl: request.url,
    createdBy: `scenario:${scenario.id}`
  });
}

export async function runCleanup(context) {
  const created = context.created ?? [];
  if (created.length === 0) return { attempted: false, removed: [], failed: [] };

  const removed = [];
  const failed = [];
  // Reverse order, so a record created to satisfy another one is removed after its dependant.
  for (const entry of [...created].reverse()) {
    const url = `${entry.collectionUrl.replace(/\/+$/, '')}/${encodeURIComponent(entry.id)}`;
    try {
      const response = await executeHttp({ method: 'DELETE', url, headers: context.auth?.headers ?? {} }, {
        timeoutMs: context.config?.timeoutMs ?? 30000,
        securityPolicy: context.securityPolicy,
        purpose: 'cleanup'
      });
      if (response.ok || response.status === 404) removed.push({ ...entry, status: response.status });
      else failed.push({ ...entry, status: response.status, reason: `DELETE ${url} answered HTTP ${response.status}.` });
    } catch (error) {
      failed.push({ ...entry, reason: error.message });
    }
  }

  return { attempted: true, removed, failed };
}
