import './globals.css';
import type { Metadata } from 'next';
import { env } from '@/lib/config';
import { productOgImage, PYLVA_PRODUCT_DESCRIPTION } from '@/lib/metadata';

export const metadata: Metadata = {
  metadataBase: new URL(env.PUBLIC_SITE_URL),
  title: { default: 'Pylva', template: '%s — Pylva' },
  description: PYLVA_PRODUCT_DESCRIPTION,
  applicationName: 'Pylva',
  openGraph: {
    type: 'website',
    siteName: 'Pylva',
    title: 'Pylva',
    description: PYLVA_PRODUCT_DESCRIPTION,
    images: [productOgImage()],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Pylva',
    description: PYLVA_PRODUCT_DESCRIPTION,
    images: [productOgImage()],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
