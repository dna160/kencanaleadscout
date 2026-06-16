import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import type { EnrichResult } from "@kencana/core";
import { readSheet, SheetError } from "../src/io/readSheet.js";
import { writeSheet } from "../src/io/writeSheet.js";

function csvBuffer(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

describe("readSheet", () => {
  it("parses a csv and preserves column order", () => {
    const buf = csvBuffer(
      "Company ID,Company,Website,Priority\n" +
        "1,PT Alpha,www.alpha.co.id,P0\n" +
        "2,PT Beta,beta.com,P1\n",
    );
    const { columns, rows } = readSheet(buf);
    expect(columns).toEqual(["Company ID", "Company", "Website", "Priority"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ Company: "PT Alpha", Website: "www.alpha.co.id" });
  });

  it("matches the Website column case-insensitively", () => {
    const { columns } = readSheet(csvBuffer("company,WEBSITE\nPT Alpha,x.co.id\n"));
    expect(columns).toContain("WEBSITE");
  });

  it("throws a clear error when Website is missing", () => {
    expect(() => readSheet(csvBuffer("Company,Phone\nPT Alpha,021-555\n"))).toThrowError(SheetError);
  });

  it("drops fully-empty rows", () => {
    const { rows } = readSheet(csvBuffer("Company,Website\nPT Alpha,a.co\n,,\nPT Beta,b.co\n"));
    expect(rows).toHaveLength(2);
  });
});

describe("writeSheet", () => {
  it("appends the enrichment columns in spec order", () => {
    const columns = ["Company", "Website"];
    const rows = [{ Company: "PT Alpha", Website: "a.co.id" }];
    const results: EnrichResult[] = [
      {
        wa_found: true,
        wa_numbers: ["+6281234567890"],
        mobile_numbers: ["+6281234567890"],
        source: "wa_link",
        confidence: "high",
        pages_checked: 3,
        error: "",
      },
    ];

    const buf = writeSheet(columns, rows, results);
    const wb = XLSX.read(buf, { type: "buffer" });
    const out = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]!]!, {
      defval: "",
    });

    expect(Object.keys(out[0]!)).toEqual([
      "Company",
      "Website",
      "wa_found",
      "wa_numbers",
      "mobile_numbers",
      "source",
      "confidence",
      "pages_checked",
      "error",
    ]);
    expect(out[0]).toMatchObject({
      wa_found: "TRUE",
      wa_numbers: "+6281234567890",
      source: "wa_link",
      confidence: "high",
    });
  });
});
