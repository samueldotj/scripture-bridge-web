import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Scripture Bridge Console',
  description: 'Operations console for the Scripture Bridge backend.',
  robots: { index: false, follow: false },
};

/**
 * Nothing in this console may be served from a cache. Every page shows
 * privileged state that changes underneath the operator — an assignment made by
 * a colleague, a chapter submitted for review — and a stale render is how two
 * coordinators assign the same chapter to two people.
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
