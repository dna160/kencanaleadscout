/**
 * Stok Booking (Simple) — routes (PRD §6). All under /api/stock, JSON in/out.
 *
 * One idea, three moves:
 *   PPIC uploads an Excel  → that file IS the inventory (POST /uploads).
 *   Sales see it and book  → each booking deducts immediately (POST /bookings).
 *   Booking beyond stock   → status='overbooked', lands in PPIC's verify queue.
 *
 * The one derived number, recomputed on every read, NEVER stored (§4):
 *   available (Tersedia) = qty_initial − Σ qty of DEDUCTING bookings.
 *
 * Endpoints:
 *   1  GET  /summary                     — everything the sales page needs in one call
 *   2  POST /uploads                     — new period from parsed Excel JSON (R1, R2, R9)
 *   3  GET  /uploads?limit               — upload history, newest first
 *   4  GET  /uploads/:id                 — one period (active or archived), read-only
 *   5  GET  /bookings?status&item_id&rep_key&upload_id — bookings + timer fields
 *   6  POST /bookings                    — the booking write (R4, R7)
 *   7  POST /bookings/:id/verify         — {action:'approve'|'reject', actor} (R5)
 *   8  POST /bookings/:id/cancel         — {actor} (R6)
 *   9  POST /bookings/:id/complete       — {actor} — PPIC marks Selesai (R12)
 *   10 GET  /rep-stats                   — per-sales long-booking tracker (R15)
 *   11 GET  /items/:id/riwayat           — per-product combined riwayat (R16)
 *
 * Realtime is polling, not SSE (R10) — future upgrade noted, not built here.
 */
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import type { Sql } from "../db/client.js";
import { getSql } from "../db/client.js";

/** The statuses that count against stock. R4/R5/R6/R12 all fall out of this. */
const DEDUCTING = ["confirmed", "overbooked", "approved", "completed"] as const;

/** LAMA threshold — a booking is *lama* when its lifetime exceeds this (R14). */
const LONG_THRESHOLD_HOURS = 24;
const MAX_ROWS = 2000;

/** Typed HTTP error so a rule violation carries its own status + Bahasa message. */
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

/** A porsager transaction handle behaves like the top-level Sql for our queries. */
type Db = Sql | postgres.TransactionSql<Record<string, never>>;

function str(v: unknown): string { return String(v ?? "").trim(); }
function optStr(v: unknown): string | null { const s = str(v); return s || null; }

/**
 * Coerce a possibly-messy numeric (SheetJS may hand us "1.234" id-locale strings,
 * §8.4). Strip thousand separators, accept comma decimals. Returns null when the
 * value isn't a finite number — callers decide whether that's fatal.
 */
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = str(v);
  if (!s) return null;
  const neg = /^-/.test(s);
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  // id-locale (PRD §8.4): dot = thousands separator, comma = decimal. When both
  // appear, the LAST separator is the decimal one. "1.234" → 1234, "1,5" → 1.5.
  if (hasComma && hasDot) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    const parts = s.split(",");
    const after = parts[parts.length - 1]!.length;
    // Multiple commas, or a single comma grouping exactly 3 digits → thousands.
    s = parts.length > 2 || after === 3 ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (hasDot) {
    const parts = s.split(".");
    const after = parts[parts.length - 1]!.length;
    // Multiple dots, or a single dot with exactly 3 trailing digits → id-locale
    // thousands ("1.234" → 1234); otherwise a decimal ("0.35" stays 0.35).
    if (parts.length > 2 || after === 3) s = s.replace(/\./g, "");
  }
  s = s.replace(/[^0-9.]/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** Round to at most 2 dp (R8) without trailing-zero noise. */
function round2(n: number): number { return Math.round(n * 100) / 100; }

/**
 * available for one item, live, inside or outside a transaction. Works with both
 * the pool and a tx handle (§6). Single grouped subtract — never per-row.
 */
async function availableOf(db: Db, itemId: string | number): Promise<number> {
  const [row] = await db<{ available: string | null }[]>`
    select
      i.qty_initial
      - coalesce((
          select sum(b.qty) from stock_bookings b
          where b.item_id = i.id and b.status = any(${DEDUCTING as unknown as string[]})
        ), 0) as available
    from stock_items i
    where i.id = ${itemId}
  `;
  return row ? round2(Number(row.available ?? 0)) : 0;
}

/** The single active upload row, or null when no period has been started yet. */
async function activeUpload(
  db: Db,
): Promise<{ id: string; filename: string | null; sheet_name: string | null; uploaded_by: string | null; note: string | null; created_at: string; row_count: number } | null> {
  const [row] = await db<
    { id: string; filename: string | null; sheet_name: string | null; uploaded_by: string | null; note: string | null; created_at: string; row_count: number }[]
  >`
    select id, filename, sheet_name, uploaded_by, note, created_at, row_count
    from stock_uploads where status = 'active' limit 1
  `;
  return row ?? null;
}

// ── Timer / duration derivation (R13, R14) ─────────────────────────────────────

interface BookingRow {
  id: string;
  upload_id: string;
  item_id: string;
  rep_key: string | null;
  rep_name: string;
  qty: string;
  customer_name: string;
  note: string | null;
  status: string;
  created_at: string;
  verified_by: string | null;
  verified_at: string | null;
  completed_by: string | null;
  completed_at: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  // upload archival stamp, joined in so `hangus` can be derived
  upload_archived_at?: string | null;
}

type Outcome = "selesai" | "dibatalkan" | "ditolak" | "hangus" | "aktif";

interface TimerFields {
  ended_at: string | null;
  outcome: Outcome;
  duration_seconds: number;
  running: boolean;
  long: boolean;
}

/**
 * Derive a booking's timer fields (R13/R14). `ended_at` is the first of:
 *   completed_at · cancelled_at · verified_at (only when rejected) ·
 *   its upload's archived_at (still deducting when the period archived → hangus).
 * No terminal event and the period still active → running, age = now − created_at.
 * Nothing stored; everything computed on read. `now` is passed so a whole list
 * shares one clock.
 */
function timerFor(b: BookingRow, now: number): TimerFields {
  const created = Date.parse(b.created_at);
  let endedAt: string | null = null;
  let outcome: Outcome;

  if (b.status === "completed" && b.completed_at) {
    endedAt = b.completed_at;
    outcome = "selesai";
  } else if (b.status === "cancelled" && b.cancelled_at) {
    endedAt = b.cancelled_at;
    outcome = "dibatalkan";
  } else if (b.status === "rejected" && b.verified_at) {
    endedAt = b.verified_at;
    outcome = "ditolak";
  } else if (b.upload_archived_at) {
    // Period archived while the booking was still deducting → hangus (R13).
    endedAt = b.upload_archived_at;
    outcome = "hangus";
  } else {
    endedAt = null;
    outcome = "aktif";
  }

  const endMs = endedAt ? Date.parse(endedAt) : now;
  const duration_seconds = Math.max(0, Math.round((endMs - created) / 1000));
  const running = endedAt === null;
  const long = duration_seconds > LONG_THRESHOLD_HOURS * 3600;
  return { ended_at: endedAt, outcome, duration_seconds, running, long };
}

/** Attach timer fields to a booking row for the wire (endpoints 4 & 5). */
function withTimer(b: BookingRow, now: number): Record<string, unknown> {
  const t = timerFor(b, now);
  return {
    id: b.id,
    upload_id: b.upload_id,
    item_id: b.item_id,
    rep_key: b.rep_key,
    rep_name: b.rep_name,
    qty: Number(b.qty),
    customer_name: b.customer_name,
    note: b.note,
    status: b.status,
    created_at: b.created_at,
    verified_by: b.verified_by,
    verified_at: b.verified_at,
    completed_by: b.completed_by,
    completed_at: b.completed_at,
    cancelled_by: b.cancelled_by,
    cancelled_at: b.cancelled_at,
    ...t,
  };
}

/** Compose a display name for a structured (primary-map) row (R9/§6.2). */
function composeName(r: {
  warna?: unknown; batch_warna?: unknown; coating?: unknown;
  th?: unknown; mm?: unknown; p?: unknown; l?: unknown;
}): string {
  const warna = str(r.warna);
  const batch = str(r.batch_warna);
  const coating = str(r.coating);
  const th = num(r.th);
  const mm = num(r.mm);
  const p = num(r.p);
  const l = num(r.l);
  const parts: string[] = [];
  if (warna) parts.push(warna);
  if (batch) parts.push(batch);
  // "PVDF 0.3" — coating + thickness together when either is present.
  const coatPart = [coating, th != null ? String(th) : ""].filter(Boolean).join(" ");
  if (coatPart) parts.push(coatPart);
  if (mm != null) parts.push(`${mm}mm`);
  if (p != null && l != null) parts.push(`${p}×${l}`);
  return parts.join(" · ") || warna || "Produk";
}

export async function stockRoutes(app: FastifyInstance): Promise<void> {
  const dbErr = (reply: import("fastify").FastifyReply) =>
    reply.code(503).send({ error: "Database tidak tersedia." });

  // ── 1 · GET /api/stock/summary ─────────────────────────────────────────────
  // Everything the sales page needs in one call. `booked` computed with a single
  // grouped aggregate joined to items — never per-row (§6.1).
  app.get("/api/stock/summary", async (_req, reply) => {
    const db = getSql();
    if (!db) return dbErr(reply);

    const upload = await activeUpload(db);
    if (!upload) {
      return {
        upload: null,
        items: [],
        totals: {
          items: 0, items_available: 0, booked_total: 0,
          confirmed: 0, pending_overbooked: 0, approved: 0, active_long: 0,
        },
      };
    }

    const items = await db<{
      id: string; name: string; product_line: string | null; warna: string | null;
      batch_warna: string | null; coating: string | null; th: string | null; mm: string | null;
      p: string | null; l: string | null; unit: string; qty_initial: string;
      booked: string | null; pending_verifications: number;
    }[]>`
      select
        i.id, i.name, i.product_line, i.warna, i.batch_warna, i.coating,
        i.th, i.mm, i.p, i.l, i.unit, i.qty_initial,
        coalesce(d.booked, 0)  as booked,
        coalesce(pv.pending, 0) as pending_verifications
      from stock_items i
      left join (
        select item_id, sum(qty) as booked
        from stock_bookings
        where upload_id = ${upload.id} and status = any(${DEDUCTING as unknown as string[]})
        group by item_id
      ) d on d.item_id = i.id
      left join (
        select item_id, count(*)::int as pending
        from stock_bookings
        where upload_id = ${upload.id} and status = 'overbooked'
        group by item_id
      ) pv on pv.item_id = i.id
      where i.upload_id = ${upload.id}
      order by i.sort_order asc, i.id asc
    `;

    const shaped = items.map((i) => {
      const qtyInitial = Number(i.qty_initial);
      const booked = Number(i.booked ?? 0);
      const available = round2(qtyInitial - booked);
      const p = i.p != null ? Number(i.p) : null;
      const l = i.l != null ? Number(i.l) : null;
      const available_m2 = p != null && l != null ? round2((available * p * l) / 1e6) : null;
      return {
        id: i.id,
        name: i.name,
        product_line: i.product_line,
        warna: i.warna,
        batch_warna: i.batch_warna,
        coating: i.coating,
        th: i.th != null ? Number(i.th) : null,
        mm: i.mm != null ? Number(i.mm) : null,
        p, l,
        unit: i.unit,
        qty_initial: qtyInitial,
        booked,
        available,
        available_m2,
        overbooked: available < 0,
        pending_verifications: Number(i.pending_verifications ?? 0),
      };
    });

    // Status tallies + running-long count in one pass over the active bookings.
    const statusRows = await db<{ status: string; cnt: number }[]>`
      select status, count(*)::int as cnt
      from stock_bookings where upload_id = ${upload.id}
      group by status
    `;
    const byStatus: Record<string, number> = {};
    for (const r of statusRows) byStatus[r.status] = r.cnt;

    // active_long: running bookings already past 24 jam (R14). Running == still
    // deducting in an active period with no terminal stamp → age from created_at.
    const [longRow] = await db<[{ cnt: number }]>`
      select count(*)::int as cnt
      from stock_bookings
      where upload_id = ${upload.id}
        and status in ('confirmed','overbooked','approved')
        and now() - created_at > make_interval(hours => ${LONG_THRESHOLD_HOURS})
    `;

    const booked_total = shaped.reduce((s, x) => s + x.booked, 0);
    return {
      upload: {
        id: upload.id,
        filename: upload.filename,
        sheet_name: upload.sheet_name,
        uploaded_by: upload.uploaded_by,
        created_at: upload.created_at,
        row_count: upload.row_count,
      },
      items: shaped,
      totals: {
        items: shaped.length,
        items_available: shaped.filter((x) => x.available > 0).length,
        booked_total: round2(booked_total),
        confirmed: byStatus.confirmed ?? 0,
        pending_overbooked: byStatus.overbooked ?? 0,
        approved: byStatus.approved ?? 0,
        active_long: longRow?.cnt ?? 0,
      },
    };
  });

  // ── 2 · POST /api/stock/uploads ────────────────────────────────────────────
  // New period from parsed Excel JSON. Server re-validates — never trusts the
  // client parse (R9). Single transaction: archive current active, insert the
  // new upload + its items. The partial unique index makes two simultaneous
  // uploads safe: the loser gets a 409 (§8.5).
  app.post<{ Body: Record<string, unknown> }>("/api/stock/uploads", async (request, reply) => {
    const db = getSql();
    if (!db) return dbErr(reply);

    const b = request.body ?? {};
    const filename = optStr(b.filename);
    const sheet_name = optStr(b.sheet_name);
    const uploaded_by = optStr(b.uploaded_by);
    const note = optStr(b.note);
    const rawItems = Array.isArray(b.items) ? b.items : [];

    if (rawItems.length === 0)
      return reply.code(400).send({ error: "File tidak berisi baris stok yang valid." });
    if (rawItems.length > MAX_ROWS)
      return reply.code(400).send({ error: "Maksimal 2000 baris." });

    // Re-validate + normalize every row server-side.
    interface CleanItem {
      name: string; product_line: string | null; warna: string | null; batch_warna: string | null;
      coating: string | null; th: number | null; mm: number | null; p: number | null; l: number | null;
      unit: string; qty_initial: number;
    }
    const clean: CleanItem[] = [];
    for (let idx = 0; idx < rawItems.length; idx++) {
      const r = (rawItems[idx] ?? {}) as Record<string, unknown>;
      const isStructured = str(r.warna) !== "" || str(r.brand) !== "" || str(r.product_line) !== "";
      const warna = optStr(r.warna);
      const genericName = optStr(r.name);
      if (!warna && !genericName)
        return reply.code(400).send({ error: `Baris tidak valid: baris ke-${idx + 1} tanpa warna/nama.` });

      const qty = num(r.qty);
      if (qty == null || qty < 0)
        return reply.code(400).send({ error: `Baris tidak valid: qty baris ke-${idx + 1} bukan angka ≥ 0.` });

      if (warna) {
        // Structured (primary-map) row: server composes the display name.
        const th = num(r.th), mm = num(r.mm), p = num(r.p), l = num(r.l);
        const brand = optStr(r.brand) ?? optStr(r.product_line);
        clean.push({
          name: composeName(r),
          product_line: brand,
          warna,
          batch_warna: optStr(r.batch_warna),
          coating: optStr(r.coating),
          th, mm, p, l,
          unit: "lembar",
          qty_initial: round2(qty),
        });
      } else {
        // Generic (fallback-map) row.
        clean.push({
          name: genericName as string,
          product_line: optStr(r.product_line),
          warna: null, batch_warna: null, coating: null,
          th: null, mm: null, p: null, l: null,
          unit: optStr(r.unit) ?? "pcs",
          qty_initial: round2(qty),
        });
      }
    }

    try {
      const result = await db.begin(async (sql) => {
        // Archive the current active period (if any) together with its bookings.
        const [current] = await sql<{ id: string }[]>`
          select id from stock_uploads where status = 'active' for update
        `;
        let archived_upload_id: string | null = null;
        let archived_bookings = 0;
        if (current) {
          await sql`
            update stock_uploads set status = 'archived', archived_at = now()
            where id = ${current.id}
          `;
          const [cnt] = await sql<[{ n: number }]>`
            select count(*)::int as n from stock_bookings
            where upload_id = ${current.id}
              and status in ('confirmed','overbooked','approved','completed')
          `;
          archived_upload_id = current.id;
          archived_bookings = cnt?.n ?? 0;
        }

        const [up] = await sql<{ id: string; created_at: string }[]>`
          insert into stock_uploads (filename, sheet_name, note, uploaded_by, status, row_count)
          values (${filename}, ${sheet_name}, ${note}, ${uploaded_by}, 'active', ${clean.length})
          returning id, created_at
        `;
        if (!up) throw new HttpError(500, "Gagal menyimpan upload.");

        // Bulk-insert items, sort_order = array index (preserves file order).
        for (let i = 0; i < clean.length; i++) {
          const it = clean[i]!;
          await sql`
            insert into stock_items
              (upload_id, name, product_line, warna, batch_warna, coating, th, mm, p, l, unit, qty_initial, sort_order)
            values
              (${up.id}, ${it.name}, ${it.product_line}, ${it.warna}, ${it.batch_warna}, ${it.coating},
               ${it.th}, ${it.mm}, ${it.p}, ${it.l}, ${it.unit}, ${it.qty_initial}, ${i})
          `;
        }

        return {
          upload: {
            id: up.id, filename, sheet_name, uploaded_by,
            created_at: up.created_at, row_count: clean.length,
          },
          archived_upload_id,
          archived_bookings,
        };
      });

      return reply.code(201).send({ ok: true, ...result });
    } catch (err) {
      if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
      // Unique-index violation → a competing upload landed first (§8.5).
      const msg = String((err as Error)?.message ?? "");
      if (msg.includes("stock_uploads_one_active"))
        return reply.code(409).send({ error: "Ada upload lain yang baru saja masuk. Muat ulang." });
      request.log.error({ err }, "stock upload failed");
      return reply.code(500).send({ error: "Gagal menyimpan upload." });
    }
  });

  // ── 3 · GET /api/stock/uploads?limit ───────────────────────────────────────
  app.get<{ Querystring: { limit?: string } }>("/api/stock/uploads", async (request, reply) => {
    const db = getSql();
    if (!db) return dbErr(reply);
    const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 200);
    const rows = await db`
      select id, filename, sheet_name, uploaded_by, note, status, row_count, created_at, archived_at
      from stock_uploads order by created_at desc limit ${limit}
    `;
    return { count: rows.length, uploads: rows };
  });

  // ── 4 · GET /api/stock/uploads/:id ─────────────────────────────────────────
  // One period (active or archived): upload + items with availability + its
  // bookings (with timer fields). Read-only reconciliation view.
  app.get<{ Params: { id: string } }>("/api/stock/uploads/:id", async (request, reply) => {
    const db = getSql();
    if (!db) return dbErr(reply);
    const id = str(request.params.id);
    if (!/^\d+$/.test(id)) return reply.code(400).send({ error: "ID upload tidak valid." });

    const [upload] = await db<{
      id: string; filename: string | null; sheet_name: string | null; uploaded_by: string | null;
      note: string | null; status: string; row_count: number; created_at: string; archived_at: string | null;
    }[]>`
      select id, filename, sheet_name, uploaded_by, note, status, row_count, created_at, archived_at
      from stock_uploads where id = ${id}
    `;
    if (!upload) return reply.code(404).send({ error: "Upload tidak ditemukan." });

    const items = await db<{
      id: string; name: string; product_line: string | null; warna: string | null;
      batch_warna: string | null; coating: string | null; th: string | null; mm: string | null;
      p: string | null; l: string | null; unit: string; qty_initial: string; booked: string | null;
    }[]>`
      select
        i.id, i.name, i.product_line, i.warna, i.batch_warna, i.coating,
        i.th, i.mm, i.p, i.l, i.unit, i.qty_initial,
        coalesce((
          select sum(bk.qty) from stock_bookings bk
          where bk.item_id = i.id and bk.status = any(${DEDUCTING as unknown as string[]})
        ), 0) as booked
      from stock_items i
      where i.upload_id = ${id}
      order by i.sort_order asc, i.id asc
    `;
    const shapedItems = items.map((i) => {
      const available = round2(Number(i.qty_initial) - Number(i.booked ?? 0));
      const p = i.p != null ? Number(i.p) : null;
      const l = i.l != null ? Number(i.l) : null;
      return {
        id: i.id, name: i.name, product_line: i.product_line, warna: i.warna,
        batch_warna: i.batch_warna, coating: i.coating,
        th: i.th != null ? Number(i.th) : null, mm: i.mm != null ? Number(i.mm) : null,
        p, l, unit: i.unit, qty_initial: Number(i.qty_initial),
        booked: Number(i.booked ?? 0), available,
        available_m2: p != null && l != null ? round2((available * p * l) / 1e6) : null,
        overbooked: available < 0,
      };
    });

    const now = Date.now();
    const bookingRows = await db<BookingRow[]>`
      select b.*, u.archived_at as upload_archived_at
      from stock_bookings b
      join stock_uploads u on u.id = b.upload_id
      where b.upload_id = ${id}
      order by b.created_at asc, b.id asc
    `;
    const bookings = bookingRows.map((b) => withTimer(b, now));

    return { upload, items: shapedItems, bookings };
  });

  // ── 5 · GET /api/stock/bookings ────────────────────────────────────────────
  // Active period by default; optional filters. Every row carries timer fields.
  app.get<{ Querystring: { status?: string; item_id?: string; rep_key?: string; upload_id?: string } }>(
    "/api/stock/bookings", async (request, reply) => {
      const db = getSql();
      if (!db) return dbErr(reply);
      const q = request.query;

      let uploadId = optStr(q.upload_id);
      if (!uploadId) {
        const up = await activeUpload(db);
        if (!up) return { count: 0, bookings: [] };
        uploadId = up.id;
      }
      const status = optStr(q.status);
      const itemId = optStr(q.item_id);
      const repKey = optStr(q.rep_key);

      const now = Date.now();
      const rows = await db<BookingRow[]>`
        select b.*, u.archived_at as upload_archived_at
        from stock_bookings b
        join stock_uploads u on u.id = b.upload_id
        where b.upload_id = ${uploadId}
          ${status ? db`and b.status = ${status}` : db``}
          ${itemId ? db`and b.item_id = ${itemId}` : db``}
          ${repKey ? db`and b.rep_key = ${repKey}` : db``}
        order by b.created_at desc, b.id desc
      `;
      return { count: rows.length, bookings: rows.map((b) => withTimer(b, now)) };
    },
  );

  // ── 6 · POST /api/stock/bookings ───────────────────────────────────────────
  // The booking write. Never blocks (R4). Row-locked transaction (R7): lock the
  // item, recompute available inside the tx, decide status, insert.
  app.post<{ Body: Record<string, unknown> }>("/api/stock/bookings", async (request, reply) => {
    const db = getSql();
    if (!db) return dbErr(reply);

    const b = request.body ?? {};
    const item_id = str(b.item_id);
    const rep_key = optStr(b.rep_key);
    const rep_name = optStr(b.rep_name);
    const customer_name = optStr(b.customer_name);
    const note = optStr(b.note);
    const qty = num(b.qty);

    if (!item_id || !/^\d+$/.test(item_id))
      return reply.code(400).send({ error: "Produk tidak valid." });
    if (!rep_name || !customer_name)
      return reply.code(400).send({ error: "Nama sales / customer wajib diisi." });
    if (qty == null || qty <= 0)
      return reply.code(400).send({ error: "Jumlah tidak valid." });

    try {
      const result = await db.begin(async (sql) => {
        // Lock the item row (R7). Two racing bookings serialize here.
        const [item] = await sql<{ id: string; upload_id: string; unit: string }[]>`
          select id, upload_id, unit from stock_items where id = ${item_id} for update
        `;
        if (!item) throw new HttpError(404, "Produk tidak ditemukan.");

        // The item's upload must still be the active period (§8.2).
        const [up] = await sql<{ status: string }[]>`
          select status from stock_uploads where id = ${item.upload_id}
        `;
        if (!up || up.status !== "active")
          throw new HttpError(409, "Data stok baru saja diperbarui. Muat ulang halaman.");

        // Recompute available inside the tx, then decide status (R4).
        const available = await availableOf(sql, item.id);
        const status = qty <= available ? "confirmed" : "overbooked";

        const [booking] = await sql<BookingRow[]>`
          insert into stock_bookings
            (upload_id, item_id, rep_key, rep_name, qty, customer_name, note, status)
          values
            (${item.upload_id}, ${item.id}, ${rep_key}, ${rep_name}, ${round2(qty)},
             ${customer_name}, ${note}, ${status})
          returning *
        `;
        if (!booking) throw new HttpError(500, "Gagal menyimpan booking.");

        const available_after = round2(available - qty);
        return { booking, status, available_after };
      });

      const message = result.status === "overbooked"
        ? "Melebihi stok — masuk antrean verifikasi PPIC."
        : "Booking tersimpan.";
      return reply.code(201).send({
        ok: true,
        booking: { ...result.booking, qty: Number(result.booking.qty) },
        available_after: result.available_after,
        message,
      });
    } catch (err) {
      if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
      request.log.error({ err }, "stock booking failed");
      return reply.code(500).send({ error: "Gagal menyimpan booking." });
    }
  });

  // Shared helper for the three row-locked mutations (verify/cancel/complete).
  // Loads + locks the item so `available_after` is computed consistently (R7).
  async function mutateBooking(
    db: Sql,
    bookingId: string,
    fn: (sql: Db, booking: BookingRow) => Promise<BookingRow>,
  ): Promise<{ booking: BookingRow; available_after: number }> {
    return db.begin(async (sql) => {
      const [booking] = await sql<BookingRow[]>`
        select * from stock_bookings where id = ${bookingId} for update
      `;
      if (!booking) throw new HttpError(404, "Booking tidak ditemukan.");
      // Lock the item row too, so available_after reflects a settled state (R7).
      await sql`select id from stock_items where id = ${booking.item_id} for update`;
      const updated = await fn(sql, booking);
      const available_after = await availableOf(sql, booking.item_id);
      return { booking: updated, available_after };
    });
  }

  // ── 7 · POST /api/stock/bookings/:id/verify ────────────────────────────────
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/stock/bookings/:id/verify", async (request, reply) => {
      const db = getSql();
      if (!db) return dbErr(reply);
      const id = str(request.params.id);
      if (!/^\d+$/.test(id)) return reply.code(400).send({ error: "Booking tidak valid." });

      const action = str(request.body?.action).toLowerCase();
      const actor = optStr(request.body?.actor);
      if (action !== "approve" && action !== "reject")
        return reply.code(400).send({ error: "Aksi harus approve atau reject." });
      if (!actor) return reply.code(400).send({ error: "Nama petugas wajib diisi." });

      try {
        const result = await mutateBooking(db, id, async (sql, booking) => {
          if (booking.status !== "overbooked")
            throw new HttpError(409, "Booking bukan status menunggu verifikasi.");
          const next = action === "approve" ? "approved" : "rejected";
          const [updated] = await sql<BookingRow[]>`
            update stock_bookings
            set status = ${next}, verified_by = ${actor}, verified_at = now()
            where id = ${id} returning *
          `;
          return updated!;
        });
        return { ok: true, booking: { ...result.booking, qty: Number(result.booking.qty) }, available_after: result.available_after };
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
        request.log.error({ err }, "stock verify failed");
        return reply.code(500).send({ error: "Gagal memverifikasi booking." });
      }
    },
  );

  // ── 8 · POST /api/stock/bookings/:id/cancel ────────────────────────────────
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/stock/bookings/:id/cancel", async (request, reply) => {
      const db = getSql();
      if (!db) return dbErr(reply);
      const id = str(request.params.id);
      if (!/^\d+$/.test(id)) return reply.code(400).send({ error: "Booking tidak valid." });

      const actor = optStr(request.body?.actor);
      if (!actor) return reply.code(400).send({ error: "Nama pembatal wajib diisi." });

      try {
        const result = await mutateBooking(db, id, async (sql, booking) => {
          if (!["confirmed", "overbooked", "approved"].includes(booking.status))
            throw new HttpError(409, "Booking sudah selesai / dibatalkan.");
          const [updated] = await sql<BookingRow[]>`
            update stock_bookings
            set status = 'cancelled', cancelled_by = ${actor}, cancelled_at = now()
            where id = ${id} returning *
          `;
          return updated!;
        });
        return { ok: true, booking: { ...result.booking, qty: Number(result.booking.qty) }, available_after: result.available_after };
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
        request.log.error({ err }, "stock cancel failed");
        return reply.code(500).send({ error: "Gagal membatalkan booking." });
      }
    },
  );

  // ── 9 · POST /api/stock/bookings/:id/complete ──────────────────────────────
  // PPIC marks Selesai (R12). Only from confirmed | approved. On overbooked →
  // verify-first 409. completed keeps deducting; terminal.
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/stock/bookings/:id/complete", async (request, reply) => {
      const db = getSql();
      if (!db) return dbErr(reply);
      const id = str(request.params.id);
      if (!/^\d+$/.test(id)) return reply.code(400).send({ error: "Booking tidak valid." });

      const actor = optStr(request.body?.actor);
      if (!actor) return reply.code(400).send({ error: "Nama petugas wajib diisi." });

      try {
        const result = await mutateBooking(db, id, async (sql, booking) => {
          if (booking.status === "overbooked")
            throw new HttpError(409, "Verifikasi dulu (Setujui / Tolak) sebelum tandai selesai.");
          if (!["confirmed", "approved"].includes(booking.status))
            throw new HttpError(409, "Booking sudah selesai / dibatalkan.");
          const [updated] = await sql<BookingRow[]>`
            update stock_bookings
            set status = 'completed', completed_by = ${actor}, completed_at = now()
            where id = ${id} returning *
          `;
          return updated!;
        });
        return { ok: true, booking: { ...result.booking, qty: Number(result.booking.qty) }, available_after: result.available_after };
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
        request.log.error({ err }, "stock complete failed");
        return reply.code(500).send({ error: "Gagal menandai selesai." });
      }
    },
  );

  // ── 10 · GET /api/stock/rep-stats ──────────────────────────────────────────
  // Per-sales long-booking tracker, all uploads, all time (R15). Grouped by
  // rep_key with fallback lower(rep_name) when null. Timer derivation done in
  // JS so the R13 rules (hangus etc.) stay in exactly one place.
  app.get("/api/stock/rep-stats", async (_req, reply) => {
    const db = getSql();
    if (!db) return dbErr(reply);

    const now = Date.now();
    const rows = await db<BookingRow[]>`
      select b.*, u.archived_at as upload_archived_at
      from stock_bookings b
      join stock_uploads u on u.id = b.upload_id
    `;

    interface Agg {
      rep_key: string | null; rep_name: string;
      total: number; long_count: number;
      ended_count: number; ended_seconds: number;
      outcomes: Record<Outcome, number>;
      active_now: number; active_long_now: number;
    }
    const map = new Map<string, Agg>();
    for (const b of rows) {
      const key = b.rep_key ? b.rep_key : `name:${b.rep_name.toLowerCase()}`;
      let a = map.get(key);
      if (!a) {
        a = {
          rep_key: b.rep_key, rep_name: b.rep_name,
          total: 0, long_count: 0, ended_count: 0, ended_seconds: 0,
          outcomes: { selesai: 0, dibatalkan: 0, ditolak: 0, hangus: 0, aktif: 0 },
          active_now: 0, active_long_now: 0,
        };
        map.set(key, a);
      }
      const t = timerFor(b, now);
      a.total++;
      a.outcomes[t.outcome]++;
      if (t.long) a.long_count++;
      if (t.running) {
        a.active_now++;
        if (t.long) a.active_long_now++;
      } else {
        a.ended_count++;
        a.ended_seconds += t.duration_seconds;
      }
    }

    const reps = [...map.values()]
      .map((a) => ({
        rep_key: a.rep_key,
        rep_name: a.rep_name,
        total: a.total,
        long_count: a.long_count,
        long_pct: a.total ? round2((a.long_count / a.total) * 100) : 0,
        avg_duration_hours: a.ended_count ? round2(a.ended_seconds / a.ended_count / 3600) : 0,
        outcomes: a.outcomes,
        active_now: a.active_now,
        active_long_now: a.active_long_now,
      }))
      // R15 sort: lama count desc, then lama % desc.
      .sort((x, y) => y.long_count - x.long_count || y.long_pct - x.long_pct);

    return { threshold_hours: LONG_THRESHOLD_HOURS, reps };
  });

  // ── 11 · GET /api/stock/items/:id/riwayat ──────────────────────────────────
  // Per-product combined riwayat (R16), active or archived. Derived, no tables.
  // Replay the item's period: upload event (stok awal) then every booking in
  // created_at order. `sisa` decreases only for bookings CURRENTLY deducting;
  // cancelled/rejected render reversed with sisa untouched. Final sisa === the
  // item's current available.
  app.get<{ Params: { id: string } }>("/api/stock/items/:id/riwayat", async (request, reply) => {
    const db = getSql();
    if (!db) return dbErr(reply);
    const id = str(request.params.id);
    if (!/^\d+$/.test(id)) return reply.code(400).send({ error: "Produk tidak ditemukan." });

    const [item] = await db<{
      id: string; upload_id: string; name: string; product_line: string | null;
      unit: string; qty_initial: string;
    }[]>`
      select id, upload_id, name, product_line, unit, qty_initial
      from stock_items where id = ${id}
    `;
    if (!item) return reply.code(404).send({ error: "Produk tidak ditemukan." });

    const [upload] = await db<{
      id: string; filename: string | null; status: string; created_at: string; archived_at: string | null;
    }[]>`
      select id, filename, status, created_at, archived_at
      from stock_uploads where id = ${item.upload_id}
    `;

    const now = Date.now();
    const bookingRows = await db<BookingRow[]>`
      select b.*, u.archived_at as upload_archived_at
      from stock_bookings b
      join stock_uploads u on u.id = b.upload_id
      where b.item_id = ${id}
      order by b.created_at asc, b.id asc
    `;

    const qtyInitial = Number(item.qty_initial);
    const events: Record<string, unknown>[] = [{
      type: "upload",
      at: upload?.created_at ?? null,
      qty: qtyInitial,
      sisa: qtyInitial,
    }];

    let sisa = qtyInitial;
    for (const b of bookingRows) {
      const deducting = (DEDUCTING as readonly string[]).includes(b.status);
      const reversed = !deducting; // cancelled | rejected → sisa untouched
      if (deducting) sisa = round2(sisa - Number(b.qty));
      const t = timerFor(b, now);
      events.push({
        type: "booking",
        at: b.created_at,
        sisa,
        reversed,
        booking: {
          id: b.id,
          rep_name: b.rep_name,
          qty: Number(b.qty),
          customer_name: b.customer_name,
          status: b.status,
          outcome: t.outcome,
          duration_seconds: t.duration_seconds,
          running: t.running,
          long: t.long,
          verified_at: b.verified_at,
          completed_at: b.completed_at,
          cancelled_at: b.cancelled_at,
        },
      });
    }

    return {
      item: {
        id: item.id, name: item.name, product_line: item.product_line,
        unit: item.unit, qty_initial: qtyInitial,
      },
      upload: upload
        ? { id: upload.id, filename: upload.filename, status: upload.status, created_at: upload.created_at, archived_at: upload.archived_at }
        : null,
      events,
    };
  });
}
