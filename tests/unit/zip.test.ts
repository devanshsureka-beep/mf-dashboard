import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildZip, crc32, toCsv } from "@/lib/zip";

describe("zip", () => {
  it("computes CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("builds a ZIP that standard tools read back", () => {
    const zip = buildZip([
      { name: "README.txt", data: "hello" },
      { name: "data/clients.csv", data: toCsv(["a", "b"], [{ a: 1, b: "x,y" }]) },
      { name: "CAS/2026-01-01 statement ₹.pdf", data: new Uint8Array([37, 80, 68, 70, 0, 255]) },
    ]);
    const dir = mkdtempSync(join(tmpdir(), "zip-"));
    const file = join(dir, "t.zip");
    writeFileSync(file, zip);
    try {
      execFileSync("python3", ["--version"]);
    } catch {
      return; // python3 not available: the CRC test above still covers the core
    }
    const out = execFileSync("python3", ["-I", "-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print('|'.join(z.namelist()));print(z.read('README.txt').decode())", file]).toString();
    expect(out).toContain("README.txt|data/clients.csv|CAS/2026-01-01 statement ₹.pdf");
    expect(out).toContain("hello");
  });

  it("escapes CSV cells and neutralises formulas", () => {
    const csv = toCsv(["v"], [{ v: 'a"b' }, { v: "=SUM(A1)" }, { v: -12.5 }, { v: null }, { v: new Date("2026-01-02T00:00:00Z") }]);
    expect(csv).toBe('﻿v\r\n"a""b"\r\n\'=SUM(A1)\r\n-12.5\r\n\r\n2026-01-02T00:00:00.000Z\r\n');
  });
});
