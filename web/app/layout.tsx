import type { Metadata } from "next";
import { Syne } from "next/font/google";
import { DM_Mono } from "next/font/google";
import "./globals.css";

const syne = Syne({ variable: "--font-syne", subsets: ["latin"], weight: ["400","500","600","700","800"] });
const dmMono = DM_Mono({ variable: "--font-mono", subsets: ["latin"], weight: ["400","500"] });

export const metadata: Metadata = {
  title: "DYCrawler — Admin",
  description: "Douyin content intelligence dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh" className={`${syne.variable} ${dmMono.variable} h-full`}>
      <body className="min-h-full bg-[#0c0c0c] text-zinc-100 antialiased">{children}</body>
    </html>
  );
}
