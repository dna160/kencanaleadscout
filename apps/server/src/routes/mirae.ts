/**
 * Mirae Visitation Log routes — isolated module.
 *
 * All database tables are prefixed with mirae_.
 * All API endpoints are under /api/mirae/.
 *
 * Salespeople: Brilliano (BRL), Bayu (BYU), Sarah (SRH).
 * No pipeline/accounts — pure visitation log + insights.
 */
import type { FastifyInstance } from "fastify";
import * as XLSX from "xlsx";
import { getSql } from "../db/client.js";

const CUSTOMER_TYPES   = new Set(["new", "old"]);
const CUSTOMER_STATUSES = new Set(["aktif", "prospek", "follow_up", "tidak_aktif"]);

function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseTs(s: string | undefined): Date {
  if (s) { const d = new Date(s); if (!Number.isNaN(d.getTime())) return d; }
  return new Date();
}

function defaultRange(query: { from?: string; to?: string }): { from: Date; to: Date } {
  const to   = parseTs(query.to);
  const from = query.from ? parseTs(query.from) : new Date(to.getTime() - 30 * 86400_000);
  return { from, to };
}

function archetype(hunterIndex: number, topCategoryPct: number, uniqueAreas: number): string {
  const labels: string[] = [];
  labels.push(hunterIndex >= 50 ? "Hunter" : "Maintainer");
  if (topCategoryPct >= 60) labels.push("Specialist");
  labels.push(uniqueAreas <= 2 ? "Anchored" : "Roamer");
  return labels.join("/");
}

export async function miraeRoutes(app: FastifyInstance): Promise<void> {

  // ── Salespeople ────────────────────────────────────────────────────────────
  app.get<{ Querystring: { active?: string } }>("/api/mirae/salespeople", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });
    const activeOnly = request.query.active !== "false";
    const rows = await db`
      select id, full_name, code, active, created_at
      from mirae_salespeople
      ${activeOnly ? db`where active = true` : db``}
      order by full_name
    `;
    return { salespeople: rows };
  });

  // ── Lists ──────────────────────────────────────────────────────────────────
  app.get("/api/mirae/lists/categories", async (_req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });
    const rows = await db<{ value: string }[]>`
      select value from mirae_visit_lists where type = 'category' and active = true order by value
    `;
    return { values: rows.map((r) => r.value) };
  });

  app.get("/api/mirae/lists/areas", async (_req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });
    const rows = await db<{ value: string }[]>`
      select value from mirae_visit_lists where type = 'area' and active = true order by value
    `;
    return { values: rows.map((r) => r.value) };
  });

  // ── Customer suggest ───────────────────────────────────────────────────────
  app.get<{ Querystring: { q?: string } }>("/api/mirae/customers/suggest", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });
    const q = request.query.q ? `%${request.query.q}%` : "%";
    const rows = await db<{
      id: number; store_name: string; category: string; area: string | null;
      address: string | null; postal_code: string | null; last_pic_name: string | null;
    }[]>`
      select
        c.id, c.store_name, c.category, c.area, c.address, c.postal_code,
        (
          select v.pic_name
          from mirae_visits v
          where v.customer_id = c.id and v.pic_name is not null
          order by v.visited_at desc limit 1
        ) as last_pic_name
      from mirae_customers c
      where lower(c.store_name) like lower(${q})
      order by c.store_name
      limit 20
    `;
    return { suggestions: rows };
  });

  // ── Customer portfolio (for My Day) ───────────────────────────────────────
  app.get<{ Querystring: { rep_id?: string } }>("/api/mirae/customers/portfolio", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const rep_id = request.query.rep_id ? Number(request.query.rep_id) : null;

    const rows = await db`
      select
        c.id, c.store_name, c.category, c.area, c.address, c.status,
        count(v.id)::int                                          as visit_count,
        max(v.visited_at)                                         as last_visit_at,
        count(*) filter (where v.customer_type = 'new')::int      as new_count,
        count(*) filter (where v.customer_type = 'old')::int      as old_count,
        -- Live repeating health from visit recency (same thresholds as retail
        -- insights: <10d aktif, <14d perlu_followup, <17d at_risk, else hibernasi)
        -- so My Day can flag customers that need a follow-up visit.
        case
          when extract(epoch from (now() - max(v.visited_at))) / 86400 < 10 then 'aktif'
          when extract(epoch from (now() - max(v.visited_at))) / 86400 < 14 then 'perlu_followup'
          when extract(epoch from (now() - max(v.visited_at))) / 86400 < 17 then 'at_risk'
          else 'hibernasi'
        end                                                       as health
      from mirae_customers c
      join mirae_visits v on v.customer_id = c.id
      ${rep_id ? db`where v.salesperson_id = ${rep_id}` : db``}
      group by c.id, c.store_name, c.category, c.area, c.address
      order by max(v.visited_at) desc
      limit 300
    `;
    return { customers: rows };
  });

  // ── Create visit ───────────────────────────────────────────────────────────
  app.post<{ Body: Record<string, unknown> }>("/api/mirae/visits", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const b = request.body ?? {};
    const salesperson_id_raw = b.salesperson_id != null ? Number(b.salesperson_id) : null;
    const pic_name     = b.pic_name     ? String(b.pic_name).trim()     : null;
    const store_name   = String(b.store_name   ?? "").trim();
    const customer_type = String(b.customer_type ?? "").trim().toLowerCase();
    const category     = String(b.category     ?? "").trim();
    const address      = b.address      ? String(b.address).trim()      : null;
    const area         = String(b.area ?? "").trim()
      .replace(/\b\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    const postal_code  = b.postal_code  ? String(b.postal_code).trim()  : null;
    const notes        = b.notes        ? String(b.notes).trim()        : null;
    const phone        = b.phone        ? String(b.phone).trim()        : null;
    const activity_type_raw = b.activity_type
      ? String(b.activity_type).trim().toLowerCase() : "kunjungan";
    const activity_type = ["kunjungan", "telepon"].includes(activity_type_raw)
      ? activity_type_raw : "kunjungan";

    if (!salesperson_id_raw || !Number.isInteger(salesperson_id_raw) || salesperson_id_raw < 1)
      return reply.code(400).send({ error: "salesperson_id is required." });
    if (!store_name)
      return reply.code(400).send({ error: "store_name is required." });
    if (!CUSTOMER_TYPES.has(customer_type))
      return reply.code(400).send({ error: "customer_type must be 'new' or 'old'." });
    if (!category)
      return reply.code(400).send({ error: "category is required." });
    if (!area)
      return reply.code(400).send({ error: "area is required." });
    if (postal_code && !/^\d{5}$/.test(postal_code))
      return reply.code(400).send({ error: "postal_code must be 5 digits if provided." });

    const salesperson_id = salesperson_id_raw;

    let customer_id: number | null = null;
    try {
      const [cust] = await db<{ id: number }[]>`
        insert into mirae_customers
          (store_name, category, area, address, postal_code, first_seen_at, created_by)
        values
          (${store_name}, ${category}, ${area}, ${address}, ${postal_code}, now(), ${salesperson_id})
        on conflict (lower(trim(store_name)), lower(coalesce(area, '')))
        do update set
          address     = coalesce(mirae_customers.address,     excluded.address),
          postal_code = coalesce(mirae_customers.postal_code, excluded.postal_code)
        returning id
      `;
      customer_id = cust?.id ?? null;
    } catch {
      // non-fatal — visit still saved without customer link
    }

    const [visit] = await db`
      insert into mirae_visits (
        salesperson_id, customer_id, pic_name, store_name,
        customer_type, category, address, area, postal_code, notes,
        phone, activity_type, visited_at, source
      ) values (
        ${salesperson_id}, ${customer_id}, ${pic_name}, ${store_name},
        ${customer_type}, ${category}, ${address}, ${area}, ${postal_code}, ${notes},
        ${phone}, ${activity_type}, now(), 'app'
      )
      returning *
    `;

    return { ok: true, visit };
  });

  // ── List visits ────────────────────────────────────────────────────────────
  app.get<{ Querystring: Record<string, string> }>("/api/mirae/visits", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const q        = request.query;
    const rep_id   = q.rep_id ? Number(q.rep_id) : null;
    const ctype    = q.type && CUSTOMER_TYPES.has(q.type) ? q.type : null;
    const category = q.category ? decodeURIComponent(q.category) : null;
    const area     = q.area     ? decodeURIComponent(q.area)     : null;
    const from_ts  = parseDate(q.from);
    const to_ts    = parseDate(q.to);
    const search   = q.q ? `%${q.q}%` : null;
    const limit    = Math.min(Number(q.limit) || 100, 500);
    const offset   = Number(q.offset) || 0;

    const rows = await db`
      select
        v.id, v.salesperson_id, v.customer_id,
        v.pic_name, v.store_name, v.customer_type, v.category,
        v.address, v.area, v.postal_code, v.notes, v.phone,
        v.visited_at, v.source, v.activity_type,
        s.full_name as salesperson_name,
        s.code      as salesperson_code
      from mirae_visits v
      join mirae_salespeople s on s.id = v.salesperson_id
      where true
        ${rep_id   ? db`and v.salesperson_id = ${rep_id}` : db``}
        ${ctype    ? db`and v.customer_type = ${ctype}`   : db``}
        ${category ? db`and lower(v.category) = lower(${category})` : db``}
        ${area     ? db`and lower(v.area)     = lower(${area})`     : db``}
        ${from_ts  ? db`and v.visited_at >= ${from_ts}`  : db``}
        ${to_ts    ? db`and v.visited_at <= ${to_ts}`    : db``}
        ${search   ? db`and v.notes ilike ${search}`     : db``}
      order by v.visited_at desc
      limit ${limit} offset ${offset}
    `;

    return { count: rows.length, visits: rows };
  });

  // ── Live stats ─────────────────────────────────────────────────────────────
  app.get("/api/mirae/visits/stats", async (_request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const WIB_MS = 7 * 3600 * 1000;
    const shifted = new Date(Date.now() + WIB_MS);
    const todayStart = new Date(
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - WIB_MS
    );
    const weekStart = new Date(todayStart.getTime() - 6 * 24 * 3600 * 1000);

    const [totalsRows, repRows, dayRows, recentRows, todayRows] = await Promise.all([
      db<Record<string, string>[]>`
        SELECT
          COUNT(*) FILTER (WHERE visited_at >= ${todayStart})                                   AS today,
          COUNT(*) FILTER (WHERE visited_at >= ${todayStart} AND customer_type = 'new')         AS today_new,
          COUNT(*) FILTER (WHERE visited_at >= ${todayStart} AND customer_type = 'old')         AS today_old,
          COUNT(DISTINCT salesperson_id) FILTER (WHERE visited_at >= ${todayStart})             AS active_reps_today,
          COUNT(*) FILTER (WHERE visited_at >= ${weekStart})                                    AS week_total,
          COUNT(*) FILTER (WHERE visited_at >= ${weekStart} AND customer_type = 'new')          AS week_new
        FROM mirae_visits
      `,
      db`
        SELECT
          s.id AS salesperson_id, s.full_name, s.code,
          COUNT(*)                                         AS total,
          COUNT(*) FILTER (WHERE v.customer_type = 'new') AS new_count,
          COUNT(*) FILTER (WHERE v.customer_type = 'old') AS old_count
        FROM mirae_visits v
        JOIN mirae_salespeople s ON s.id = v.salesperson_id
        WHERE v.visited_at >= ${todayStart}
        GROUP BY s.id, s.full_name, s.code
        ORDER BY total DESC
      `,
      db`
        SELECT
          (date_trunc('day', visited_at AT TIME ZONE 'Asia/Jakarta'))::date AS day,
          COUNT(*)                                       AS total,
          COUNT(*) FILTER (WHERE customer_type = 'new') AS new_count
        FROM mirae_visits
        WHERE visited_at >= ${weekStart}
        GROUP BY 1 ORDER BY 1
      `,
      db`
        SELECT
          v.id, v.store_name, v.customer_type, v.area, v.category,
          v.pic_name, v.phone, v.visited_at, v.activity_type,
          s.full_name AS salesperson_name,
          s.code      AS salesperson_code
        FROM mirae_visits v
        JOIN mirae_salespeople s ON s.id = v.salesperson_id
        ORDER BY v.visited_at DESC LIMIT 15
      `,
      db`
        SELECT
          v.id, v.store_name, v.customer_type, v.area, v.category,
          v.pic_name, v.phone, v.notes, v.visited_at, v.activity_type,
          s.full_name AS salesperson_name,
          s.code      AS salesperson_code
        FROM mirae_visits v
        JOIN mirae_salespeople s ON s.id = v.salesperson_id
        WHERE v.visited_at >= ${todayStart}
        ORDER BY v.visited_at DESC LIMIT 500
      `,
    ]);

    const t = totalsRows[0] ?? {};
    return {
      totals: {
        today:             Number(t.today)             || 0,
        today_new:         Number(t.today_new)         || 0,
        today_old:         Number(t.today_old)         || 0,
        active_reps_today: Number(t.active_reps_today) || 0,
        week_total:        Number(t.week_total)        || 0,
        week_new:          Number(t.week_new)          || 0,
      },
      by_rep_today: repRows,
      by_day_7:     dayRows,
      recent:       recentRows,
      today_visits: todayRows,
      today_start:  todayStart.toISOString(),
    };
  });

  // ── Summary (count bar) ────────────────────────────────────────────────────
  app.get<{ Querystring: Record<string, string> }>("/api/mirae/visits/summary", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const q       = request.query;
    const rep_id  = q.rep  ? Number(q.rep)  : null;
    const from_ts = parseDate(q.from) ?? new Date(0);
    const to_ts   = parseDate(q.to)   ?? new Date();

    const [[visits]] = await Promise.all([
      db<{ total_visits: string; new_visits: string; old_visits: string }[]>`
        select
          count(*)::int                                       as total_visits,
          count(*) filter (where customer_type = 'new')::int as new_visits,
          count(*) filter (where customer_type = 'old')::int as old_visits
        from mirae_visits v
        where v.visited_at >= ${from_ts} and v.visited_at <= ${to_ts}
          ${rep_id ? db`and v.salesperson_id = ${rep_id}` : db``}
      `,
    ]);

    return {
      total_visits: Number(visits?.total_visits ?? 0),
      new_visits:   Number(visits?.new_visits   ?? 0),
      old_visits:   Number(visits?.old_visits   ?? 0),
      won_accounts: 0,
    };
  });

  // ── XLSX export ────────────────────────────────────────────────────────────
  app.get<{ Querystring: Record<string, string> }>("/api/mirae/visits/export", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const q        = request.query;
    const rep_id   = q.rep_id ? Number(q.rep_id) : null;
    const ctype    = q.type && CUSTOMER_TYPES.has(q.type) ? q.type : null;
    const category = q.category || null;
    const area     = q.area     || null;
    const from_ts  = parseDate(q.from);
    const to_ts    = parseDate(q.to);

    const rows = await db<{
      id: number; visited_at: string;
      salesperson_name: string; salesperson_code: string;
      store_name: string; pic_name: string | null; phone: string | null;
      customer_type: string; category: string;
      area: string; address: string | null;
      postal_code: string | null; notes: string | null;
    }[]>`
      select
        v.id,
        to_char(v.visited_at at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') as visited_at,
        s.full_name as salesperson_name, s.code as salesperson_code,
        v.store_name, v.pic_name, v.phone, v.customer_type, v.category,
        v.area, v.address, v.postal_code, v.notes
      from mirae_visits v
      join mirae_salespeople s on s.id = v.salesperson_id
      where true
        ${rep_id   ? db`and v.salesperson_id = ${rep_id}` : db``}
        ${ctype    ? db`and v.customer_type = ${ctype}`   : db``}
        ${category ? db`and lower(v.category) = lower(${category})` : db``}
        ${area     ? db`and lower(v.area)     = lower(${area})`     : db``}
        ${from_ts  ? db`and v.visited_at >= ${from_ts}`  : db``}
        ${to_ts    ? db`and v.visited_at <= ${to_ts}`    : db``}
      order by v.visited_at desc limit 5000
    `;

    const data = rows.map((r) => ({
      "ID":                    r.id,
      "Waktu Kunjungan (WIB)": r.visited_at,
      "Sales":                 `${r.salesperson_name} (${r.salesperson_code})`,
      "Nama Toko":             r.store_name,
      "PIC":                   r.pic_name ?? "",
      "No. HP":                r.phone ?? "",
      "Tipe":                  r.customer_type === "new" ? "NEW" : "OLD",
      "Kategori":              r.category,
      "Area":                  r.area,
      "Alamat":                r.address ?? "",
      "Kode Pos":              r.postal_code ?? "",
      "Catatan":               r.notes ?? "",
    }));

    const ws    = XLSX.utils.json_to_sheet(data);
    const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
    for (let R = range.s.r + 1; R <= range.e.r; R++) {
      const tipeCell = ws[XLSX.utils.encode_cell({ r: R, c: 5 })];
      const rgb = tipeCell?.v === "NEW" ? "E8F1FB" : "EAF5EA";
      for (let C = range.s.c; C <= range.e.c; C++) {
        const addr = XLSX.utils.encode_cell({ r: R, c: C });
        if (!ws[addr]) ws[addr] = { t: "z", v: "" };
        (ws[addr] as Record<string, unknown>).s = { fill: { fgColor: { rgb } } };
      }
    }
    const wb  = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Kunjungan");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellStyles: true }) as Buffer;

    const filename = `mirae_kunjungan_${new Date().toISOString().slice(0, 10)}.xlsx`;
    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(buf);
  });

  // ── Handler: override visited_at ──────────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Body: { visited_at?: string; changed_by?: string };
  }>("/api/mirae/visits/:id", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1)
      return reply.code(400).send({ error: "Invalid visit id." });

    const b          = request.body ?? {};
    const new_ts     = b.visited_at ? new Date(b.visited_at) : null;
    const changed_by = b.changed_by ? String(b.changed_by).trim() : "Handler";

    if (!new_ts || Number.isNaN(new_ts.getTime()))
      return reply.code(400).send({ error: "visited_at must be a valid ISO datetime." });

    const [current] = await db<{ id: number; visited_at: Date }[]>`
      select id, visited_at from mirae_visits where id = ${id}
    `;
    if (!current) return reply.code(404).send({ error: "Visit not found." });

    const [saved] = await db`
      update mirae_visits set visited_at = ${new_ts} where id = ${id} returning *
    `;
    await db`
      insert into mirae_visit_audits (visit_id, field, old_value, new_value, changed_by)
      values (${id}, 'visited_at', ${current.visited_at.toISOString()}, ${new_ts.toISOString()}, ${changed_by})
    `;
    return { ok: true, visit: saved };
  });

  // ── Edit visit fields ─────────────────────────────────────────────────────
  app.put<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>("/api/mirae/visits/:id", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1)
      return reply.code(400).send({ error: "Invalid visit id." });

    const b = request.body ?? {};
    const store_name = String(b.store_name ?? "").trim();
    if (!store_name) return reply.code(400).send({ error: "store_name is required." });
    const customer_type_raw = String(b.customer_type ?? "").trim().toLowerCase();
    if (!CUSTOMER_TYPES.has(customer_type_raw))
      return reply.code(400).send({ error: "customer_type must be 'new' or 'old'." });
    const category = String(b.category ?? "").trim();
    if (!category) return reply.code(400).send({ error: "category is required." });
    const area = String(b.area ?? "").trim();
    if (!area) return reply.code(400).send({ error: "area is required." });
    const activity_type_raw = String(b.activity_type ?? "kunjungan").trim().toLowerCase();
    const activity_type = ["kunjungan", "telepon"].includes(activity_type_raw) ? activity_type_raw : "kunjungan";
    const pic_name    = b.pic_name    ? String(b.pic_name).trim()    : null;
    const phone       = b.phone       ? String(b.phone).trim()       : null;
    const address     = b.address     ? String(b.address).trim()     : null;
    const postal_code = b.postal_code ? String(b.postal_code).trim() : null;
    const notes       = b.notes       ? String(b.notes).trim()       : null;

    if (postal_code && !/^\d{5}$/.test(postal_code))
      return reply.code(400).send({ error: "postal_code must be 5 digits if provided." });

    const [current] = await db<{ id: number }[]>`select id from mirae_visits where id = ${id}`;
    if (!current) return reply.code(404).send({ error: "Visit not found." });

    const [saved] = await db`
      update mirae_visits set
        activity_type = ${activity_type},
        customer_type = ${customer_type_raw},
        store_name    = ${store_name},
        category      = ${category},
        area          = ${area},
        pic_name      = ${pic_name},
        phone         = ${phone},
        address       = ${address},
        postal_code   = ${postal_code},
        notes         = ${notes}
      where id = ${id}
      returning *
    `;
    return { ok: true, visit: saved };
  });

  // ── Delete visit (+ audits; photos cascade) ────────────────────────────────
  app.delete<{ Params: { id: string } }>("/api/mirae/visits/:id", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1)
      return reply.code(400).send({ error: "Invalid visit id." });

    const [visit] = await db<{ id: number }[]>`select id from mirae_visits where id = ${id}`;
    if (!visit) return reply.code(404).send({ error: "Visit not found." });

    await db`delete from mirae_visit_audits where visit_id = ${id}`;
    await db`delete from mirae_visits where id = ${id}`;
    return { ok: true };
  });

  // ── Update customer status ─────────────────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Body: { status?: unknown };
  }>("/api/mirae/customers/:id/status", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1)
      return reply.code(400).send({ error: "Invalid customer id." });

    const status = String(request.body?.status ?? "").trim().toLowerCase();
    if (!CUSTOMER_STATUSES.has(status))
      return reply.code(400).send({ error: "status must be: aktif, prospek, follow_up, atau tidak_aktif." });

    const [updated] = await db<{ id: number; status: string }[]>`
      update mirae_customers set status = ${status} where id = ${id} returning id, status
    `;
    if (!updated) return reply.code(404).send({ error: "Customer not found." });
    return { ok: true, id: updated.id, status: updated.status };
  });

  // ── Photo upload ───────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/mirae/visits/:id/photos", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1)
      return reply.code(400).send({ error: "Invalid visit id." });

    const [visit] = await db<{ id: number }[]>`select id from mirae_visits where id = ${id}`;
    if (!visit) return reply.code(404).send({ error: "Visit not found." });

    const [countRow] = await db<{ n: string }[]>`
      select count(*)::text as n from mirae_visit_photos where visit_id = ${id}
    `;
    if (Number(countRow?.n ?? 0) >= 5)
      return reply.code(400).send({ error: "Maksimal 5 foto per kunjungan." });

    let file: Awaited<ReturnType<typeof request.file>>;
    try {
      file = await request.file({ limits: { fileSize: 8 * 1024 * 1024 } });
    } catch {
      return reply.code(400).send({ error: "Gagal membaca file upload." });
    }
    if (!file) return reply.code(400).send({ error: "Tidak ada file yang dikirim." });
    if (!file.mimetype.startsWith("image/"))
      return reply.code(400).send({ error: "Hanya file gambar yang diizinkan." });

    let buf: Buffer;
    try {
      buf = await file.toBuffer();
    } catch {
      return reply.code(413).send({ error: "File terlalu besar (maks 8 MB)." });
    }

    const [photo] = await db`
      insert into mirae_visit_photos (visit_id, file_data, mime_type, filename, file_size)
      values (${id}, ${buf}, ${file.mimetype}, ${file.filename ?? null}, ${buf.length})
      returning id, visit_id, mime_type, filename, file_size, created_at
    `;
    if (!photo) return reply.code(500).send({ error: "Insert photo failed." });
    return { ok: true, photo: { ...photo, url: `/api/mirae/photos/${photo.id}` } };
  });

  // ── Serve photo ────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/mirae/photos/:id", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: "Invalid id." });

    const [photo] = await db<{ file_data: Buffer; mime_type: string }[]>`
      select file_data, mime_type from mirae_visit_photos where id = ${id}
    `;
    if (!photo) return reply.code(404).send({ error: "Photo not found." });

    return reply
      .header("Content-Type", photo.mime_type)
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .send(photo.file_data);
  });

  // ── List photos for a visit ────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/mirae/visits/:id/photos", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: "Invalid id." });

    const rows = await db`
      select id, visit_id, mime_type, filename, file_size, created_at
      from mirae_visit_photos where visit_id = ${id} order by created_at
    `;
    return { photos: rows.map((r) => ({ ...r, url: `/api/mirae/photos/${r.id}` })) };
  });

  // ── Delete a photo ─────────────────────────────────────────────────────────
  app.delete<{ Params: { photoId: string } }>("/api/mirae/photos/:photoId", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const photoId = Number(request.params.photoId);
    if (!Number.isInteger(photoId) || photoId < 1)
      return reply.code(400).send({ error: "Invalid id." });

    const [deleted] = await db`delete from mirae_visit_photos where id = ${photoId} returning id`;
    if (!deleted) return reply.code(404).send({ error: "Photo not found." });
    return { ok: true };
  });

  // ── Insights: per-rep scorecard ────────────────────────────────────────────
  app.get<{
    Params: { id: string };
    Querystring: { from?: string; to?: string };
  }>("/api/mirae/insights/rep/:id", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const rep_id = Number(request.params.id);
    if (!Number.isInteger(rep_id) || rep_id < 1)
      return reply.code(400).send({ error: "Invalid rep id." });

    const { from, to } = defaultRange(request.query);

    const [base] = await db<{
      full_name: string; code: string;
      total_visits: string; active_days: string;
      new_visits: string; unique_stores: string; notes_ok: string; phone_ok: string;
    }[]>`
      select
        s.full_name, s.code,
        count(v.id)::text                                                    as total_visits,
        count(distinct date(v.visited_at at time zone 'Asia/Jakarta'))::text as active_days,
        count(*) filter (where v.customer_type = 'new')::text               as new_visits,
        count(distinct v.customer_id)::text                                  as unique_stores,
        count(*) filter (where length(coalesce(v.notes,'')) >= 40)::text     as notes_ok,
        count(*) filter (where v.phone is not null and trim(v.phone) <> '')::text as phone_ok
      from mirae_salespeople s
      left join mirae_visits v on v.salesperson_id = s.id
        and v.visited_at >= ${from} and v.visited_at <= ${to}
      where s.id = ${rep_id}
      group by s.id, s.full_name, s.code
    `;
    if (!base) return reply.code(404).send({ error: "Salesperson not found." });

    const totalVisits  = Number(base.total_visits);
    const activeDays   = Number(base.active_days);
    const newVisits    = Number(base.new_visits);
    const uniqueStores = Number(base.unique_stores);
    const notesOk      = Number(base.notes_ok);
    const phoneOk      = Number(base.phone_ok);

    const [catMix, areaMix, hourly] = await Promise.all([
      db<{ category: string; cnt: string }[]>`
        select category, count(*)::text as cnt from mirae_visits
        where salesperson_id = ${rep_id} and visited_at >= ${from} and visited_at <= ${to}
        group by category order by count(*) desc
      `,
      db<{ area: string; cnt: string }[]>`
        select area, count(*)::text as cnt from mirae_visits
        where salesperson_id = ${rep_id} and visited_at >= ${from} and visited_at <= ${to}
        group by area order by count(*) desc
      `,
      db<{ hour: string; cnt: string }[]>`
        select
          extract(hour from visited_at at time zone 'Asia/Jakarta')::text as hour,
          count(*)::text as cnt
        from mirae_visits
        where salesperson_id = ${rep_id} and visited_at >= ${from} and visited_at <= ${to}
        group by hour order by hour
      `,
    ]);

    const hunterIndex    = totalVisits > 0 ? Math.round((newVisits / totalVisits) * 1000) / 10 : 0;
    const topCategoryPct = totalVisits > 0 && catMix[0]
      ? Math.round((Number(catMix[0].cnt) / totalVisits) * 1000) / 10 : 0;
    const uniqueAreas = areaMix.length;
    const topAreaPct  = totalVisits > 0 && areaMix[0]
      ? Math.round((Number(areaMix[0].cnt) / totalVisits) * 1000) / 10 : 0;

    return {
      rep_id,
      full_name: base.full_name,
      code:      base.code,
      period:    { from, to },
      scorecard: {
        total_visits:          totalVisits,
        active_days:           activeDays,
        visits_per_active_day: activeDays > 0 ? Math.round((totalVisits / activeDays) * 10) / 10 : 0,
        hunter_index:          hunterIndex,
        unique_stores:         uniqueStores,
        notes_discipline:      totalVisits > 0 ? Math.round((notesOk / totalVisits) * 1000) / 10 : 0,
        phone_coverage:        totalVisits > 0 ? Math.round((phoneOk / totalVisits) * 1000) / 10 : 0,
        top_area_pct:          topAreaPct,
        unique_areas:          uniqueAreas,
      },
      archetype:    archetype(hunterIndex, topCategoryPct, uniqueAreas),
      category_mix: catMix.map((r) => ({
        category: r.category,
        count:    Number(r.cnt),
        pct:      totalVisits > 0 ? Math.round((Number(r.cnt) / totalVisits) * 1000) / 10 : 0,
      })),
      area_mix: areaMix.map((r) => ({
        area:  r.area,
        count: Number(r.cnt),
        pct:   totalVisits > 0 ? Math.round((Number(r.cnt) / totalVisits) * 1000) / 10 : 0,
      })),
      hourly_histogram:       hourly.map((r) => ({ hour: Number(r.hour), count: Number(r.cnt) })),
      project_stage_counts:   {},
      repeating_stage_counts: {},
    };
  });

  // ── Insights: team ─────────────────────────────────────────────────────────
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/mirae/insights/team", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const { from, to } = defaultRange(request.query);

    const [leaderboard, heatmap, weeklyTrend, [totals]] = await Promise.all([
      db<{
        rep_id: string; full_name: string; code: string;
        total_visits: string; new_customers: string; unique_stores: string; hunter_index: string;
      }[]>`
        select
          s.id::text as rep_id, s.full_name, s.code,
          count(v.id)::text as total_visits,
          count(*) filter (where v.customer_type = 'new')::text as new_customers,
          count(distinct v.customer_id)::text as unique_stores,
          round(
            count(*) filter (where v.customer_type = 'new')::numeric /
            nullif(count(v.id), 0) * 100, 1
          )::text as hunter_index
        from mirae_salespeople s
        left join mirae_visits v on v.salesperson_id = s.id
          and v.visited_at >= ${from} and v.visited_at <= ${to}
        where s.active = true
        group by s.id, s.full_name, s.code
        order by count(v.id) desc
      `,
      db<{ area: string; category: string; cnt: string }[]>`
        select area, category, count(*)::text as cnt
        from mirae_visits
        where visited_at >= ${from} and visited_at <= ${to}
        group by area, category order by area, count(*) desc
      `,
      db<{ week: string; rep_id: string; full_name: string; new_stores: string }[]>`
        select
          to_char(date_trunc('week', v.visited_at at time zone 'Asia/Jakarta'), 'YYYY-MM-DD') as week,
          s.id::text as rep_id, s.full_name,
          count(*) filter (where v.customer_type = 'new')::text as new_stores
        from mirae_visits v
        join mirae_salespeople s on s.id = v.salesperson_id
        where v.visited_at >= ${from} and v.visited_at <= ${to}
        group by week, s.id, s.full_name
        order by week, s.full_name
      `,
      db<{ total_visits: string; new_visits: string; unique_stores: string; active_reps: string }[]>`
        select
          count(v.id)::text                                     as total_visits,
          count(*) filter (where v.customer_type = 'new')::text as new_visits,
          count(distinct v.customer_id)::text                    as unique_stores,
          count(distinct v.salesperson_id)::text                 as active_reps
        from mirae_visits v
        where v.visited_at >= ${from} and v.visited_at <= ${to}
      `,
    ]);

    return {
      period: { from, to },
      totals: {
        total_visits:  Number(totals?.total_visits  ?? 0),
        new_visits:    Number(totals?.new_visits    ?? 0),
        unique_stores: Number(totals?.unique_stores ?? 0),
        active_reps:   Number(totals?.active_reps   ?? 0),
      },
      leaderboard: leaderboard.map((r) => ({
        rep_id:        Number(r.rep_id),
        full_name:     r.full_name,
        code:          r.code,
        total_visits:  Number(r.total_visits),
        new_customers: Number(r.new_customers),
        unique_stores: Number(r.unique_stores),
        hunter_index:  Number(r.hunter_index ?? 0),
      })),
      heatmap:      heatmap.map((r) => ({ area: r.area, category: r.category, count: Number(r.cnt) })),
      weekly_trend: weeklyTrend.map((r) => ({
        week:       r.week,
        rep_id:     Number(r.rep_id),
        full_name:  r.full_name,
        new_stores: Number(r.new_stores),
      })),
      project_stage_counts:   {},
      repeating_stage_counts: {},
    };
  });
}
