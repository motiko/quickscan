import type { Metadata, Viewport } from 'next';
import './globals.css';
import { OcrRunner } from '@/components/OcrRunner';
import { DialogHost } from '@/components/ui/DialogHost';

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <OcrRunner />
        {children}
        <DialogHost />
      </body>
    </html>
  );
}
