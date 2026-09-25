import Link from "next/link";
import { BrandMark } from "@/components/app/brand-mark";
import { PAGES } from "@/lib/brand";

export default function Forbidden() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="text-center">
        <BrandMark tone="light" className="mb-6 justify-center" />
        <h1 className="text-lg font-semibold">Not allowed</h1>
        <p className="mt-1 text-sm text-muted">Your role does not have access to this page, or your account is inactive.</p>
        <Link href="/" className="mt-4 inline-block text-sm text-brand hover:underline">Back to {PAGES.overview}</Link>
      </div>
    </main>
  );
}
