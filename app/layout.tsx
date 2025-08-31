import "./globals.css";
import type { Metadata } from "next";
import TopNav from "./_components/TopNav";

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
        {/* exact viewport minus header; prevents whole-page scrolling */}
        <main className="h-[calc(100vh-3.5rem)] md:h-[calc(100vh-4rem)] overflow-hidden">
          {children}
        </main>
      </body>
    </html>
  );
}
