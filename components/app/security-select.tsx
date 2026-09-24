import { Select } from "@/components/ui/form";
import type { SecurityRow } from "@/services/securities";

/** Plain <select> of the security master (holdings of the client listed first). */
export function SecuritySelect({
  securities, heldIds = [], name = "security_id", defaultValue, required, className,
}: {
  securities: SecurityRow[];
  heldIds?: string[];
  name?: string;
  defaultValue?: string | null;
  required?: boolean;
  className?: string;
}) {
  const held = securities.filter((s) => heldIds.includes(s.id));
  const others = securities.filter((s) => !heldIds.includes(s.id));
  const label = (s: SecurityRow) => `${s.scheme_name}${s.isin ? ` · ${s.isin}` : ""}`;
  return (
    <Select name={name} defaultValue={defaultValue ?? ""} required={required} className={className}>
      <option value="">Choose security…</option>
      {held.length ? (
        <optgroup label="Currently held">
          {held.map((s) => <option key={s.id} value={s.id}>{label(s)}</option>)}
        </optgroup>
      ) : null}
      <optgroup label="Security master">
        {others.map((s) => <option key={s.id} value={s.id}>{label(s)}</option>)}
      </optgroup>
    </Select>
  );
}
