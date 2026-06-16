/**
 * Write enriched rows back to an .xlsx buffer (microPRD §2 output contract).
 *
 * Output = input columns (untouched, original order) + appended enrichment
 * columns.
 */
import * as XLSX from "xlsx";
import type { AccountRow, EnrichResult } from "@kencana/core";

/** Appended columns, in spec order. */
const APPENDED = [
  "wa_found",
  "wa_numbers",
  "mobile_numbers",
  "source",
  "confidence",
  "pages_checked",
  "error",
] as const;

export function writeSheet(
  inputColumns: string[],
  rows: AccountRow[],
  results: EnrichResult[],
): Buffer {
  const header = [...inputColumns, ...APPENDED];

  const out = rows.map((row, i) => {
    const r = results[i];
    const record: Record<string, string | number> = {};
    for (const col of inputColumns) {
      const v = row[col];
      record[col] = v == null ? "" : (v as string | number);
    }
    if (r) {
      record.wa_found = r.wa_found ? "TRUE" : "FALSE";
      record.wa_numbers = r.wa_numbers.join(", ");
      record.mobile_numbers = r.mobile_numbers.join(", ");
      record.source = r.source;
      record.confidence = r.confidence;
      record.pages_checked = r.pages_checked;
      record.error = r.error;
    }
    return record;
  });

  const ws = XLSX.utils.json_to_sheet(out, { header: header as unknown as string[] });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "enriched");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
