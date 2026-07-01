import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'HAR Mission Control',
  description: 'Local dashboard for harness runs, worktrees, and agent slots',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <div>
              <h1 className="text-lg font-semibold">HAR Mission Control</h1>
              <p className="text-sm text-muted-foreground">Local harness observability</p>
            </div>
            <nav className="flex gap-4 text-sm">
              <Link href="/" className="hover:underline">
                Repos
              </Link>
              <Link href="/cloud" className="hover:underline">
                Cloud
              </Link>
              <Link href="/teams" className="hover:underline">
                Teams
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
