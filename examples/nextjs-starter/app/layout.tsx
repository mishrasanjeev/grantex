import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Grantex Next.js Demo',
  description: 'Interactive demo of the Grantex authorization consent flow.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
