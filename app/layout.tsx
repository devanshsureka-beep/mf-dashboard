import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { BRAND } from "@/lib/brand";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

// APP_ENV=staging is set only for Vercel "Preview" deployments (the test site),
// which use the separate staging database.
const isStaging = process.env.APP_ENV === "staging";
const prefix = isStaging ? "[TEST] " : "";

export const metadata: Metadata = {
  title: { default: `${prefix}${BRAND.company} ${BRAND.product} · ${BRAND.desk}`, template: `${prefix}%s · ${BRAND.short}` },
  description: "Internal desk for Univest MF Premium clients: plan, calls, execution, CAS matching.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-IN" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full">
        {isStaging ? (
          <>
            <div className="fixed inset-x-0 top-0 z-50 h-1 bg-amber-500" aria-hidden />
            <div className="fixed bottom-3 left-1/2 z-50 -translate-x-1/2 rounded-full border border-amber-300 bg-amber-100 px-4 py-1.5 text-xs font-semibold text-amber-900 shadow">
              TEST SITE · separate test database · nothing here affects live clients
            </div>
          </>
        ) : null}
        {children}
      </body>
    </html>
  );
}
