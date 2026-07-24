/**
 * Combined raw export of every visitation-log division into one XLSX workbook.
 *
 * GET /api/export/visitations.xlsx
 *
 * One sheet per division (Retail / Mirae / Project), each containing every raw
 * column of that division's visits table (via `v.*`) plus the resolved
 * salesperson name/code. Timestamps are emitted as ISO-8601 (UTC) strings so
 * the raw stored value is unambiguous. Each division is fetched independently
 * so a missing table can't break the whole export.
 */
import type { FastifyInstance } from "fastify";
import * as XLSX from "xlsx";
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

export async function exportAllRoutes(app: FastifyInstance): Promise<void> {
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
      // Empty divisions still get a (blank) sheet so the workbook shape is stable.
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
}
