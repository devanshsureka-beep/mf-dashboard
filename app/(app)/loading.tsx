/** Shown at once on every navigation while the page's data loads (the sidebar stays usable). */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="animate-pulse space-y-4">
      <div className="h-7 w-56 rounded bg-slate-200" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-20 rounded-xl bg-slate-100" />)}
      </div>
      <div className="grid gap-4 xl:grid-cols-[5fr_7fr]">
        <div className="h-72 rounded-xl bg-slate-100" />
        <div className="h-72 rounded-xl bg-slate-100" />
      </div>
    </div>
  );
}
