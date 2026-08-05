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
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`HTTP response exceeds ${maxBytes} bytes.`);
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
