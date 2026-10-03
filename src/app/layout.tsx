import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import './globals.css';
import { OcrRunner } from '@/components/OcrRunner';
import { SyncRunner } from '@/components/SyncRunner';
import { DialogHost } from '@/components/ui/DialogHost';
import { DatabaseGate } from '@/components/DatabaseGate';


export const metadata: Metadata = {
  title: 'QuickScan',
  description: 'Scan documents with your camera',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'QuickScan',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Render per request so Next can put the proxy's CSP nonce on its scripts (src/proxy.ts).
  // The static export for the native app has no proxy and is prerendered instead.
  if (process.env.NEXT_PUBLIC_BUILD_TARGET !== 'export') await connection();
  return (
    <html lang="en">
      <body className="antialiased">
        <OcrRunner />
        <SyncRunner />
        {children}
        <DialogHost />
        <DatabaseGate />
      </body>
    </html>
  );
}
