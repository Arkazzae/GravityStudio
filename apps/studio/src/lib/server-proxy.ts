import type { NextRequest } from 'next/server';

const requestHeaders = ['content-type', 'cookie', 'authorization', 'x-filename', 'range', 'if-none-match', 'origin', 'idempotency-key', 'accept', 'prefer', 'mcp-protocol-version', 'mcp-session-id', 'mcp-method', 'mcp-name', 'access-control-request-method', 'access-control-request-headers'];
const responseHeaders = ['content-type', 'content-length', 'content-disposition', 'cache-control', 'etag', 'accept-ranges', 'content-range', 'retry-after', 'mcp-session-id', 'mcp-protocol-version', 'www-authenticate', 'x-request-id', 'idempotency-key', 'x-gravity-job-ids', 'location', 'allow', 'x-accel-buffering', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-expose-headers', 'access-control-allow-credentials', 'vary'];

export async function serverProxy(request: NextRequest, path: string[], prefix: 'api' | 'v1') {
  const openai = prefix === 'v1' || path[0] === 'v1';
  const modelPath = prefix === 'v1' ? path[0] === 'models' : path[0] === 'v1' && path[1] === 'models';
  const error = (message: string, status: number) => Response.json(openai ? { error: { message, type: status === 503 ? 'server_error' : 'invalid_request_error', param: null, code: status === 503 ? 'SERVER_UNAVAILABLE' : 'INVALID_PATH' } } : { error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
  if (path.some(segment => /\\/.test(segment) || (!modelPath && segment.includes('/')) || segment.split('/').some(part => part === '.' || part === '..'))) return error('Invalid API path.', 400);
  const base = new URL(process.env.GRAVITY_SERVER_URL || 'http://127.0.0.1:7331');
  const target = new URL(`/${prefix}/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`, base);
  const headers = new Headers();
  for (const name of requestHeaders) { const value = request.headers.get(name); if (value) headers.set(name, value); }
  headers.set('x-forwarded-host', request.headers.get('host') || request.nextUrl.host);
  headers.set('x-forwarded-proto', request.nextUrl.protocol.slice(0, -1));
  try {
    const upstream = await fetch(target, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual', cache: 'no-store', signal: request.signal, duplex: 'half' } as RequestInit);
    const outgoing = new Headers();
    for (const name of responseHeaders) { const value = upstream.headers.get(name); if (value) outgoing.set(name, value); }
    for (const cookie of upstream.headers.getSetCookie()) outgoing.append('set-cookie', cookie);
    outgoing.set('x-content-type-options', 'nosniff');
    return new Response(upstream.body, { status: upstream.status, headers: outgoing });
  } catch {
    return error('The studio server is unavailable. Start the server and try again.', 503);
  }
}
