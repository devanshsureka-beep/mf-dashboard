import { redirect } from "next/navigation";

export default async function Upload(props: PageProps<"/reconciliation/upload">) {
  const sp = await props.searchParams;
  const client = typeof sp.client === "string" && /^[0-9a-f-]{36}$/i.test(sp.client) ? sp.client : null;
  redirect(client ? `/clients/${client}/cas/upload` : "/reconciliation");
}
