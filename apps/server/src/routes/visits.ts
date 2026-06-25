/**
 * [D] Visit log routes — Module D (Visitation Log microPRD §10).
 *
 * POST   /api/visits              — create (server stamps visited_at)
 * GET    /api/visits              — rack-up list with filters, paginated
 * GET    /api/visits/export       — XLSX download, blue/green fills
 * PATCH  /api/visits/:id          — Handler: override visited_at (audit-logged)
 * GET    /api/customers/suggest   — store-name autocomplete
 */
import type { FastifyInstance } from "fastify";
import * as XLSX from "xlsx";
import { getSql } from "../db/client.js";

const CUSTOMER_TYPES = new Set(["new", "old"]);

function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function visitsRoutes(app: FastifyInstance): Promise<void> {
  // ── Create ────────────────────────────────────────────────────────────────
  app.post<{ Body: Record<string, unknown> }>("/api/visits", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const b = request.body ?? {};
    const salesperson_id_raw = b.salesperson_id != null ? Number(b.salesperson_id) : null;
    const pic_name    = b.pic_name    ? String(b.pic_name).trim()    : null;
    const store_name  = String(b.store_name  ?? "").trim();
    const customer_type = String(b.customer_type ?? "").trim().toLowerCase();
    const category    = String(b.category    ?? "").trim();
    const address     = b.address     ? String(b.address).trim()     : null;
    const area        = String(b.area        ?? "").trim();
    const postal_code = b.postal_code ? String(b.postal_code).trim() : null;
    const notes       = b.notes       ? String(b.notes).trim()       : null;

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

    // Upsert customer master so New/Old auto-detection works on future visits.
    let customer_id: number | null = null;
    try {
      const [cust] = await db<{ id: number }[]>`
        insert into customers (store_name, category, area, address, postal_code, first_seen_at, created_by)
        values (${store_name}, ${category}, ${area}, ${address}, ${postal_code}, now(), ${salesperson_id})
        on conflict (lower(trim(store_name)), coalesce(area, ''))
        do update set
          category    = customers.category,
          address     = coalesce(customers.address, excluded.address),
          postal_code = coalesce(customers.postal_code, excluded.postal_code)
        returning id
      `;
      customer_id = cust?.id ?? null;
    } catch {
      // non-fatal — visit is still saved without the customer link
    }

    const [visit] = await db`
      insert into visits (
        salesperson_id, customer_id, pic_name, store_name,
        customer_type, category, address, area, postal_code, notes,
        visited_at, source
      ) values (
        ${salesperson_id}, ${customer_id}, ${pic_name}, ${store_name},
        ${customer_type}, ${category}, ${address}, ${area}, ${postal_code}, ${notes},
        now(), 'app'
      )
      returning *
    `;
    return { ok: true, visit };
  });

  // ── Rack-up list ─────────────────────────────────────────────────────────
  app.get<{ Querystring: Record<string, string> }>("/api/visits", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const q   = request.query;
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
        v.address, v.area, v.postal_code, v.notes,
        v.visited_at, v.source,
        s.full_name as salesperson_name,
        s.code      as salesperson_code
      from visits v
      join salespeople s on s.id = v.salesperson_id
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

  // ── XLSX export ───────────────────────────────────────────────────────────
  app.get<{ Querystring: Record<string, string> }>("/api/visits/export", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const q  = request.query;
    const rep_id   = q.rep_id ? Number(q.rep_id) : null;
    const ctype    = q.type && CUSTOMER_TYPES.has(q.type) ? q.type : null;
    const category = q.category || null;
    const area     = q.area     || null;
    const from_ts  = parseDate(q.from);
    const to_ts    = parseDate(q.to);

    const rows = await db<{
      id: number; visited_at: string;
      salesperson_name: string; salesperson_code: string;
      store_name: string; pic_name: string | null;
      customer_type: string; category: string;
      area: string; address: string | null;
      postal_code: string | null; notes: string | null;
    }[]>`
      select
        v.id,
        to_char(v.visited_at at time zone 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') as visited_at,
        s.full_name as salesperson_name,
        s.code      as salesperson_code,
        v.store_name, v.pic_name, v.customer_type, v.category,
        v.area, v.address, v.postal_code, v.notes
      from visits v
      join salespeople s on s.id = v.salesperson_id
      where true
        ${rep_id   ? db`and v.salesperson_id = ${rep_id}` : db``}
        ${ctype    ? db`and v.customer_type = ${ctype}`   : db``}
        ${category ? db`and lower(v.category) = lower(${category})` : db``}
        ${area     ? db`and lower(v.area)     = lower(${area})`     : db``}
        ${from_ts  ? db`and v.visited_at >= ${from_ts}`  : db``}
        ${to_ts    ? db`and v.visited_at <= ${to_ts}`    : db``}
      order by v.visited_at desc
      limit 5000
    `;

    const data = rows.map((r) => ({
      "ID":                    r.id,
      "Waktu Kunjungan (WIB)": r.visited_at,
      "Sales":                 `${r.salesperson_name} (${r.salesperson_code})`,
      "Nama Toko":             r.store_name,
      "PIC":                   r.pic_name ?? "",
      "Tipe":                  r.customer_type === "new" ? "NEW" : "OLD",
      "Kategori":              r.category,
      "Area":                  r.area,
      "Alamat":                r.address ?? "",
      "Kode Pos":              r.postal_code ?? "",
      "Catatan":               r.notes ?? "",
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");

    // Blue fill for new rows, green fill for old rows (column F = "Tipe", index 5).
    for (let R = range.s.r + 1; R <= range.e.r; R++) {
      const tipeCell = ws[XLSX.utils.encode_cell({ r: R, c: 5 })];
      const isNew = tipeCell?.v === "NEW";
      const rgb = isNew ? "E8F1FB" : "EAF5EA";
      for (let C = range.s.c; C <= range.e.c; C++) {
        const addr = XLSX.utils.encode_cell({ r: R, c: C });
        if (!ws[addr]) ws[addr] = { t: "z", v: "" };
        (ws[addr] as Record<string, unknown>).s = { fill: { fgColor: { rgb } } };
      }
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Kunjungan");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellStyles: true }) as Buffer;

    const filename = `kunjungan_${new Date().toISOString().slice(0, 10)}.xlsx`;
    return reply
      .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(buf);
  });

  // ── Live rack-up stats (Module E) ────────────────────────────────────────
  app.get("/api/visits/stats", async (_request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    // Start of today in WIB (UTC+7), expressed as UTC timestamptz
    const WIB_MS = 7 * 3600 * 1000;
    const shifted = new Date(Date.now() + WIB_MS);
    const todayStart = new Date(
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - WIB_MS
    );
    const weekStart = new Date(todayStart.getTime() - 6 * 24 * 3600 * 1000);

    const [totalsRows, repRows, dayRows, recentRows, todayRows] = await Promise.all([
      db<Record<string, string>[]>`
        SELECT
          COUNT(*) FILTER (WHERE visited_at >= ${todayStart})                                        AS today,
          COUNT(*) FILTER (WHERE visited_at >= ${todayStart} AND customer_type = 'new')              AS today_new,
          COUNT(*) FILTER (WHERE visited_at >= ${todayStart} AND customer_type = 'old')              AS today_old,
          COUNT(DISTINCT salesperson_id) FILTER (WHERE visited_at >= ${todayStart})                  AS active_reps_today,
          COUNT(*) FILTER (WHERE visited_at >= ${weekStart})                                         AS week_total,
          COUNT(*) FILTER (WHERE visited_at >= ${weekStart} AND customer_type = 'new')               AS week_new
        FROM visits
      `,
      db`
        SELECT
          s.id           AS salesperson_id,
          s.full_name,
          s.code,
          COUNT(*)                                         AS total,
          COUNT(*) FILTER (WHERE v.customer_type = 'new') AS new_count,
          COUNT(*) FILTER (WHERE v.customer_type = 'old') AS old_count
        FROM visits v
        JOIN salespeople s ON s.id = v.salesperson_id
        WHERE v.visited_at >= ${todayStart}
        GROUP BY s.id, s.full_name, s.code
        ORDER BY total DESC
      `,
      db`
        SELECT
          (date_trunc('day', visited_at AT TIME ZONE 'Asia/Jakarta'))::date AS day,
          COUNT(*)                                         AS total,
          COUNT(*) FILTER (WHERE customer_type = 'new')   AS new_count
        FROM visits
        WHERE visited_at >= ${weekStart}
        GROUP BY 1
        ORDER BY 1
      `,
      db`
        SELECT
          v.id, v.store_name, v.customer_type, v.area, v.category, v.pic_name, v.visited_at,
          s.full_name AS salesperson_name,
          s.code      AS salesperson_code
        FROM visits v
        JOIN salespeople s ON s.id = v.salesperson_id
        ORDER BY v.visited_at DESC
        LIMIT 15
      `,
      db`
        SELECT
          v.id, v.store_name, v.customer_type, v.area, v.category,
          v.pic_name, v.notes, v.visited_at,
          s.full_name AS salesperson_name,
          s.code      AS salesperson_code
        FROM visits v
        JOIN salespeople s ON s.id = v.salesperson_id
        WHERE v.visited_at >= ${todayStart}
        ORDER BY v.visited_at DESC
        LIMIT 500
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

  // ── AI synthesis scaffold ────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/visits/rep/:id/synthesize", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const rep_id = Number(request.params.id);
    if (!Number.isInteger(rep_id) || rep_id < 1)
      return reply.code(400).send({ error: "Invalid rep id." });

    const WIB_MS = 7 * 3600 * 1000;
    const now = new Date(Date.now() + WIB_MS);
    const todayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - WIB_MS);
    const weekAgo  = new Date(todayEnd.getTime() - 7 * 24 * 3600 * 1000);

    const rows = await db<{ store_name: string; customer_type: string; area: string; category: string; notes: string | null; visited_at: Date }[]>`
      SELECT store_name, customer_type, area, category, notes, visited_at
      FROM visits
      WHERE salesperson_id = ${rep_id}
        AND visited_at >= ${weekAgo}
        AND visited_at <  ${todayEnd}
      ORDER BY visited_at DESC
      LIMIT 100
    `;

    const [rep] = await db<{ full_name: string }[]>`SELECT full_name FROM salespeople WHERE id = ${rep_id}`;
    const repName = rep?.full_name ?? `Rep #${rep_id}`;

    const apiKey = process.env.AI_API_KEY;
    const model  = process.env.AI_MODEL ?? "claude-haiku-4-5-20251001";

    if (!apiKey) {
      return {
        ok: false,
        scaffold: true,
        note_count: rows.length,
        rep_name: repName,
        message: "AI synthesis belum dikonfigurasi. Set AI_API_KEY (dan opsional AI_MODEL) di environment untuk mengaktifkan fitur ini.",
      };
    }

    if (rows.length === 0) {
      return { ok: true, synthesis: `Tidak ada kunjungan dalam 7 hari terakhir untuk ${repName}.` };
    }

    const visitLines = rows.map((r) => {
      const wibDate = new Date(new Date(r.visited_at).getTime() + WIB_MS).toISOString().slice(0, 10);
      const tipe = r.customer_type === "new" ? "BARU" : "LAMA";
      const note = r.notes ? ` — ${r.notes}` : "";
      return `${wibDate} | ${tipe} | ${r.store_name} (${r.category}, ${r.area})${note}`;
    }).join("\n");

    const prompt = `Kamu adalah analis penjualan lapangan. Buat ringkasan singkat aktivitas kunjungan sales berikut untuk 7 hari terakhir.

Sales: ${repName}
Total kunjungan: ${rows.length}

Log kunjungan:
${visitLines}

Buat ringkasan dalam Bahasa Indonesia (maks 300 kata) yang mencakup:
1. Pola kunjungan (area, kategori, tipe pelanggan yang dominan)
2. Kebutuhan atau masalah yang muncul dari catatan kunjungan
3. Tantangan atau hambatan yang teridentifikasi
4. Rekomendasi tindak lanjut yang spesifik

Fokus pada insight yang actionable. Jangan ulangi daftar kunjungan.`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        app.log.error({ err }, "AI synthesis API error");
        return reply.code(502).send({ error: "AI synthesis failed. Check server logs." });
      }

      const data = await res.json() as { content: Array<{ type: string; text: string }> };
      const synthesis = data.content.find((c) => c.type === "text")?.text ?? "";
      return { ok: true, synthesis, note_count: rows.length, rep_name: repName };
    } catch (err) {
      app.log.error({ err }, "AI synthesis fetch error");
      return reply.code(502).send({ error: "AI synthesis request failed." });
    }
  });

  // ── Handler: override visited_at (audit-logged) ───────────────────────────
  app.patch<{
    Params: { id: string };
    Body: { visited_at?: string; changed_by?: string };
  }>("/api/visits/:id", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1)
      return reply.code(400).send({ error: "Invalid visit id." });

    const b  = request.body ?? {};
    const new_ts   = b.visited_at ? new Date(b.visited_at) : null;
    const changed_by = b.changed_by ? String(b.changed_by).trim() : "Handler";

    if (!new_ts || Number.isNaN(new_ts.getTime()))
      return reply.code(400).send({ error: "visited_at must be a valid ISO datetime." });

    const [current] = await db<{ id: number; visited_at: Date }[]>`
      select id, visited_at from visits where id = ${id}
    `;
    if (!current) return reply.code(404).send({ error: "Visit not found." });

    const [saved] = await db`
      update visits set visited_at = ${new_ts} where id = ${id} returning *
    `;
    await db`
      insert into visit_audits (visit_id, field, old_value, new_value, changed_by)
      values (${id}, 'visited_at', ${current.visited_at.toISOString()}, ${new_ts.toISOString()}, ${changed_by})
    `;
    return { ok: true, visit: saved };
  });

  // ── Store name autocomplete ───────────────────────────────────────────────
  app.get<{ Querystring: { q?: string } }>("/api/customers/suggest", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const q = request.query.q ? `%${request.query.q}%` : "%";
    const rows = await db<{ store_name: string; category: string; area: string | null }[]>`
      select store_name, category, area
      from customers
      where lower(store_name) like lower(${q})
      order by store_name
      limit 20
    `;
    return { suggestions: rows };
  });
}
