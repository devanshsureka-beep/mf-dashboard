import { describe, expect, it } from "vitest";
import { isoDateOrNull, uuidOrNull } from "@/lib/utils";

describe("ids and dates from the URL", () => {
  it("accepts only real UUIDs", () => {
    expect(uuidOrNull("dc28047b-ced2-4c61-9d1e-5acaf81ea24e")).toBe("dc28047b-ced2-4c61-9d1e-5acaf81ea24e");
    expect(uuidOrNull("-".repeat(36))).toBeNull();
    expect(uuidOrNull("x")).toBeNull();
    expect(uuidOrNull(undefined)).toBeNull();
  });
  it("accepts only real calendar dates", () => {
    expect(isoDateOrNull("2026-10-15")).toBe("2026-10-15");
    expect(isoDateOrNull("2028-02-29")).toBe("2028-02-29");
    expect(isoDateOrNull("2026-02-31")).toBeNull();
    expect(isoDateOrNull("2026-99-99")).toBeNull();
    expect(isoDateOrNull("nope")).toBeNull();
  });
});
