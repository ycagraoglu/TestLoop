export async function executeHttp(request, { timeoutMs = 30000 } = {}) {
  if (!request?.url || !request?.method) throw new Error('Request requires url and method.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const headers = { ...(request.headers ?? {}) };
    let body;
    if (request.body !== undefined) {
      body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
      if (!Object.keys(headers).some(x => x.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
    }
    const response = await fetch(request.url, {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
      redirect: 'manual'
    });
    const text = await response.text();
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
