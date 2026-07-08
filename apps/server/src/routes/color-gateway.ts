/**
 * [E] Color Gateway routes — Module E Custom Color Sample Request.
 *
 * GET   /api/sales-reps                     — active rep roster (reuses salespeople table)
 * POST  /api/color-requests                  — create request (DIAJUKAN)
 * GET   /api/color-requests                  — list with filters + computed is_overdue
 * GET   /api/color-requests/stats            — KPI dashboard
 * GET   /api/color-requests/:id              — detail + event timeline
 * POST  /api/color-requests/:id/route        — PPIC: DIAJUKAN → DIPROSES
 * POST  /api/color-requests/:id/ready        — PPIC: DIPROSES → SIAP
 * POST  /api/color-requests/:id/fulfillment  — Sales: record AMBIL/KIRIM (no status change)
 * POST  /api/color-requests/:id/complete     — PPIC: SIAP → SELESAI
 * POST  /api/color-requests/:id/cancel       — Sales: DIAJUKAN → DIBATALKAN
 * POST  /api/color-requests/:id/reject       — PPIC: DIAJUKAN|DIPROSES → DITOLAK
 */
import type { FastifyInstance } from "fastify";
import { getSql } from "../db/client.js";

class GuardError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = "GuardError";
  }
}

function addWorkingDays(from: Date, days: number): Date {
  const d = new Date(from);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

function addCalendarDays(from: Date, days: number): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function str(v: unknown): string { return String(v ?? "").trim(); }
function optStr(v: unknown): string | null { const s = str(v); return s || null; }
function optInt(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

const VALID_PRODUCT_LINES = new Set(["MACO", "ALCOPAN", "TAJIMA", "SAKURA"]);
const VALID_COATING_TYPES = new Set(["PVDF", "PE"]);
const VALID_COLOR_REFS    = new Set(["KODE_RAL", "NCS", "PANTONE", "SAMPEL_FISIK", "FOTO"]);
const VALID_ROUTES        = new Set(["LOKAL", "INTERNASIONAL"]);
const VALID_FULFILLMENT   = new Set(["AMBIL", "KIRIM"]);

export async function colorGatewayRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /api/sales-reps ────────────────────────────────────────────────────
  app.get("/api/sales-reps", async (_req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });
    const rows = await db`
      select id, full_name, code from salespeople where active = true order by full_name
    `;
    return { sales_reps: rows };
  });

  // ── POST /api/color-requests ───────────────────────────────────────────────
  app.post<{ Body: Record<string, unknown> }>("/api/color-requests", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const b = request.body ?? {};
    const sales_rep_id    = optInt(b.sales_rep_id);
    const customer_name   = str(b.customer_name);
    const project_name    = optStr(b.project_name);
    const product_line    = str(b.product_line).toUpperCase();
    const coating_type    = str(b.coating_type).toUpperCase();
    const color_name      = str(b.color_name);
    const color_code      = optStr(b.color_code);
    const color_reference = str(b.color_reference).toUpperCase();
    const qty_panels      = optInt(b.qty_panels) ?? 1;
    const needed_by       = optStr(b.needed_by);
    const notes           = optStr(b.notes);
    const actor           = optStr(b.actor) ?? customer_name;

    if (!sales_rep_id || sales_rep_id < 1)
      return reply.code(400).send({ error: "sales_rep_id diperlukan." });
    if (!customer_name)
      return reply.code(400).send({ error: "customer_name diperlukan." });
    if (!VALID_PRODUCT_LINES.has(product_line))
      return reply.code(400).send({ error: "product_line tidak valid." });
    if (!VALID_COATING_TYPES.has(coating_type))
      return reply.code(400).send({ error: "coating_type tidak valid." });
    if (!color_name)
      return reply.code(400).send({ error: "color_name diperlukan." });
    if (!VALID_COLOR_REFS.has(color_reference))
      return reply.code(400).send({ error: "color_reference tidak valid." });
    if (qty_panels < 1 || qty_panels > 10)
      return reply.code(400).send({ error: "qty_panels harus 1–10." });

    try {
      const created = await db.begin(async (sql) => {
        const year = new Date().getFullYear();
        const [counter] = await sql<[{ last_no: number }]>`
          insert into color_request_counters (year, last_no) values (${year}, 1)
          on conflict (year) do update set last_no = color_request_counters.last_no + 1
          returning last_no
        `;
        const request_no = `CCR-${year}-${String(counter.last_no).padStart(4, "0")}`;

        const [row] = await sql<[{ id: number }]>`
          insert into color_requests (
            request_no, sales_rep_id, customer_name, project_name,
            product_line, coating_type, color_name, color_code, color_reference,
            qty_panels, needed_by, notes
          ) values (
            ${request_no}, ${sales_rep_id}, ${customer_name}, ${project_name},
            ${product_line}, ${coating_type}, ${color_name}, ${color_code}, ${color_reference},
            ${qty_panels}, ${needed_by}, ${notes}
          ) returning *
        `;

        await sql`
          insert into color_request_events (request_id, from_status, to_status, actor)
          values (${row.id}, null, 'DIAJUKAN', ${actor})
        `;

        return row;
      });
      return reply.code(201).send(created);
    } catch {
      return reply.code(500).send({ error: "Gagal membuat permintaan." });
    }
  });

  // ── GET /api/color-requests/stats — must be before /:id ───────────────────
  app.get("/api/color-requests/stats", async (_req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const [statusRows, overdueRow, turnaroundRows, repRows, lineRows] = await Promise.all([
      db<{ status: string; cnt: number }[]>`
        select status, count(*)::int as cnt from color_requests group by status
      `,
      db<[{ cnt: number }]>`
        select count(*)::int as cnt from color_requests
        where status = 'DIPROSES' and eta_date < current_date
      `,
      db<{ route: string; avg_days: string; cnt: number }[]>`
        select route,
          round(avg(extract(epoch from (fulfilled_at - created_at)) / 86400)::numeric, 1)::text as avg_days,
          count(*)::int as cnt
        from color_requests
        where status = 'SELESAI' and route is not null
          and created_at >= now() - interval '90 days'
        group by route
      `,
      db<{ sales_rep_id: number; full_name: string; cnt: number }[]>`
        select cr.sales_rep_id, sp.full_name, count(*)::int as cnt
        from color_requests cr
        join salespeople sp on sp.id = cr.sales_rep_id
        where cr.created_at >= now() - interval '90 days'
        group by cr.sales_rep_id, sp.full_name
        order by cnt desc
      `,
      db<{ product_line: string; cnt: number }[]>`
        select product_line, count(*)::int as cnt
        from color_requests
        where created_at >= now() - interval '90 days'
        group by product_line order by cnt desc
      `,
    ]);

    const byStatus: Record<string, number> = {};
    for (const r of statusRows) byStatus[r.status] = r.cnt;
    const active = (byStatus.DIAJUKAN ?? 0) + (byStatus.DIPROSES ?? 0) + (byStatus.SIAP ?? 0);

    const turnaround: Record<string, { avg_days: number; cnt: number }> = {};
    for (const r of turnaroundRows) turnaround[r.route] = { avg_days: Number(r.avg_days), cnt: r.cnt };

    return {
      active,
      overdue:                 overdueRow[0]?.cnt ?? 0,
      by_status:               byStatus,
      turnaround_lokal:        turnaround.LOKAL        ?? null,
      turnaround_internasional: turnaround.INTERNASIONAL ?? null,
      rep_volume:              repRows,
      line_volume:             lineRows,
    };
  });

  // ── GET /api/color-requests ────────────────────────────────────────────────
  app.get<{ Querystring: Record<string, string> }>("/api/color-requests", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const q           = request.query;
    const status      = q.status      ? str(q.status).toUpperCase()      : null;
    const rep_id      = q.sales_rep_id ? Number(q.sales_rep_id)           : null;
    const overdue_only = q.overdue === "true";
    const search      = q.q           ? `%${q.q}%`                        : null;
    const limit       = Math.min(Number(q.limit) || 100, 500);
    const offset      = Number(q.offset) || 0;

    const rows = await db`
      select cr.*,
             sp.full_name as sales_rep_name, sp.code as sales_rep_code,
             (cr.status = 'DIPROSES' and cr.eta_date < current_date)::boolean as is_overdue
      from color_requests cr
      join salespeople sp on sp.id = cr.sales_rep_id
      where true
        ${status      ? db`and cr.status = ${status}`                 : db``}
        ${rep_id      ? db`and cr.sales_rep_id = ${rep_id}`           : db``}
        ${overdue_only ? db`and cr.status = 'DIPROSES' and cr.eta_date < current_date` : db``}
        ${search      ? db`and (cr.request_no ilike ${search} or cr.customer_name ilike ${search} or cr.color_name ilike ${search})` : db``}
      order by cr.created_at desc
      limit ${limit} offset ${offset}
    `;
    return { count: rows.length, requests: rows };
  });

  // ── GET /api/color-requests/:id ────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/color-requests/:id", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: "Invalid id." });

    const [row] = await db`
      select cr.*,
             sp.full_name as sales_rep_name, sp.code as sales_rep_code,
             (cr.status = 'DIPROSES' and cr.eta_date < current_date)::boolean as is_overdue
      from color_requests cr
      join salespeople sp on sp.id = cr.sales_rep_id
      where cr.id = ${id}
    `;
    if (!row) return reply.code(404).send({ error: "Tidak ditemukan." });

    const events = await db`
      select * from color_request_events where request_id = ${id} order by created_at asc
    `;
    return { ...row, events };
  });

  // ── POST /api/color-requests/:id/route ────────────────────────────────────
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/color-requests/:id/route", async (request, reply) => {
      const db = getSql();
      if (!db) return reply.code(503).send({ error: "Database not configured." });

      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: "Invalid id." });

      const b = request.body ?? {};
      const route        = str(b.route).toUpperCase();
      const actor        = optStr(b.actor) ?? "PPIC";
      const vendor_name  = optStr(b.vendor_name);
      const routing_note = optStr(b.routing_note);

      if (!VALID_ROUTES.has(route))
        return reply.code(400).send({ error: "route harus LOKAL atau INTERNASIONAL." });

      const eta_raw  = optStr(b.eta_date);
      const eta_date = eta_raw || toDateStr(
        route === "LOKAL" ? addWorkingDays(new Date(), 3) : addCalendarDays(new Date(), 21)
      );

      try {
        const result = await db.begin(async (sql) => {
          const [row] = await sql<{ id: number; status: string }[]>`
            select id, status from color_requests where id = ${id} for update
          `;
          if (!row) throw new GuardError(404, "Tidak ditemukan.");
          if (row.status !== "DIAJUKAN")
            throw new GuardError(409, `Tidak bisa diproses: status saat ini ${row.status}.`);

          const [updated] = await sql`
            update color_requests set
              status = 'DIPROSES', route = ${route}, eta_date = ${eta_date},
              vendor_name = ${vendor_name}, routing_note = ${routing_note},
              routed_at = now(), routed_by = ${actor}, updated_at = now()
            where id = ${id} returning *
          `;
          await sql`
            insert into color_request_events (request_id, from_status, to_status, actor, note)
            values (${id}, 'DIAJUKAN', 'DIPROSES', ${actor}, ${routing_note})
          `;
          return updated;
        });
        return result;
      } catch (err) {
        if (err instanceof GuardError) return reply.code(err.statusCode).send({ error: err.message });
        return reply.code(500).send({ error: "Gagal memproses permintaan." });
      }
    }
  );

  // ── POST /api/color-requests/:id/ready ────────────────────────────────────
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/color-requests/:id/ready", async (request, reply) => {
      const db = getSql();
      if (!db) return reply.code(503).send({ error: "Database not configured." });

      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: "Invalid id." });

      const b = request.body ?? {};
      const actor            = optStr(b.actor) ?? "PPIC";
      const storage_location = optStr(b.storage_location);

      try {
        const result = await db.begin(async (sql) => {
          const [row] = await sql<{ id: number; status: string }[]>`
            select id, status from color_requests where id = ${id} for update
          `;
          if (!row) throw new GuardError(404, "Tidak ditemukan.");
          if (row.status !== "DIPROSES")
            throw new GuardError(409, `Tidak bisa SIAP: status saat ini ${row.status}.`);

          const [updated] = await sql`
            update color_requests set
              status = 'SIAP', ready_at = now(), storage_location = ${storage_location},
              updated_at = now()
            where id = ${id} returning *
          `;
          await sql`
            insert into color_request_events (request_id, from_status, to_status, actor, note)
            values (${id}, 'DIPROSES', 'SIAP', ${actor},
                    ${storage_location ? `Lokasi penyimpanan: ${storage_location}` : null})
          `;
          return updated;
        });
        return result;
      } catch (err) {
        if (err instanceof GuardError) return reply.code(err.statusCode).send({ error: err.message });
        return reply.code(500).send({ error: "Gagal menandai sampel siap." });
      }
    }
  );

  // ── POST /api/color-requests/:id/fulfillment ──────────────────────────────
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/color-requests/:id/fulfillment", async (request, reply) => {
      const db = getSql();
      if (!db) return reply.code(503).send({ error: "Database not configured." });

      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: "Invalid id." });

      const b = request.body ?? {};
      const fulfillment_mode    = str(b.fulfillment_mode).toUpperCase();
      const delivery_recipient  = optStr(b.delivery_recipient);
      const delivery_phone      = optStr(b.delivery_phone);
      const delivery_address    = optStr(b.delivery_address);
      const actor               = optStr(b.actor) ?? "Sales";

      if (!VALID_FULFILLMENT.has(fulfillment_mode))
        return reply.code(400).send({ error: "fulfillment_mode harus AMBIL atau KIRIM." });
      if (fulfillment_mode === "KIRIM") {
        if (!delivery_recipient) return reply.code(400).send({ error: "delivery_recipient diperlukan untuk KIRIM." });
        if (!delivery_phone)     return reply.code(400).send({ error: "delivery_phone diperlukan untuk KIRIM." });
        if (!delivery_address)   return reply.code(400).send({ error: "delivery_address diperlukan untuk KIRIM." });
      }

      try {
        const result = await db.begin(async (sql) => {
          const [row] = await sql<{ id: number; status: string }[]>`
            select id, status from color_requests where id = ${id} for update
          `;
          if (!row) throw new GuardError(404, "Tidak ditemukan.");
          if (row.status !== "SIAP")
            throw new GuardError(409, `Tidak bisa memilih pengambilan: status saat ini ${row.status}.`);

          const [updated] = await sql`
            update color_requests set
              fulfillment_mode = ${fulfillment_mode},
              delivery_recipient = ${delivery_recipient},
              delivery_phone = ${delivery_phone},
              delivery_address = ${delivery_address},
              updated_at = now()
            where id = ${id} returning *
          `;
          const note = fulfillment_mode === "KIRIM"
            ? `KIRIM → ${delivery_recipient} (${delivery_phone}): ${delivery_address}`
            : "Pilih AMBIL sendiri";
          await sql`
            insert into color_request_events (request_id, from_status, to_status, actor, note)
            values (${id}, 'SIAP', 'SIAP', ${actor}, ${note})
          `;
          return updated;
        });
        return result;
      } catch (err) {
        if (err instanceof GuardError) return reply.code(err.statusCode).send({ error: err.message });
        return reply.code(500).send({ error: "Gagal menyimpan pilihan pengambilan." });
      }
    }
  );

  // ── POST /api/color-requests/:id/complete ─────────────────────────────────
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/color-requests/:id/complete", async (request, reply) => {
      const db = getSql();
      if (!db) return reply.code(503).send({ error: "Database not configured." });

      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: "Invalid id." });

      const actor = optStr(request.body?.actor) ?? "PPIC";

      try {
        const result = await db.begin(async (sql) => {
          const [row] = await sql<{ id: number; status: string; fulfillment_mode: string | null }[]>`
            select id, status, fulfillment_mode from color_requests where id = ${id} for update
          `;
          if (!row) throw new GuardError(404, "Tidak ditemukan.");
          if (row.status !== "SIAP")
            throw new GuardError(409, `Tidak bisa selesai: status saat ini ${row.status}.`);
          if (!row.fulfillment_mode)
            throw new GuardError(409, "Menunggu pilihan pengambilan dari Sales.");

          const [updated] = await sql`
            update color_requests set
              status = 'SELESAI', fulfilled_at = now(), updated_at = now()
            where id = ${id} returning *
          `;
          await sql`
            insert into color_request_events (request_id, from_status, to_status, actor)
            values (${id}, 'SIAP', 'SELESAI', ${actor})
          `;
          return updated;
        });
        return result;
      } catch (err) {
        if (err instanceof GuardError) return reply.code(err.statusCode).send({ error: err.message });
        return reply.code(500).send({ error: "Gagal menyelesaikan permintaan." });
      }
    }
  );

  // ── POST /api/color-requests/:id/cancel ───────────────────────────────────
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/color-requests/:id/cancel", async (request, reply) => {
      const db = getSql();
      if (!db) return reply.code(503).send({ error: "Database not configured." });

      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: "Invalid id." });

      const actor = optStr(request.body?.actor) ?? "Sales";

      try {
        const result = await db.begin(async (sql) => {
          const [row] = await sql<{ id: number; status: string }[]>`
            select id, status from color_requests where id = ${id} for update
          `;
          if (!row) throw new GuardError(404, "Tidak ditemukan.");
          if (row.status !== "DIAJUKAN")
            throw new GuardError(409, `Tidak bisa dibatalkan: status saat ini ${row.status}.`);

          const [updated] = await sql`
            update color_requests set
              status = 'DIBATALKAN', cancelled_at = now(), updated_at = now()
            where id = ${id} returning *
          `;
          await sql`
            insert into color_request_events (request_id, from_status, to_status, actor)
            values (${id}, 'DIAJUKAN', 'DIBATALKAN', ${actor})
          `;
          return updated;
        });
        return result;
      } catch (err) {
        if (err instanceof GuardError) return reply.code(err.statusCode).send({ error: err.message });
        return reply.code(500).send({ error: "Gagal membatalkan permintaan." });
      }
    }
  );

  // ── POST /api/color-requests/:id/reject ───────────────────────────────────
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/color-requests/:id/reject", async (request, reply) => {
      const db = getSql();
      if (!db) return reply.code(503).send({ error: "Database not configured." });

      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: "Invalid id." });

      const b = request.body ?? {};
      const actor         = optStr(b.actor) ?? "PPIC";
      const reject_reason = str(b.reject_reason);

      if (!reject_reason)
        return reply.code(400).send({ error: "reject_reason diperlukan." });

      try {
        const result = await db.begin(async (sql) => {
          const [row] = await sql<{ id: number; status: string }[]>`
            select id, status from color_requests where id = ${id} for update
          `;
          if (!row) throw new GuardError(404, "Tidak ditemukan.");
          if (!["DIAJUKAN", "DIPROSES"].includes(row.status))
            throw new GuardError(409, `Tidak bisa ditolak: status saat ini ${row.status}.`);

          const fromStatus = row.status;
          const [updated] = await sql`
            update color_requests set
              status = 'DITOLAK', reject_reason = ${reject_reason}, updated_at = now()
            where id = ${id} returning *
          `;
          await sql`
            insert into color_request_events (request_id, from_status, to_status, actor, note)
            values (${id}, ${fromStatus}, 'DITOLAK', ${actor}, ${reject_reason})
          `;
          return updated;
        });
        return result;
      } catch (err) {
        if (err instanceof GuardError) return reply.code(err.statusCode).send({ error: err.message });
        return reply.code(500).send({ error: "Gagal menolak permintaan." });
      }
    }
  );
}
