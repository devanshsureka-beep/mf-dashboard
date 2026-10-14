import { redirect } from "next/navigation";

/** Bulk CAS upload now lives at the top of the CAS inbox. */
export const maxDuration = 300; // a picture-only CAS is read by Claude (up to 4 min)

export default function BulkCasPage() {
  redirect("/reconciliation");
}
