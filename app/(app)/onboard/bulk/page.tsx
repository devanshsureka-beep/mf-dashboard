import { redirect } from "next/navigation";

/** One client and many clients onboard from the same page now. */
export default function BulkOnboardPage() {
  redirect("/onboard");
}
