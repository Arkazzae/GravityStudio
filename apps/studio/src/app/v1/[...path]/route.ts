import type { NextRequest } from 'next/server';
import { serverProxy } from '@/lib/server-proxy';

export const dynamic = 'force-dynamic';
async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return serverProxy(request, (await context.params).path, 'v1');
}
export { proxy as GET, proxy as POST, proxy as PUT, proxy as DELETE, proxy as PATCH, proxy as HEAD, proxy as OPTIONS };
