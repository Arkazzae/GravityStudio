import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';
const passthrough = ['content-type', 'cookie', 'authorization', 'x-filename', 'range', 'if-none-match', 'origin', 'idempotency-key', 'accept', 'mcp-protocol-version', 'mcp-session-id'];
const responseHeaders = ['content-type', 'content-length', 'content-disposition', 'cache-control', 'etag', 'accept-ranges', 'content-range', 'retry-after', 'mcp-session-id', 'mcp-protocol-version', 'www-authenticate'];

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (path.some(segment => segment === '.' || segment === '..' || /[/\\]/.test(segment))) return Response.json({ error: 'Invalid API path.' }, { status: 400 });
  const base = new URL(process.env.GRAVITY_SERVER_URL || 'http://127.0.0.1:7331');
  const target = new URL(`/api/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`, base);
  const headers = new Headers();
  for (const name of passthrough) { const value = request.headers.get(name); if (value) headers.set(name, value); }
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
    return Response.json({ error: 'The studio server is unavailable. Start the server and try again.' }, { status: 503 });
  }
}
export { proxy as GET, proxy as POST, proxy as PUT, proxy as DELETE, proxy as PATCH, proxy as HEAD };
