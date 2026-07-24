/**
 * [D] Visit log routes — Module D (Visitation Log microPRD §10).
 *
 * POST   /api/distributor/visits              — create (server stamps visited_at)
 * GET    /api/distributor/visits              — rack-up list with filters, paginated
 * GET    /api/distributor/visits/export       — XLSX download, blue/green fills
 * PATCH  /api/distributor/visits/:id          — Handler: override visited_at (audit-logged)
 * GET    /api/distributor/customers/suggest   — store-name autocomplete
 */
import type { FastifyInstance } from "fastify";
import * as XLSX from "xlsx";
import { getSql } from "../db/client.js";
import { normalizeDistributorArea } from "../util/distributorArea.js";

const CUSTOMER_TYPES = new Set(["new", "old"]);

function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function distributorVisitsRoutes(app: FastifyInstance): Promise<void> {
  // ── Create ────────────────────────────────────────────────────────────────
  app.post<{ Body: Record<string, unknown> }>("/api/distributor/visits", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const b = request.body ?? {};
    const salesperson_id_raw = b.salesperson_id != null ? Number(b.salesperson_id) : null;
    const pic_name    = b.pic_name    ? String(b.pic_name).trim()    : null;
    const store_name  = String(b.store_name  ?? "").trim();
    const customer_type = String(b.customer_type ?? "").trim().toLowerCase();
    const category    = String(b.category    ?? "").trim();
    const address     = b.address     ? String(b.address).trim()     : null;
    const area        = normalizeDistributorArea(b.area as string | undefined);
    const postal_code = b.postal_code ? String(b.postal_code).trim() : null;
    const notes       = b.notes       ? String(b.notes).trim()       : null;
    const activity_type_raw = b.activity_type ? String(b.activity_type).trim().toLowerCase() : "kunjungan";
    const activity_type = ["kunjungan", "telepon"].includes(activity_type_raw) ? activity_type_raw : "kunjungan";

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

    // Derive account_type and initial pipeline stage from category.
    const account_type  = ["Kontraktor", "Aplikator", "Project"].includes(category)
      ? "project"
      : "repeating";
    const initial_stage = account_type === "project" ? "prospek" : "aktif";

    // Optional explicit stage update submitted from the visit form.
    const new_stage_raw = b.new_stage ? String(b.new_stage).trim().toLowerCase() : null;
    const VALID_PROJECT_STAGES   = new Set(["prospek","penawaran","negosiasi","won","gugur"]);
    const VALID_REPEATING_STAGES = new Set(["aktif","perlu_followup","at_risk","hibernasi","repeat_order"]);
    const valid_stages  = account_type === "project" ? VALID_PROJECT_STAGES : VALID_REPEATING_STAGES;
    const new_stage     = new_stage_raw && valid_stages.has(new_stage_raw) ? new_stage_raw : null;

    // Detect whether the customer already exists before upsert (to log initial stage).
    let customer_id: number | null = null;
    let was_new  = false;
    let prev_stage: string | null = null;
    try {
      const [existing] = await db<{ id: number; stage: string }[]>`
        select id, stage from distributor_customers
        where lower(trim(store_name)) = lower(trim(${store_name}))
          and lower(coalesce(area,'')) = lower(coalesce(${area},''))
      `;
      was_new    = !existing;
      prev_stage = existing?.stage ?? null;

      const [cust] = await db<{ id: number; stage: string }[]>`
        insert into distributor_customers (store_name, category, area, address, postal_code,
                               first_seen_at, created_by, account_type, stage, last_contact_at, owner_id)
        values (${store_name}, ${category}, ${area}, ${address}, ${postal_code},
                now(), ${salesperson_id}, ${account_type}, ${initial_stage}, now(), ${salesperson_id})
        on conflict (lower(trim(store_name)), lower(coalesce(area, '')))
        do update set
          category        = distributor_customers.category,
          address         = coalesce(distributor_customers.address, excluded.address),
          postal_code     = coalesce(distributor_customers.postal_code, excluded.postal_code),
          last_contact_at = excluded.last_contact_at,
          owner_id        = coalesce(distributor_customers.owner_id, excluded.owner_id),
          stage           = case
            when distributor_customers.stage = 'hibernasi' then distributor_customers.stage
            else coalesce(distributor_customers.stage, excluded.stage)
          end
        returning id, stage
      `;
      customer_id = cust?.id ?? null;
      if (was_new) prev_stage = null;
      else         prev_stage = cust?.stage ?? prev_stage;
    } catch {
      // non-fatal — visit still saved without customer link
    }

    const [visit] = await db`
      insert into distributor_visits (
        salesperson_id, customer_id, pic_name, store_name,
        customer_type, category, address, area, postal_code, notes,
        activity_type, visited_at, source
      ) values (
        ${salesperson_id}, ${customer_id}, ${pic_name}, ${store_name},
        ${customer_type}, ${category}, ${address}, ${area}, ${postal_code}, ${notes},
        ${activity_type}, now(), 'app'
      )
      returning *
    `;

    // Side-effects (non-fatal): actions timeline + stage history.
    if (customer_id) {
      // Auto-record visit in the account's activity timeline, enriched with PIC name.
      const actionNote = [pic_name ? `PIC: ${pic_name}` : null, notes].filter(Boolean).join("\n") || null;
      db`
        insert into distributor_actions (account_id, salesperson_id, action_type, notes, actioned_at)
        values (${customer_id}, ${salesperson_id}, ${activity_type}, ${actionNote}, now())
      `.catch(() => {});

      if (was_new) {
        // Record the initial pipeline stage for a newly created account.
        db`
          insert into distributor_stage_history (account_id, old_stage, new_stage, changed_by)
          values (${customer_id}, null, ${initial_stage}, ${salesperson_id})
        `.catch(() => {});
      } else if (new_stage && new_stage !== prev_stage) {
        // Apply explicit stage update from visit form.
        db`update distributor_customers set stage = ${new_stage} where id = ${customer_id}`.catch(() => {});
        db`
          insert into distributor_stage_history (account_id, old_stage, new_stage, changed_by)
          values (${customer_id}, ${prev_stage}, ${new_stage}, ${salesperson_id})
        `.catch(() => {});
      }
    }

    return { ok: true, visit };
  });

  // ── Rack-up list ─────────────────────────────────────────────────────────
  app.get<{ Querystring: Record<string, string> }>("/api/distributor/visits", async (request, reply) => {
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
        v.visited_at, v.source, v.activity_type,
        s.full_name as salesperson_name,
        s.code      as salesperson_code
      from distributor_visits v
      join distributor_salespeople s on s.id = v.salesperson_id
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
  app.get<{ Querystring: Record<string, string> }>("/api/distributor/visits/export", async (request, reply) => {
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
      from distributor_visits v
      join distributor_salespeople s on s.id = v.salesperson_id
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
  app.get("/api/distributor/visits/stats", async (_request, reply) => {
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
        FROM distributor_visits
      `,
      db`
        SELECT
          s.id           AS salesperson_id,
          s.full_name,
          s.code,
          COUNT(*)                                         AS total,
          COUNT(*) FILTER (WHERE v.customer_type = 'new') AS new_count,
          COUNT(*) FILTER (WHERE v.customer_type = 'old') AS old_count
        FROM distributor_visits v
        JOIN distributor_salespeople s ON s.id = v.salesperson_id
        WHERE v.visited_at >= ${todayStart}
        GROUP BY s.id, s.full_name, s.code
        ORDER BY total DESC
      `,
      db`
        SELECT
          (date_trunc('day', visited_at AT TIME ZONE 'Asia/Jakarta'))::date AS day,
          COUNT(*)                                         AS total,
          COUNT(*) FILTER (WHERE customer_type = 'new')   AS new_count
        FROM distributor_visits
        WHERE visited_at >= ${weekStart}
        GROUP BY 1
        ORDER BY 1
      `,
      db`
        SELECT
          v.id, v.store_name, v.customer_type, v.area, v.category,
          v.pic_name, v.visited_at, v.activity_type,
          s.full_name AS salesperson_name,
          s.code      AS salesperson_code
        FROM distributor_visits v
        JOIN distributor_salespeople s ON s.id = v.salesperson_id
        ORDER BY v.visited_at DESC
        LIMIT 15
      `,
      db`
        SELECT
          v.id, v.store_name, v.customer_type, v.area, v.category,
          v.pic_name, v.notes, v.visited_at, v.activity_type,
          s.full_name AS salesperson_name,
          s.code      AS salesperson_code
        FROM distributor_visits v
        JOIN distributor_salespeople s ON s.id = v.salesperson_id
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

  // ── Visits summary (for header count bars) ──────────────────────────────
  app.get<{ Querystring: Record<string, string> }>("/api/distributor/visits/summary", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const q      = request.query;
    const rep_id = q.rep  ? Number(q.rep)  : null;
    const from_ts = parseDate(q.from) ?? new Date(0);
    const to_ts   = parseDate(q.to)   ?? new Date();

    const [[visits], [wonRow]] = await Promise.all([
      db<{ total_visits: string; new_visits: string; old_visits: string }[]>`
        select
          count(*)::int                                       as total_visits,
          count(*) filter (where customer_type = 'new')::int as new_visits,
          count(*) filter (where customer_type = 'old')::int as old_visits
        from distributor_visits v
        where v.visited_at >= ${from_ts}
          and v.visited_at <= ${to_ts}
          ${rep_id ? db`and v.salesperson_id = ${rep_id}` : db``}
      `,
      db<{ won_accounts: string }[]>`
        select count(*)::int as won_accounts
        from distributor_stage_history sh
        join distributor_customers c on c.id = sh.account_id
        where sh.new_stage = 'won'
          and sh.changed_at >= ${from_ts}
          and sh.changed_at <= ${to_ts}
          ${rep_id ? db`and c.owner_id = ${rep_id}` : db``}
      `,
    ]);

    return {
      total_visits:  Number(visits?.total_visits  ?? 0),
      new_visits:    Number(visits?.new_visits    ?? 0),
      old_visits:    Number(visits?.old_visits    ?? 0),
      won_accounts:  Number(wonRow?.won_accounts  ?? 0),
    };
  });

  // ── AI synthesis scaffold ────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/distributor/visits/rep/:id/synthesize", async (request, reply) => {
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
      FROM distributor_visits
      WHERE salesperson_id = ${rep_id}
        AND visited_at >= ${weekAgo}
        AND visited_at <  ${todayEnd}
      ORDER BY visited_at DESC
      LIMIT 100
    `;

    const [rep] = await db<{ full_name: string }[]>`SELECT full_name FROM distributor_salespeople WHERE id = ${rep_id}`;
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
  }>("/api/distributor/visits/:id", async (request, reply) => {
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
      select id, visited_at from distributor_visits where id = ${id}
    `;
    if (!current) return reply.code(404).send({ error: "Visit not found." });

    const [saved] = await db`
      update distributor_visits set visited_at = ${new_ts} where id = ${id} returning *
    `;
    await db`
      insert into distributor_visit_audits (visit_id, field, old_value, new_value, changed_by)
      values (${id}, 'visited_at', ${current.visited_at.toISOString()}, ${new_ts.toISOString()}, ${changed_by})
    `;
    return { ok: true, visit: saved };
  });

  // ── Photo upload ─────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/distributor/visits/:id/photos", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1)
      return reply.code(400).send({ error: "Invalid visit id." });

    const [visit] = await db<{ id: number }[]>`select id from distributor_visits where id = ${id}`;
    if (!visit) return reply.code(404).send({ error: "Visit not found." });

    const [countRow] = await db<{ n: string }[]>`
      select count(*)::text as n from distributor_visit_photos where visit_id = ${id}
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
      insert into distributor_visit_photos (visit_id, file_data, mime_type, filename, file_size)
      values (${id}, ${buf}, ${file.mimetype}, ${file.filename ?? null}, ${buf.length})
      returning id, visit_id, mime_type, filename, file_size, created_at
    `;
    if (!photo) return reply.code(500).send({ error: "Insert photo failed." });
    return { ok: true, photo: { ...photo, url: `/api/distributor/photos/${photo.id}` } };
  });

  // ── Serve photo ───────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/distributor/photos/:id", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: "Invalid id." });

    const [photo] = await db<{ file_data: Buffer; mime_type: string }[]>`
      select file_data, mime_type from distributor_visit_photos where id = ${id}
    `;
    if (!photo) return reply.code(404).send({ error: "Photo not found." });

    return reply
      .header("Content-Type", photo.mime_type)
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .send(photo.file_data);
  });

  // ── List photos for a visit ───────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/distributor/visits/:id/photos", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: "Invalid id." });

    const rows = await db`
      select id, visit_id, mime_type, filename, file_size, created_at
      from distributor_visit_photos where visit_id = ${id} order by created_at
    `;
    return { photos: rows.map((r) => ({ ...r, url: `/api/distributor/photos/${r.id}` })) };
  });

  // ── Delete a photo ────────────────────────────────────────────────────────
  app.delete<{ Params: { photoId: string } }>("/api/distributor/photos/:photoId", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const photoId = Number(request.params.photoId);
    if (!Number.isInteger(photoId) || photoId < 1) return reply.code(400).send({ error: "Invalid id." });

    const [deleted] = await db`
      delete from distributor_visit_photos where id = ${photoId} returning id
    `;
    if (!deleted) return reply.code(404).send({ error: "Photo not found." });
    return { ok: true };
  });

  // ── Store name autocomplete ───────────────────────────────────────────────
  app.get<{ Querystring: { q?: string; rep_id?: string } }>("/api/distributor/customers/suggest", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const q = request.query.q ? `%${request.query.q}%` : "%";
    const rep_id = request.query.rep_id ? Number(request.query.rep_id) : null;
    const rows = await db<{
      id: number; store_name: string; category: string; area: string | null;
      account_type: string | null; stage: string | null;
      address: string | null; postal_code: string | null; last_pic_name: string | null;
    }[]>`
      select
        c.id, c.store_name, c.category, c.area,
        c.account_type, c.stage,
        c.address, c.postal_code,
        (
          select v.pic_name
          from distributor_visits v
          where v.customer_id = c.id
            and v.pic_name is not null
          order by v.visited_at desc
          limit 1
        ) as last_pic_name
      from distributor_customers c
      where lower(c.store_name) like lower(${q})
        ${rep_id ? db`and c.owner_id = ${rep_id}` : db``}
      order by c.store_name
      limit 20
    `;
    return { suggestions: rows };
  });
}
