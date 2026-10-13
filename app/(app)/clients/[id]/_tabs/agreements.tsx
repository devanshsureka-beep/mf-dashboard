import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Field, Input, Select } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { Money } from "@/components/app/money";
import { withUserTx, type Actor } from "@/lib/db/tx";
import { formatDate, humanize } from "@/lib/format";
import { AGREEMENT_STATUSES, AGREEMENT_TYPES, getPremium, listAgreements, listPayments, PAYMENT_MODES } from "@/services/client-record";
import { addAgreementAction, addPaymentAction, refundPaymentAction, setAgreementStatusAction } from "../record-actions";

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

const PREMIUM_TONE = { ACTIVE: "success", PAID: "info", EXPIRED: "danger", UNPAID: "danger" } as const;

/** Two tiles: premium paid and the advisory agreement, each with its records and add form folded inside. */
export async function AgreementsTab({ clientId, actor, open }: { clientId: string; actor: Actor; open?: string | null }) {
  const d = await withUserTx(actor, async (tx) => ({
    premium: await getPremium(tx, clientId),
    agreements: await listAgreements(tx, clientId),
    payments: await listPayments(tx, clientId),
  }));
  const p = d.premium;

  const agreementLabel = p.agreement_status === "VALID" ? "Valid" : p.agreement_status === "EXPIRED" ? "Expired" : "Missing";
  return (
    <>
      <section id="premium" className="scroll-mt-14 rounded-xl border border-border bg-surface px-4 py-3">
        <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">Premium</div>
        <div className={p.premium_status === "ACTIVE" ? (p.renewal_due ? "text-lg font-semibold text-amber-700" : "text-lg font-semibold text-emerald-700") : "text-lg font-semibold text-red-700"}>{humanize(p.premium_status)}</div>
        <div className="text-xs text-muted"><Money value={p.premium_paid_total} /> paid · {p.paid_until ? `till ${formatDate(p.paid_until)}${p.renewal_due ? " · renewal due" : ""}` : "no period recorded"}</div>
        <details className="mt-1.5" open={open === "premium"}>
          <summary className="cursor-pointer text-xs font-medium text-brand">+ Record a payment{d.payments.length ? ` · ${d.payments.length} on file` : ""}</summary>
          <div className="mt-2">
        <Card>
          <CardHeader><CardTitle>Premium payments</CardTitle><span className="text-xs text-muted">Total <Money value={p.premium_paid_total} full /></span></CardHeader>
          {d.payments.length ? (
            <Table className="text-[13px] [&_td]:px-2 [&_th]:px-2">
              <THead><TR><TH>Paid on</TH><TH className="text-right">Amount</TH><TH>Covers</TH><TH>Mode</TH>{actor.role === "ADMIN" ? <TH /> : null}</TR></THead>
              <TBody>
                {d.payments.map((x) => (
                  <TR key={x.id} className={x.status === "REFUNDED" ? "opacity-60" : undefined}>
                    <TD className="whitespace-nowrap text-xs">{formatDate(x.paid_on)}<div className="text-[11px] text-muted">{x.plan_name}</div></TD>
                    <TD className="text-right font-medium"><Money value={x.amount} full />{x.status === "REFUNDED" ? <div><Badge tone="danger">Refunded</Badge></div> : null}</TD>
                    <TD className="whitespace-nowrap text-xs">{x.period_from ? formatDate(x.period_from) : "—"} → {x.period_to ? formatDate(x.period_to) : "—"}</TD>
                    <TD className="text-xs">{x.mode}{x.reference ? <div className="text-[11px] text-muted">{x.reference}</div> : null}</TD>
                    {actor.role === "ADMIN" ? (
                      <TD>
                        {x.status === "RECEIVED" ? (
                          <details className="text-xs">
                            <summary className="cursor-pointer text-brand">Refund</summary>
                            <ActionForm action={refundPaymentAction.bind(null, clientId, x.id)} className="mt-1 flex gap-1">
                              <Input name="reason" placeholder="Reason" className="h-8 w-36 text-xs" required />
                              <SubmitButton size="sm" variant="outline" confirm="Mark this payment refunded?">Save</SubmitButton>
                            </ActionForm>
                          </details>
                        ) : null}
                      </TD>
                    ) : null}
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : <CardContent><p className="text-sm text-muted">No premium payments recorded yet.</p></CardContent>}
          <CardContent className="border-t border-border">
            <div>
              <div className="text-sm font-medium">New payment</div>
              <ActionForm action={addPaymentAction.bind(null, clientId)} className="mt-3 grid grid-cols-2 gap-2" resetOnSuccess>
                <Field label="Amount ₹ *"><Input name="amount" inputMode="decimal" required /></Field>
                <Field label="Paid on *"><Input type="date" name="paid_on" defaultValue={today()} required /></Field>
                <Field label="Covers from"><Input type="date" name="period_from" /></Field>
                <Field label="Covers till"><Input type="date" name="period_to" /></Field>
                <Field label="Plan"><Input name="plan_name" defaultValue="MF Premium" /></Field>
                <Field label="Mode *"><Select name="mode" defaultValue="UPI">{PAYMENT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}</Select></Field>
                <Field label="Reference (UTR / txn id)"><Input name="reference" /></Field>
                <Field label="Notes"><Input name="notes" /></Field>
                <div className="col-span-2"><SubmitButton size="sm">Save payment</SubmitButton></div>
              </ActionForm>
            </div>
          </CardContent>
        </Card>
          </div>
        </details>
      </section>
      <section id="agreement" className="scroll-mt-14 rounded-xl border border-border bg-surface px-4 py-3">
        <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted">Advisory agreement</div>
        <div className={p.agreement_status === "VALID" ? "text-lg font-semibold text-emerald-700" : "text-lg font-semibold text-red-700"}>{agreementLabel}</div>
        <div className="text-xs text-muted">{p.agreement_valid_to ? `Valid till ${formatDate(p.agreement_valid_to)}` : p.agreements_signed ? "No end date" : "No signed agreement on file"}</div>
        <details className="mt-1.5" open={open === "agreement"}>
          <summary className="cursor-pointer text-xs font-medium text-brand">+ Record an agreement{d.agreements.length ? ` · ${d.agreements.length} on file` : ""}</summary>
          <div className="mt-2">
        <Card>
          <CardHeader><CardTitle>Agreements</CardTitle><Badge tone={PREMIUM_TONE[p.premium_status]}>{humanize(p.premium_status)} premium</Badge></CardHeader>
          {d.agreements.length ? (
            <Table className="text-[13px] [&_td]:px-2 [&_th]:px-2">
              <THead><TR><TH>Agreement</TH><TH>Signed</TH><TH>Valid</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {d.agreements.map((a) => (
                  <TR key={a.id}>
                    <TD className="max-w-60">
                      <div className="truncate font-medium" title={a.title}>{a.title}</div>
                      <div className="text-[11px] text-muted">{humanize(a.agreement_type)}{a.reference_no ? ` · ${a.reference_no}` : ""}</div>
                      {a.document_id ? <a className="text-[11px] text-brand hover:underline" href={`/api/documents/${a.document_id}/download`}>Signed copy: {a.file_name}</a> : <span className="text-[11px] text-amber-700">No signed copy uploaded</span>}
                    </TD>
                    <TD className="whitespace-nowrap text-xs">{a.signed_on ? formatDate(a.signed_on) : "—"}</TD>
                    <TD className="whitespace-nowrap text-xs">{a.valid_from ? formatDate(a.valid_from) : "—"} → {a.valid_to ? formatDate(a.valid_to) : "open"}</TD>
                    <TD><Badge tone={a.status === "SIGNED" ? "success" : a.status === "DRAFT" || a.status === "SENT" ? "info" : "danger"}>{humanize(a.status)}</Badge></TD>
                    <TD>
                      <details className="text-xs">
                        <summary className="cursor-pointer text-brand">Update</summary>
                        <ActionForm action={setAgreementStatusAction.bind(null, clientId, a.id)} className="mt-1 flex flex-wrap gap-1">
                          <Select name="status" defaultValue={a.status} className="h-8 w-28 text-xs">{AGREEMENT_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>
                          <Input name="reason" placeholder="Reason" className="h-8 w-36 text-xs" required />
                          <SubmitButton size="sm" variant="outline">Save</SubmitButton>
                        </ActionForm>
                      </details>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : <CardContent><p className="text-sm text-muted">No agreements recorded yet.</p></CardContent>}
          <CardContent className="border-t border-border">
            <div>
              <div className="text-sm font-medium">New agreement</div>
              <ActionForm action={addAgreementAction.bind(null, clientId)} className="mt-3 grid grid-cols-2 gap-2" resetOnSuccess>
                <Field label="Type *"><Select name="agreement_type" defaultValue="ADVISORY_AGREEMENT">{AGREEMENT_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select></Field>
                <Field label="Title *"><Input name="title" defaultValue="MF Premium advisory agreement" required /></Field>
                <Field label="Status"><Select name="status" defaultValue="SIGNED">{AGREEMENT_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></Field>
                <Field label="Signed on"><Input type="date" name="signed_on" defaultValue={today()} /></Field>
                <Field label="Valid from"><Input type="date" name="valid_from" /></Field>
                <Field label="Valid till"><Input type="date" name="valid_to" /></Field>
                <Field label="Reference no."><Input name="reference_no" /></Field>
                <Field label="Signed copy (PDF / image)"><Input type="file" name="file" accept="application/pdf,image/*" /></Field>
                <Field label="Notes" className="col-span-2"><Input name="notes" /></Field>
                <div className="col-span-2"><SubmitButton size="sm">Save agreement</SubmitButton></div>
              </ActionForm>
            </div>
          </CardContent>
        </Card>

          </div>
        </details>
      </section>
    </>
  );
}