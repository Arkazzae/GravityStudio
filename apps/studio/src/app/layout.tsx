import type { Metadata, Viewport } from 'next';
import { PwaProvider } from '@/lib/use-pwa';
import './globals.css';
export const metadata: Metadata = {
  title: 'Gravity Studio', description: 'Your image studio. Your models. Your hardware.',
  applicationName: 'Gravity Studio',
  appleWebApp: { capable: true, title: 'Gravity', statusBarStyle: 'black-translucent' },
  icons: {
    icon: [
      { url: '/favicons/favicon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
    apple: [{ url: '/pwa/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};
export const viewport: Viewport = { themeColor: '#0f1113', colorScheme: 'dark' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><head><link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" /></head><body className="font-sans antialiased"><PwaProvider>{children}</PwaProvider></body></html>;
}
