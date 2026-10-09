import type { MetadataRoute } from 'next';

export const dynamic = 'force-static';

export function GET() {
  const manifest: MetadataRoute.Manifest = {
    id: '/', name: 'Gravity Studio', short_name: 'Gravity',
    description: 'Your image studio. Your models. Your hardware.',
    start_url: '/image', scope: '/', display: 'standalone',
    background_color: '#0f1113', theme_color: '#0f1113',
    categories: ['graphics', 'photo', 'productivity'],
    shortcuts: [{ name: 'Create an image', short_name: 'Image', url: '/image' }],
    icons: [
      { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  return Response.json(manifest, { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' } });
}
