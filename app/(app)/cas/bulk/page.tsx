import { redirect } from "next/navigation";

/** Bulk CAS upload now lives at the top of the CAS inbox. */
export default function BulkCasPage() {
  redirect("/reconciliation");
}
