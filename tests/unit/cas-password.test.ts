import { describe, expect, it } from "vitest";
import { digitsFromFileName, fillTemplate, last4, passwordCandidates } from "@/lib/cas/password";

describe("CAS password candidates", () => {
  const template = "Pre{last4}$";

  it("fills the template with the last 4 digits of a mobile number", () => {
    expect(last4("+91 98000 01234")).toBe("1234");
    expect(last4("12")).toBeNull();
    expect(fillTemplate(template, "4917")).toBe("Pre4917$");
  });

  it("orders candidates: explicit, file name digits, then client phones; no duplicates", () => {
    const c = passwordCandidates({
      template,
      explicit: ["typed-secret", "9800005768"],
      fileName: "Pre5768_statement_2026.pdf",
      phones: ["9800004917", "9800005768", null],
    });
    expect(c).toEqual(["typed-secret", "9800005768", "Pre5768$", "Pre2026$", "Pre4917$"]);
  });

  it("without a template only explicit passwords are tried", () => {
    expect(passwordCandidates({ template: null, explicit: ["x"], fileName: "a1234.pdf", phones: ["9800001234"] })).toEqual(["x"]);
    expect(digitsFromFileName("CAS_98xxxx4917_19092026.pdf")).toEqual(["4917", "2026"]);
  });
});
