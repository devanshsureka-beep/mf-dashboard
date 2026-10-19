import { describe, expect, it } from "vitest";
import { casUploadTriggerSchema } from "@/lib/integrations/contracts";

describe("CAS upload trigger", () => {
  it("reads password_protected sent as form text", () => {
    const p = (v: unknown) => casUploadTriggerSchema.parse({ client_code: "MN-00001", password_protected: v }).password_protected;
    expect(p("false")).toBe(false);
    expect(p("true")).toBe(true);
    expect(p(true)).toBe(true);
    expect(p("0")).toBe(false);
    expect(casUploadTriggerSchema.parse({ client_code: "MN-00001" }).password_protected).toBe(false);
    expect(() => p("yes please")).toThrow();
  });
});
