import { redirect } from "next/navigation";

/** The per-client status after upload is the check now; a draft is safe to throw away. */
export default function CheckDocumentsPage() {
  redirect("/onboard");
}
