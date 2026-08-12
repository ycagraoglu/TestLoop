import { assertAllowedUrl } from './security-policy.js';

export async function executeHttp(request, { timeoutMs = 30000, securityPolicy = null, purpose = 'request' } = {}) {
  if (!request?.url || !request?.method) throw new Error('Request requires url and method.');
  if (securityPolicy) assertAllowedUrl(request.url, securityPolicy, purpose);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const headers = { ...(request.headers ?? {}) };
    let body;
    if (request.body !== undefined) {
      body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
      if (!Object.keys(headers).some(x => x.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    }
    const response = await fetch(request.url, {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
      redirect: 'manual'
    });
    const maxBytes = securityPolicy?.maxResponseBytes ?? 2_000_000;
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > maxBytes) throw new Error(`HTTP response exceeds ${maxBytes} bytes.`);
    const buffer = await readBoundedBody(response, maxBytes);
    const text = buffer.toString('utf8');
    let parsedBody = text;
    try { parsedBody = text ? JSON.parse(text) : null; } catch { /* preserve text */ }
    return {
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
      headers: Object.fromEntries(response.headers.entries()),
      body: parsedBody
    };
  } finally {
    clearTimeout(timer);
  }
}

// Bounds actual memory use, unlike checking response.arrayBuffer().length after the fact: a
// chunked response with no content-length would otherwise be buffered in full before any check ran.
async function readBoundedBody(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`HTTP response exceeds ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
}
