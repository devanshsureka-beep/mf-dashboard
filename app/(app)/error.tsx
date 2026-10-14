"use client"; // Error boundaries must be Client Components

import Link from "next/link";
import { useEffect } from "react";

// A tab opened before a new deploy asks for files the deploy replaced; reloading picks up the new version.
const STALE = /ChunkLoadError|Loading (CSS )?chunk|dynamically imported module|Failed to load chunk|server action|deployment/i;

/** Any page that fails shows this inside the app shell, instead of a blank browser error screen. */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
    if (!error.digest && STALE.test(`${error.name} ${error.message}`)) {
      try {
        // Once per minute at most, so a real fault cannot loop.
        const last = Number(sessionStorage.getItem("stale-reload") ?? 0);
        if (Date.now() - last > 60_000) {
          sessionStorage.setItem("stale-reload", String(Date.now()));
          window.location.reload();
        }
      } catch {
        /* storage blocked: show the box */
      }
    }
  }, [error]);

  return (
    <div className="mx-auto mt-16 max-w-lg rounded-xl border border-border bg-surface p-6 text-center shadow-sm">
      <h1 className="text-lg font-semibold">This page hit an error</h1>
      <p className="mt-2 text-sm text-muted">
        Nothing was saved by the step that failed. Try again; if it keeps happening, note what you clicked and share the reference below.
      </p>
      {error.digest ? <p className="mt-2 text-xs text-muted">Reference: <span className="num">{error.digest}</span></p>
        : error.message ? <p className="mt-2 break-words text-xs text-muted">In the browser: {error.message.slice(0, 200)}</p> : null}
      <div className="mt-4 flex justify-center gap-2">
        <button type="button" onClick={() => retry()} className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white">Try again</button>
        <Link href="/" className="rounded-md px-3 py-1.5 text-sm ring-1 ring-border">Go to Overview</Link>
      </div>
    </div>
  );
}
