import type { Metadata } from "next";
import "./globals.css";

// APP_ENV=staging is set only for Vercel "Preview" deployments (the test site),
// which use the separate staging database.
const isStaging = process.env.APP_ENV === "staging";

export const metadata: Metadata = {
  title: { default: `${isStaging ? "[TEST] " : ""}MN Advisory Dashboard`, template: `${isStaging ? "[TEST] " : ""}%s · MN Advisory` },
  description: "Advisory lifecycle operations: plan, advice, execution, CAS reconciliation.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-IN" className="h-full antialiased">
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
