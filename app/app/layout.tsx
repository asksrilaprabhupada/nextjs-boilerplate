import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ask Śrīla Prabhupāda — Scripture Search",
  description:
    "A devotional knowledge engine grounded in Bhagavad Gītā, Śrīmad Bhāgavatam, and Caitanya Caritāmṛta. Every answer from Śrīla Prabhupāda's words.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
