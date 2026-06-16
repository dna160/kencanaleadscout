/**
 * Read an uploaded .xlsx/.csv into rows (microPRD §2).
 *
 * Required column: `Website` (matched case-insensitively). Every other column
 * is carried through untouched and preserved in original order for the output.
 */
import * as XLSX from "xlsx";
import type { AccountRow } from "@kencana/core";

export interface ParsedSheet {
  /** Header labels in original order. */
  columns: string[];
  /** Data rows keyed by the original header labels. */
  rows: AccountRow[];
}

export class SheetError extends Error {}

/**
 * Parse a workbook buffer (xlsx or csv) and validate the `Website` column.
 * Throws {@link SheetError} with a clear message on malformed input.
 */
export function readSheet(buffer: Buffer): ParsedSheet {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer" });
  } catch (err) {
    throw new SheetError(
      "Could not read the file. Please upload a valid .xlsx or .csv. " +
        (err instanceof Error ? err.message : ""),
    );
  }

  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new SheetError("The file has no sheets.");
  const ws = wb.Sheets[sheetName]!;

  // header:1 gives us exact column order including blank-valued columns.
  const matrix = XLSX.utils.sheet_to_json<string[]>(ws, {
    header: 1,
    defval: "",
    raw: false,
    blankrows: false,
  });
  if (matrix.length === 0) throw new SheetError("The sheet is empty.");

  const header = (matrix[0] ?? []).map((h) => String(h).trim());
  const websiteIdx = header.findIndex((h) => h.toLowerCase() === "website");
  if (websiteIdx === -1) {
    throw new SheetError(
      `Missing required column "Website". Found columns: ${header.filter(Boolean).join(", ") || "(none)"}.`,
    );
  }

  const columns = header.filter((h) => h.length > 0);
  const rows: AccountRow[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const cells = matrix[r] ?? [];
    const row: AccountRow = {};
    let nonEmpty = false;
    header.forEach((label, c) => {
      if (!label) return;
      const value = cells[c] ?? "";
      row[label] = value;
      if (String(value).trim()) nonEmpty = true;
    });
    if (nonEmpty) rows.push(row);
  }

  return { columns, rows };
}
