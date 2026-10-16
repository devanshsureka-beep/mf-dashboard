import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Field, Input, Select } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/page-header";
import { formatDate, formatDateTime } from "@/lib/format";
import { Money } from "@/components/app/money";
import { HubTabs } from "@/components/app/hub-tabs";
import { pageData } from "@/lib/server";
import { listClientSummaries } from "@/services/clients";
import { assignClientAction, createUserAction, removeUserAction, restoreUserAction, unassignAction, updateUserAction } from "./actions";

export const metadata = { title: "Team & access" };

export default async function UsersPage() {
  const { users, assignments, clients } = await pageData(async (tx) => ({
    users: await tx<{ id: string; email: string; full_name: string; role: string; is_active: boolean; removed_at: Date | null; created_at: Date; clients: number; under_advice: number; awaiting: number; last_active: Date | null }[]>`
      select p.id, p.email, p.full_name, p.role, p.is_active, p.removed_at, p.created_at,
             (select count(*) from public.client_advisor_assignments a join public.clients c on c.id = a.client_id and c.deleted_at is null
              where a.advisor_id = p.id and a.is_active)::int as clients,
             (select coalesce(sum(s.live_portfolio_value), 0) from public.v_client_summary s where s.advisor_id = p.id)::float8 as under_advice,
             (select coalesce(sum(s.pending_total), 0) from public.v_client_summary s where s.advisor_id = p.id)::float8 as awaiting,
             (select max(l.occurred_at) from public.audit_logs l where l.actor_id = p.id) as last_active
      from public.profiles p order by p.is_active desc, p.role, p.full_name`,
    assignments: await tx<{ id: string; client_name: string; user_name: string; assignment_role: string; assigned_at: Date }[]>`
      select a.id, c.full_name as client_name, p.full_name as user_name, a.assignment_role, a.assigned_at
      from public.client_advisor_assignments a join public.clients c on c.id = a.client_id and c.deleted_at is null
      join public.profiles p on p.id = a.advisor_id
      where a.is_active order by c.full_name, a.assignment_role`,
    clients: await listClientSummaries(tx),
  }), ["ADMIN"]);

  const team = users.filter((u) => !u.removed_at);
  const removed = users.filter((u) => u.removed_at);

  return (
    <>
      <PageHeader title="Team & access" subtitle="Who works on the desk, which clients they see, and what has changed. Staff accounts are created here (public sign-up is disabled); roles are enforced in the database." />
      <HubTabs hub="admin" active="team" role="ADMIN" />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-3">
          <CardHeader><div><CardTitle>Staff · {team.length}</CardTitle><p className="mt-0.5 text-xs text-muted">Remove takes a person off the team: no sign-in, no client access. Their past calls, plans and audit entries stay.</p></div></CardHeader>
          <Table>
            <THead><TR><TH>Name</TH><TH className="text-right">Clients</TH><TH className="text-right">Under advice</TH><TH className="text-right">Waiting</TH><TH>Last active</TH><TH>Role / access</TH></TR></THead>
            <TBody>
              {team.map((u) => (
                <TR key={u.id}>
                  <TD className="font-medium">{u.full_name || "—"} {!u.is_active ? <Badge tone="danger">inactive</Badge> : null}<div className="text-[11px] font-normal text-muted">{u.email} · since {formatDate(u.created_at)}</div></TD>
                  <TD className="text-right num">{u.role === "OPERATIONS" ? <span className="text-xs text-muted">all (view)</span> : u.clients}</TD>
                  <TD className="text-right"><Money value={u.under_advice} zeroDash /></TD>
                  <TD className="text-right"><Money value={u.awaiting} zeroDash className={u.awaiting > 0.5 ? "text-amber-700" : undefined} /></TD>
                  <TD className="text-xs">{u.last_active ? formatDateTime(u.last_active) : "—"}</TD>
                  <TD className="min-w-[250px]">
                    <ActionForm action={updateUserAction.bind(null, u.id)} className="flex flex-wrap items-center gap-1">
                      <Select name="role" defaultValue={u.role} className="h-8 w-36 text-xs"><option>ADMIN</option><option>ADVISOR</option><option>OPERATIONS</option></Select>
                      <Select name="is_active" defaultValue={u.is_active ? "yes" : "no"} className="h-8 w-28 text-xs"><option value="yes">Active</option><option value="no">Inactive</option></Select>
                      <Input name="reason" placeholder="Reason" className="h-8 w-32 text-xs" />
                      <SubmitButton size="sm" variant="outline">Save</SubmitButton>
                    </ActionForm>
                    <details className="mt-1">
                      <summary className="cursor-pointer whitespace-nowrap text-xs text-red-700 hover:underline">Remove from team</summary>
                      <ActionForm action={removeUserAction.bind(null, u.id)} className="mt-1 flex flex-wrap items-center gap-1">
                        <Input name="reason" required placeholder="Why (kept in the audit log)" aria-label="Reason for removing" className="h-8 w-48 text-xs" />
                        <SubmitButton size="sm" variant="danger" confirm={`Remove ${u.full_name || u.email} from the team? They will no longer be able to sign in.`}>Remove</SubmitButton>
                      </ActionForm>
                    </details>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          {removed.length ? (
            <details className="border-t border-border">
              <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">Removed from the team · {removed.length}</summary>
              <ul className="divide-y divide-border border-t border-border">
                {removed.map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                    <div>
                      <div className="font-medium">{u.full_name || "—"} <Badge tone="danger">removed</Badge></div>
                      <div className="text-[11px] text-muted">{u.email} · removed {formatDate(u.removed_at!)}</div>
                    </div>
                    <ActionForm action={restoreUserAction.bind(null, u.id)} className="flex flex-wrap items-center gap-1">
                      <Select name="role" defaultValue={u.role} aria-label="Role" className="h-8 w-32 text-xs"><option>ADVISOR</option><option>OPERATIONS</option><option>ADMIN</option></Select>
                      <Input name="password" type="password" autoComplete="new-password" required minLength={12} placeholder="New temporary password" aria-label="New temporary password" className="h-8 w-48 text-xs" />
                      <SubmitButton size="sm" variant="outline">Add back</SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Card>
        <Card>
          <CardHeader><div><CardTitle>Add staff user</CardTitle><p className="mt-0.5 text-xs text-muted">An email that already has an account (e.g. someone removed earlier) is added back with this role and password.</p></div></CardHeader>
          <CardContent>
            <ActionForm action={createUserAction} className="space-y-3" resetOnSuccess>
              <Field label="Full name"><Input name="full_name" required /></Field>
              <Field label="Email"><Input name="email" type="email" required /></Field>
              <Field label="Role"><Select name="role" defaultValue="ADVISOR"><option>ADVISOR</option><option>OPERATIONS</option><option>ADMIN</option></Select></Field>
              <Field label="Temporary password" hint="Min 12 characters. Never sent by this app — share it securely."><Input name="password" type="password" autoComplete="new-password" required minLength={12} /></Field>
              <SubmitButton>Add user</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader><CardTitle>Client assignments</CardTitle><span className="text-xs text-muted">PRIMARY advisor is changed from the client page. Removing an assignment keeps it in history.</span></CardHeader>
          <CardContent>
            <ActionForm action={assignClientAction} className="mb-4 flex flex-wrap gap-2">
              <Select name="client_id" required defaultValue="" className="w-64"><option value="" disabled>Client…</option>{clients.map((c) => <option key={c.client_id} value={c.client_id}>{c.full_name}</option>)}</Select>
              <Select name="user_id" required defaultValue="" className="w-56"><option value="" disabled>Staff member…</option>{users.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.full_name} ({u.role})</option>)}</Select>
              <Select name="assignment_role" className="w-40"><option value="SECONDARY">Secondary advisor</option><option value="OPERATIONS">Operations</option></Select>
              <SubmitButton size="sm" variant="outline">Add assignment</SubmitButton>
            </ActionForm>
          </CardContent>
          <Table>
            <THead><TR><TH>Client</TH><TH>Staff</TH><TH>Role</TH><TH>Since</TH><TH /></TR></THead>
            <TBody>
              {assignments.map((a) => (
                <TR key={a.id}>
                  <TD>{a.client_name}</TD><TD>{a.user_name}</TD><TD><Badge tone={a.assignment_role === "PRIMARY" ? "info" : "neutral"}>{a.assignment_role}</Badge></TD>
                  <TD className="text-xs">{formatDate(a.assigned_at)}</TD>
                  <TD>{a.assignment_role !== "PRIMARY" ? <ActionForm action={unassignAction.bind(null, a.id)}><SubmitButton size="sm" variant="ghost">Remove</SubmitButton></ActionForm> : null}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      </div>
    </>
  );
}
