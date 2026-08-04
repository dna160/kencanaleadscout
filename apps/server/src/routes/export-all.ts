/**
 * Raw data exports.
 *
 * GET /api/export/visitations.xlsx — one sheet per visitation division.
 * GET /api/export/database.zip     — the ENTIRE database: every table in the
 *                                    public schema as its own CSV, plus a
 *                                    schema listing and a manifest. Generated
 *                                    in-process (the app can reach the DB even
 *                                    though external pg_dump cannot).
 */
import type { FastifyInstance } from "fastify";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import { getSql, type Sql } from "../db/client.js";

/** Convert Date values to ISO strings so the sheet shows the raw stored value. */
function isoize(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) o[k] = v instanceof Date ? v.toISOString() : v;
    return o;
  });
}

async function safeQuery(
  db: Sql,
  run: (db: Sql) => Promise<Record<string, unknown>[]>,
): Promise<Record<string, unknown>[]> {
  try {
    return await run(db);
  } catch {
    return [];
  }
}

/** Render one value as a CSV cell (raw form; bytea → base64, timestamps → ISO). */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (Buffer.isBuffer(v)) s = v.toString("base64");
  else if (v instanceof Uint8Array) s = Buffer.from(v).toString("base64");
  else if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const head = columns.map(csvCell).join(",");
  if (!rows.length) return `${head}\n`;
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(",")).join("\n");
  return `${head}\n${body}\n`;
}

export async function exportAllRoutes(app: FastifyInstance): Promise<void> {
  // ── One workbook, a sheet per visitation division ──────────────────────────
  app.get("/api/export/visitations.xlsx", async (_request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const [retail, mirae, project] = await Promise.all([
      safeQuery(db, (d) => d`
        select v.*, s.full_name as salesperson_name, s.code as salesperson_code
        from visits v left join salespeople s on s.id = v.salesperson_id
        order by v.visited_at
      `),
      safeQuery(db, (d) => d`
        select v.*, s.full_name as salesperson_name, s.code as salesperson_code
        from mirae_visits v left join mirae_salespeople s on s.id = v.salesperson_id
        order by v.visited_at
      `),
      safeQuery(db, (d) => d`
        select v.*, s.full_name as salesperson_name, s.code as salesperson_code
        from project_visits v left join project_salespeople s on s.id = v.salesperson_id
        order by v.visited_at
      `),
    ]);

    const wb = XLSX.utils.book_new();
    for (const [name, rows] of [["Retail", retail], ["Mirae", mirae], ["Project", project]] as const) {
      const ws = rows.length ? XLSX.utils.json_to_sheet(isoize(rows)) : XLSX.utils.aoa_to_sheet([["(no data)"]]);
      XLSX.utils.book_append_sheet(wb, ws, name);
    }
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const filename = `visitations_all_${new Date().toISOString().slice(0, 10)}.xlsx`;
    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(buf);
  });

  // ── Entire database → zip of per-table CSVs + schema + manifest ────────────
  app.get("/api/export/database.zip", async (_request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const tables = await db<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `;
    const colRows = await db<{ table_name: string; column_name: string; data_type: string; is_nullable: string }[]>`
      select table_name, column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position
    `;
    const colsByTable = new Map<string, { column_name: string; data_type: string; is_nullable: string }[]>();
    for (const c of colRows) {
      const arr = colsByTable.get(c.table_name) ?? [];
      arr.push(c);
      colsByTable.set(c.table_name, arr);
    }

    const zip = new JSZip();
    const manifest: string[] = [
      "Kencana LeadScout — full database export",
      `Generated: ${new Date().toISOString()}`,
      `Tables: ${tables.length}`,
      "bytea columns are base64-encoded; timestamps are ISO-8601 (UTC).",
      "",
      "table,rows",
    ];
    const schema: string[] = [];

    for (const { table_name } of tables) {
      const cols = colsByTable.get(table_name) ?? [];
      const colNames = cols.map((c) => c.column_name);
      schema.push(`# ${table_name}`);
      for (const c of cols) schema.push(`    ${c.column_name}  ${c.data_type}${c.is_nullable === "NO" ? " NOT NULL" : ""}`);
      schema.push("");

      const rows = (await db`select * from ${db(table_name)}`) as unknown as Record<string, unknown>[];
      manifest.push(`${table_name},${rows.length}`);
      zip.file(`tables/${table_name}.csv`, toCsv(colNames, rows));
    }
    zip.file("_manifest.txt", `${manifest.join("\n")}\n`);
    zip.file("_schema.txt", schema.join("\n"));

    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const filename = `kencana_db_export_${new Date().toISOString().slice(0, 10)}.zip`;
    return reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(buf);
  });
}
