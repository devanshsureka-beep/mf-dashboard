import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Field, Input, Select } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { ActionForm, SubmitButton } from "@/components/app/action-form";
import { PageHeader } from "@/components/app/page-header";
import { formatDate } from "@/lib/format";
import { pageData } from "@/lib/server";
import { listClientSummaries } from "@/services/clients";
import { assignClientAction, createUserAction, unassignAction, updateUserAction } from "./actions";

export const metadata = { title: "Users & access" };

export default async function UsersPage() {
  const { users, assignments, clients } = await pageData(async (tx) => ({
    users: await tx<{ id: string; email: string; full_name: string; role: string; is_active: boolean; created_at: Date; clients: number }[]>`
      select p.id, p.email, p.full_name, p.role, p.is_active, p.created_at,
             (select count(*) from public.client_advisor_assignments a where a.advisor_id = p.id and a.is_active)::int as clients
      from public.profiles p order by p.is_active desc, p.role, p.full_name`,
    assignments: await tx<{ id: string; client_name: string; user_name: string; assignment_role: string; assigned_at: Date }[]>`
      select a.id, c.full_name as client_name, p.full_name as user_name, a.assignment_role, a.assigned_at
      from public.client_advisor_assignments a join public.clients c on c.id = a.client_id join public.profiles p on p.id = a.advisor_id
      where a.is_active order by c.full_name, a.assignment_role`,
    clients: await listClientSummaries(tx),
  }), ["ADMIN"]);

  return (
    <>
      <PageHeader title="Users & access" subtitle="Staff accounts are created here (public sign-up is disabled). Roles are enforced by Row Level Security in the database." />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader><CardTitle>Staff</CardTitle></CardHeader>
          <Table>
            <THead><TR><TH>Name</TH><TH>Email</TH><TH>Clients</TH><TH>Since</TH><TH>Role / access</TH></TR></THead>
            <TBody>
              {users.map((u) => (
                <TR key={u.id}>
                  <TD className="font-medium">{u.full_name || "—"} {!u.is_active ? <Badge tone="danger">inactive</Badge> : null}</TD>
                  <TD className="text-xs">{u.email}</TD>
                  <TD className="num">{u.clients}</TD>
                  <TD className="text-xs">{formatDate(u.created_at)}</TD>
                  <TD>
                    <ActionForm action={updateUserAction.bind(null, u.id)} className="flex flex-wrap items-center gap-1">
                      <Select name="role" defaultValue={u.role} className="h-8 w-32 text-xs"><option>ADMIN</option><option>ADVISOR</option><option>OPERATIONS</option></Select>
                      <Select name="is_active" defaultValue={u.is_active ? "yes" : "no"} className="h-8 w-24 text-xs"><option value="yes">Active</option><option value="no">Inactive</option></Select>
                      <Input name="reason" placeholder="Reason" className="h-8 w-32 text-xs" />
                      <SubmitButton size="sm" variant="outline">Save</SubmitButton>
                    </ActionForm>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
        <Card>
          <CardHeader><CardTitle>Create staff user</CardTitle></CardHeader>
          <CardContent>
            <ActionForm action={createUserAction} className="space-y-3" resetOnSuccess>
              <Field label="Full name"><Input name="full_name" required /></Field>
              <Field label="Email"><Input name="email" type="email" required /></Field>
              <Field label="Role"><Select name="role" defaultValue="ADVISOR"><option>ADVISOR</option><option>OPERATIONS</option><option>ADMIN</option></Select></Field>
              <Field label="Temporary password" hint="Min 12 characters. Never sent by this app — share it securely."><Input name="password" type="password" autoComplete="new-password" required minLength={12} /></Field>
              <SubmitButton>Create user</SubmitButton>
            </ActionForm>
          </CardContent>
        </Card>
        <Card className="xl:col-span-3">
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
