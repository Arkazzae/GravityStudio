import { createPwaWorker } from '@/lib/pwa-worker';

export const dynamic = 'force-static';

export function GET() {
  return new Response(createPwaWorker(process.env.GRAVITY_PWA_BUILD_ID || 'development'), {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'Service-Worker-Allowed': '/',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
