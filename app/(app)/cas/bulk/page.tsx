import { PageHeader } from "@/components/app/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { casPasswordTemplate } from "@/lib/cas/password";
import { requireActor } from "@/lib/auth/session";
import { BulkUploader } from "./bulk-uploader";

export const metadata = { title: "Bulk CAS upload" };

export default async function BulkCasPage() {
  await requireActor();
  const templateSet = casPasswordTemplate() !== null;
  return (
    <>
      <PageHeader
        title="Bulk CAS upload"
        subtitle="Drop every client's latest CAS at once. Each file is opened with the client's password, matched to the client by PAN, and checked against the calls."
      />
      {!templateSet ? (
        <Card className="mb-4 border-amber-200">
          <CardContent className="text-sm text-amber-800">
            The CAS password template (<code>CAS_PASSWORD_TEMPLATE</code>) is not configured, so password-protected files
            can only be opened with a password typed below. Ask an admin to add it in the hosting settings.
          </CardContent>
        </Card>
      ) : null}
      <BulkUploader />
      <Card className="mt-4">
        <CardContent className="space-y-1 text-xs text-muted">
          <p><b className="text-ink">What happens to each file:</b> the PDF is opened (unlocked files work too) → read by the built-in parser → matched to the client by PAN → stored → a new snapshot is created (older ones are never overwritten).</p>
          <p>If the holdings reconcile with the statement totals, the snapshot is confirmed automatically and every new CAS transaction is compared with the calls: a redemption or purchase in the same fund, on or after the call date, within 3% of the call is confirmed as executed with the CAS date, amount, units and NAV. Anything unclear goes to the review list; trades without a call show as unadvised.</p>
          <p>A trade done on day 1 usually appears in the CAS generated on day 2, so upload the CAS a day after the calls you want verified.</p>
        </CardContent>
      </Card>
    </>
  );
}
