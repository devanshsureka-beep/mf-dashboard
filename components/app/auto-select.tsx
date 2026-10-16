"use client";

import { Select } from "@/components/ui/form";

/** A filter select that applies itself as soon as a value is picked (no Apply button). */
export function AutoSelect(props: React.ComponentProps<typeof Select>) {
  return <Select {...props} onChange={(e) => e.currentTarget.form?.requestSubmit()} />;
}
