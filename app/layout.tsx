import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "MN Advisory Dashboard", template: "%s · MN Advisory" },
  description: "Advisory lifecycle operations: plan, advice, execution, CAS reconciliation.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-IN" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
