// app/layout.tsx
import "./globals.css";
import type { Metadata } from "next";
import TopNav from "./_components/TopNav"; // ← use your existing nav

export const metadata: Metadata = {
  title: "Ask Śrīla Prabhupāda",
  description: "Answers grounded in Vaiṣṇava literatures.",
  icons: { icon: "/favicon.ico" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gradient-to-br from-[#FFF7EA] to-[#EDE6FF] text-gray-900">
        <TopNav />
        <main className="h-[calc(100vh-4rem)] overflow-hidden">{children}</main>
      </body>
    </html>
  );
}
