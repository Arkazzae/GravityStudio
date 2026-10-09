import type { Metadata, Viewport } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Gravity Studio', description: 'Your image studio. Your models. Your hardware.' };
export const viewport: Viewport = { themeColor: '#0f1113', colorScheme: 'dark' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body className="font-sans antialiased">{children}</body></html>;
}
