"use client";

/** Ticks / unticks every checkbox named `name` in the same form. */
export function SelectAll({ name = "ids", label = "Select all" }: { name?: string; label?: string }) {
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <input
        type="checkbox"
        aria-label={label || "Select all"}
        onChange={(e) => {
          const form = e.currentTarget.closest("form");
          form?.querySelectorAll<HTMLInputElement>(`input[type="checkbox"][name="${name}"]`).forEach((c) => { c.checked = e.currentTarget.checked; });
        }}
      />
      {label}
    </label>
  );
}
