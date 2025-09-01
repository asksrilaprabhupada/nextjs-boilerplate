// app/layout.tsx
import "./globals.css";
import type { Metadata } from "next";
import TopNav from "./_components/TopNav";

export const metadata: Metadata = {
  title: "Ask Śrīla Prabhupāda",
  description: "Answers come directly from Vaiṣṇava literatures.",
  // Use app/icon.png as the site favicon (and optional Apple touch icon).
  // Add ?v=1 to break cached old icons after deploys.
  icons: {
    icon: [{ url: "/icon.png?v=1", type: "image/png" }],
    shortcut: ["/icon.png?v=1"],
    apple: [{ url: "/apple-touch-icon.png?v=1", sizes: "180x180", type: "image/png" }],
  },
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
