import { describe, expect, it } from "vitest";
import { nameScore, pairDocuments } from "@/lib/domain/doc-pairing";

describe("pairing CAS and reports from one folder", () => {
  it("matches people's names regardless of order, case, middle names and titles", () => {
    expect(nameScore("RAHUL KUMAR SHARMA", "Mr. Rahul Sharma")).toBe(1);
    expect(nameScore("Priya Mehta", "Rahul Sharma")).toBe(0);
    // A shared two-letter initial alone is not a match.
    expect(nameScore("A K Gupta", "A K Verma")).toBe(0);
  });

  it("pairs by the name inside the report, else by the report's file name; each file once", () => {
    const pairs = pairDocuments(
      [
        { id: "c1", investorName: "RAHUL KUMAR SHARMA", fileName: "x1.pdf" },
        { id: "c2", investorName: "PRIYA MEHTA", fileName: "x2.pdf" },
        { id: "c3", investorName: "ANIL VERMA", fileName: "x3.pdf" },
      ],
      [
        { id: "r1", clientName: null, fileName: "Advisory Report - Priya Mehta final.pdf" },
        { id: "r2", clientName: "Rahul Sharma", fileName: "report.pdf" },
      ],
    );
    expect(pairs).toEqual([
      { casId: "c1", reportId: "r2", score: 1 },
      { casId: "c2", reportId: "r1", score: 0.9 },
      { casId: "c3", reportId: null, score: 0 },
    ]);
  });
});
