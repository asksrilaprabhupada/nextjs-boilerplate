import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Ask Śrīla Prabhupāda",
  description: "Answers grounded in Vaiṣṇava literatures.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* Gradient background sits on <body> so all pages share it */}
      <body className="bg-gradient-to-br from-[#FFF7EA] to-[#EDE6FF] text-gray-900">
        {/* Top Nav */}
        <header className="h-16 sticky top-0 z-50 bg-white/70 backdrop-blur border-b border-black/5">
          <nav className="mx-auto max-w-6xl h-full px-6 flex items-center justify-between">
            <Link href="/" className="font-semibold tracking-tight">
              Ask Śrīla Prabhupāda
            </Link>
            <div className="flex items-center gap-6 text-sm">
              <Link href="/" className="hover:underline">Home</Link>
              <Link href="/team" className="hover:underline">Team</Link>
              <Link href="/inspiration" className="hover:underline">Inspiration</Link>
              <Link href="/updates" className="hover:underline">Updates</Link> {/* NEW */}
            </div>
          </nav>
        </header>

        {/* Page viewport: exactly full height minus header */}
        <main className="h-[calc(100vh-4rem)] overflow-hidden">{children}</main>
      </body>
    </html>
  );
}
