"use client";

/** Opens the browser's print dialog; choose "Save as PDF" to send the report. */
export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
      Print / save as PDF
    </button>
  );
}
