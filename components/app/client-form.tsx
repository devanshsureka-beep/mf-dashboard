import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { humanize, todayIST } from "@/lib/format";
import { CLIENT_STATUSES, RISK_PROFILES, type ClientSummary } from "@/types/domain";

/** Shared fields for create / edit client (server-rendered). */
export function ClientFields({ client, advisors }: { client?: ClientSummary; advisors?: { id: string; full_name: string }[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Field label="Full name *"><Input name="full_name" required defaultValue={client?.full_name} /></Field>
      <Field label="Email"><Input name="email" type="email" defaultValue={client?.email ?? ""} /></Field>
      <Field label="Phone"><Input name="phone" defaultValue={client?.phone ?? ""} /></Field>
      <Field label="PAN (optional)"><Input name="pan" defaultValue={client?.pan ?? ""} placeholder="ABCDE1234F" className="uppercase" /></Field>
      {!client ? <Field label="Onboarding date"><Input name="onboarding_date" type="date" defaultValue={todayIST()} /></Field> : null}
      <Field label="Risk profile">
        <Select name="risk_profile" defaultValue={client?.risk_profile ?? ""}>
          <option value="">—</option>
          {RISK_PROFILES.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
        </Select>
      </Field>
      <Field label="Status">
        <Select name="status" defaultValue={client?.status ?? "ONBOARDING"}>
          {CLIENT_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
        </Select>
      </Field>
      <Field label="Next review date"><Input name="next_review_date" type="date" defaultValue={client?.next_review_date ?? ""} /></Field>
      {advisors ? (
        <Field label="Primary advisor *">
          <Select name="advisor_id" required defaultValue="">
            <option value="" disabled>Choose…</option>
            {advisors.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}
          </Select>
        </Field>
      ) : null}
      <Field label="Goal" className="md:col-span-2"><Textarea name="goal" rows={2} defaultValue={client?.goal ?? ""} /></Field>
    </div>
  );
}
