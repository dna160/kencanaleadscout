/**
 * Stok Booking (Simple) — routes (PRD §6). All under /api/stock, JSON in/out.
 *
 * One idea, three moves:
 *   PPIC uploads an Excel  → that file IS the inventory (POST /uploads).
 *   Sales see it and book  → each booking deducts immediately (POST /bookings).
 *   Booking beyond stock   → status='overbooked', lands in PPIC's verify queue.
 *
 * The one derived number, recomputed on every read, NEVER stored (§4):
 *   available (Tersedia) = qty_initial − booked(item), where
 *   booked(item) = Σ qty of DEDUCTING bookings whose EFFECTIVE item is `item`.
 *
 * An upload replaces the numbers but never wipes bookings (R1/R2): open ones
 * become 'outstanding' — deducting nowhere — until PPIC presses Penuhi (R17),
 * which re-applies the qty against whatever period is active at that moment.
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
 *   12 POST /bookings/:id/fulfill        — {actor} — PPIC Penuhi on outstanding (R17)
 *
 * Realtime is polling, not SSE (R10) — future upgrade noted, not built here.
 */
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import type { Sql } from "../db/client.js";
import { getSql } from "../db/client.js";

/**
 * The canonical deduction rule (§5), used verbatim by summary, riwayat, and
 * every `available_after`. A booking counts against its EFFECTIVE item:
 *
 *   booked(X) = Σ qty where status = any(DEDUCTING)
 *                     and coalesce(fulfilled_item_id, item_id) = X
 *
 * `fulfilled_item_id` is only ever written together with status='completed'
 * (by Penuhi, R17), so this single form is exactly the PRD's two-branch rule:
 * live statuses match on item_id (their fulfilled_item_id is null), while a
 * completed booking matches on wherever it was actually fulfilled.
 *
 * 'outstanding' is absent by design — a carried booking deducts NOWHERE until
 * PPIC presses Penuhi (R17).
 */
const DEDUCTING = ["confirmed", "overbooked", "approved", "completed"] as const;

/** Statuses that still deduct in their own period — flipped to outstanding on upload (R1). */
const LIVE_ON_UPLOAD = ["confirmed", "overbooked", "approved"] as const;

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
/** bigserial ids arrive as strings from postgres.js — compare them as such (§3.4). */
function eqId(a: unknown, b: unknown): boolean { return a != null && b != null && String(a) === String(b); }

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
          where coalesce(b.fulfilled_item_id, b.item_id) = i.id
            and b.status = any(${DEDUCTING as unknown as string[]})
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
  fulfilled_item_id: string | null;
}

type Outcome = "selesai" | "dibatalkan" | "ditolak" | "aktif" | "outstanding";

interface TimerFields {
  ended_at: string | null;
  outcome: Outcome;
  duration_seconds: number;
  running: boolean;
  long: boolean;
}

/**
 * Derive a booking's timer fields (R13/R14). `ended_at` is the first of:
 *   completed_at · cancelled_at · verified_at (only when rejected).
 * Uploads no longer end a booking — the timer runs straight through stock-check
 * renewals until someone acts, which is what makes a long-outstanding booking
 * the strongest LAMA signal there is (R15). No terminal event → running, with
 * outcome 'aktif' (deducting now) or 'outstanding' (carried, awaiting Penuhi).
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
  } else {
    endedAt = null;
    outcome = b.status === "outstanding" ? "outstanding" : "aktif";
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
    fulfilled_item_id: b.fulfilled_item_id,
    ...t,
  };
}

/**
 * Normalized attribute key used to match a booking's origin item to the active
 * period on Penuhi (R17), and by the upload preview's reconciliation column.
 * Structured rows key on brand+warna+batch+coating+th+mm+p+l; generic rows on
 * name+lini. Mirrors itemKey() in the two pages so both sides agree.
 */
function attrKey(i: {
  product_line?: unknown; warna?: unknown; batch_warna?: unknown; coating?: unknown;
  th?: unknown; mm?: unknown; p?: unknown; l?: unknown; name?: unknown;
}): string {
  const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
  // Numerics are normalized through Number() so "0.30" and 0.3 collide.
  const nrm = (v: unknown) => { const n = num(v); return n == null ? "" : String(n); };
  if (norm(i.warna)) {
    return ["s", norm(i.product_line), norm(i.warna), norm(i.batch_warna), norm(i.coating),
      nrm(i.th), nrm(i.mm), nrm(i.p), nrm(i.l)].join("|");
  }
  return ["g", norm(i.name), norm(i.product_line)].join("|");
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
          confirmed: 0, pending_overbooked: 0, approved: 0, outstanding: 0, active_long: 0,
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
        -- Grouped by EFFECTIVE item, not upload: a booking Penuhi'd out of an
        -- older period deducts from the item it was fulfilled into (R17).
        select coalesce(b.fulfilled_item_id, b.item_id) as eff_item_id, sum(b.qty) as booked
        from stock_bookings b
        where b.status = any(${DEDUCTING as unknown as string[]})
        group by 1
      ) d on d.eff_item_id = i.id
      left join (
        select item_id, count(*)::int as pending
        from stock_bookings
        where status = 'overbooked'
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

    // Status tallies: this period's own bookings, plus every outstanding one —
    // those are carried from older periods and belong to no active upload.
    const statusRows = await db<{ status: string; cnt: number }[]>`
      select status, count(*)::int as cnt
      from stock_bookings
      where upload_id = ${upload.id} or status = 'outstanding'
      group by status
    `;
    const byStatus: Record<string, number> = {};
    for (const r of statusRows) byStatus[r.status] = r.cnt;

    // active_long: running bookings — aktif OR outstanding — past 24 jam (R14).
    // An upload no longer stops a timer, so a long-carried booking counts here.
    const [longRow] = await db<[{ cnt: number }]>`
      select count(*)::int as cnt
      from stock_bookings
      where status in ('confirmed','overbooked','approved','outstanding')
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
        outstanding: byStatus.outstanding ?? 0,
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
        // Archive the current period and CARRY its open bookings (R1/R2): the
        // numbers are replaced, but nothing a rep booked is ever wiped. Live
        // bookings become 'outstanding' — deducting nowhere — until PPIC
        // presses Penuhi (R17). Terminal ones (completed/cancelled/rejected)
        // stay with their period as history.
        const [current] = await sql<{ id: string }[]>`
          select id from stock_uploads where status = 'active' for update
        `;
        let archived_upload_id: string | null = null;
        let carried_outstanding = 0;
        if (current) {
          await sql`
            update stock_uploads set status = 'archived', archived_at = now()
            where id = ${current.id}
          `;
          const carried = await sql`
            update stock_bookings set status = 'outstanding'
            where upload_id = ${current.id}
              and status = any(${LIVE_ON_UPLOAD as unknown as string[]})
          `;
          archived_upload_id = current.id;
          carried_outstanding = carried.count ?? 0;
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
          carried_outstanding,
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
          where coalesce(bk.fulfilled_item_id, bk.item_id) = i.id
            and bk.status = any(${DEDUCTING as unknown as string[]})
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

    // The period's own bookings plus any Penuhi'd INTO it — the latter deduct
    // from these items (R17), so the list matches the availability shown above.
    const now = Date.now();
    const bookingRows = await db<(BookingRow & {
      item_name: string; item_unit: string; item_product_line: string | null;
    })[]>`
      select b.*, i.name as item_name, i.unit as item_unit, i.product_line as item_product_line
      from stock_bookings b
      join stock_items i on i.id = b.item_id
      where b.upload_id = ${id}
         or b.fulfilled_item_id in (select id from stock_items where upload_id = ${id})
      order by b.created_at asc, b.id asc
    `;
    const bookings = bookingRows.map((b) => ({
      ...withTimer(b, now),
      item_name: b.item_name, item_unit: b.item_unit, item_product_line: b.item_product_line,
    }));

    return { upload, items: shapedItems, bookings };
  });

  // ── 5 · GET /api/stock/bookings ────────────────────────────────────────────
  // Default scope = everything relevant NOW (§6.5): the active period's own
  // bookings, every outstanding one (carried from any older period), and any
  // Penuhi'd into the active period. `upload_id` pins a single period instead.
  // Every row carries timer fields.
  app.get<{ Querystring: { status?: string; item_id?: string; rep_key?: string; upload_id?: string } }>(
    "/api/stock/bookings", async (request, reply) => {
      const db = getSql();
      if (!db) return dbErr(reply);
      const q = request.query;

      const pinnedUpload = optStr(q.upload_id);
      let activeId: string | null = null;
      if (!pinnedUpload) {
        const up = await activeUpload(db);
        // No active period: outstanding bookings still exist and must stay visible.
        activeId = up ? up.id : null;
      }
      const status = optStr(q.status);
      const itemId = optStr(q.item_id);
      const repKey = optStr(q.rep_key);

      const scope = pinnedUpload
        ? db`b.upload_id = ${pinnedUpload}`
        : activeId
          ? db`(b.upload_id = ${activeId}
                or b.status = 'outstanding'
                or b.fulfilled_item_id in (select id from stock_items where upload_id = ${activeId}))`
          : db`b.status = 'outstanding'`;

      const now = Date.now();
      // Origin item + period travel with the booking: an outstanding row points
      // at an OLD period's item, which the pages cannot resolve from /summary.
      const rows = await db<(BookingRow & {
        item_name: string; item_unit: string; item_product_line: string | null;
        origin_period: string | null;
        i_warna: string | null; i_batch: string | null; i_coating: string | null;
        i_th: string | null; i_mm: string | null; i_p: string | null; i_l: string | null;
      })[]>`
        select b.*,
               i.name as item_name, i.unit as item_unit, i.product_line as item_product_line,
               i.warna as i_warna, i.batch_warna as i_batch, i.coating as i_coating,
               i.th as i_th, i.mm as i_mm, i.p as i_p, i.l as i_l,
               coalesce(nullif(ou.sheet_name, ''), ou.filename, 'periode ' || ou.id) as origin_period
        from stock_bookings b
        join stock_items i on i.id = b.item_id
        join stock_uploads ou on ou.id = b.upload_id
        where ${scope}
          ${status ? db`and b.status = ${status}` : db``}
          ${itemId ? db`and b.item_id = ${itemId}` : db``}
          ${repKey ? db`and b.rep_key = ${repKey}` : db``}
        order by b.created_at desc, b.id desc
      `;

      // For outstanding rows, resolve the Penuhi target against the CURRENT
      // active period — the same match the fulfill endpoint will run, so the
      // queue shows exactly what pressing the button would do (R17/§8.11).
      const needMatch = rows.some((b) => b.status === "outstanding");
      let activeItems: { id: string; name: string; unit: string; available: number; key: string }[] = [];
      if (needMatch && activeId) {
        const cand = await db<{
          id: string; name: string; unit: string; product_line: string | null; warna: string | null;
          batch_warna: string | null; coating: string | null;
          th: string | null; mm: string | null; p: string | null; l: string | null;
          qty_initial: string; booked: string | null;
        }[]>`
          select i.id, i.name, i.unit, i.product_line, i.warna, i.batch_warna, i.coating,
                 i.th, i.mm, i.p, i.l, i.qty_initial,
                 coalesce((
                   select sum(bk.qty) from stock_bookings bk
                   where coalesce(bk.fulfilled_item_id, bk.item_id) = i.id
                     and bk.status = any(${DEDUCTING as unknown as string[]})
                 ), 0) as booked
          from stock_items i where i.upload_id = ${activeId}
        `;
        activeItems = cand.map((c) => ({
          id: c.id, name: c.name, unit: c.unit,
          available: round2(Number(c.qty_initial) - Number(c.booked ?? 0)),
          key: attrKey(c),
        }));
      }

      const bookings = rows.map((b) => {
        const base = withTimer(b, now) as Record<string, unknown>;
        base.item_name = b.item_name;
        base.item_unit = b.item_unit;
        base.item_product_line = b.item_product_line;
        base.origin_period = b.origin_period;
        if (b.status === "outstanding") {
          const key = attrKey({
            product_line: b.item_product_line, warna: b.i_warna, batch_warna: b.i_batch,
            coating: b.i_coating, th: b.i_th, mm: b.i_mm, p: b.i_p, l: b.i_l, name: b.item_name,
          });
          const m = activeItems.find((c) => c.key === key) ?? null;
          base.match = m ? { item_id: m.id, name: m.name, unit: m.unit, available: m.available } : null;
        }
        return base;
      });
      return { count: bookings.length, bookings };
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
          // Setujui answers the overbook question (R5), so it only applies to an
          // overbooked booking. Tolak is also how PPIC closes a dead OUTSTANDING
          // order (R17) — same terminal state, same verified_by/at stamps.
          if (action === "approve" && booking.status !== "overbooked")
            throw new HttpError(409, "Booking bukan status menunggu verifikasi.");
          if (action === "reject" && !["overbooked", "outstanding"].includes(booking.status))
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
          // Outstanding is cancellable too (R6) — a carried booking whose deal
          // died. Nothing to restore there; it was already deducting nowhere.
          if (!["confirmed", "overbooked", "approved", "outstanding"].includes(booking.status))
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

  // ── 12 · POST /api/stock/bookings/:id/fulfill ──────────────────────────────
  // Penuhi (R17): "this carried order is real — process it against the stock
  // check that is active NOW." Matches the booking's origin item to the active
  // period by normalized attribute key; matched → the qty starts deducting from
  // the current item (may go negative, consistent with R4's never-block rule);
  // unmatched → the product is gone from the new count, so completing it must
  // be an explicit, confirmed no-deduction decision. Matching always runs at
  // execution time, so an upload landing mid-click can never deduct stale stock
  // (§8.10/§8.11).
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/stock/bookings/:id/fulfill", async (request, reply) => {
      const db = getSql();
      if (!db) return dbErr(reply);
      const id = str(request.params.id);
      if (!/^\d+$/.test(id)) return reply.code(400).send({ error: "Booking tidak valid." });

      const actor = optStr(request.body?.actor);
      const confirmNoDeduct = request.body?.confirm_no_deduct === true;
      if (!actor) return reply.code(400).send({ error: "Nama petugas wajib diisi." });

      try {
        const result = await db.begin(async (sql) => {
          const [booking] = await sql<BookingRow[]>`
            select * from stock_bookings where id = ${id} for update
          `;
          if (!booking) throw new HttpError(404, "Booking tidak ditemukan.");
          if (booking.status !== "outstanding")
            throw new HttpError(409, "Booking bukan status outstanding.");

          // Origin item supplies the attribute key to match on.
          const [origin] = await sql<{
            name: string; product_line: string | null; warna: string | null;
            batch_warna: string | null; coating: string | null;
            th: string | null; mm: string | null; p: string | null; l: string | null;
          }[]>`
            select name, product_line, warna, batch_warna, coating, th, mm, p, l
            from stock_items where id = ${booking.item_id}
          `;
          if (!origin) throw new HttpError(404, "Produk asal tidak ditemukan.");
          const key = attrKey(origin);

          // Candidates from whatever period is active right now.
          const candidates = await sql<{
            id: string; name: string; unit: string; product_line: string | null; warna: string | null;
            batch_warna: string | null; coating: string | null;
            th: string | null; mm: string | null; p: string | null; l: string | null;
          }[]>`
            select i.id, i.name, i.unit, i.product_line, i.warna, i.batch_warna, i.coating,
                   i.th, i.mm, i.p, i.l
            from stock_items i
            join stock_uploads u on u.id = i.upload_id and u.status = 'active'
          `;
          const match = candidates.find((c) => attrKey(c) === key) ?? null;

          if (!match) {
            if (!confirmNoDeduct)
              throw new HttpError(409, "Produk tidak ada di stock check aktif. Kirim confirm_no_deduct untuk tandai selesai tanpa potongan.");
            const [updated] = await sql<BookingRow[]>`
              update stock_bookings
              set status = 'completed', completed_by = ${actor}, completed_at = now(),
                  fulfilled_item_id = null
              where id = ${id} returning *
            `;
            return { booking: updated!, matched_item: null, available_after: null as number | null };
          }

          // Lock the target item so available_after settles cleanly (R7/§8.10).
          await sql`select id from stock_items where id = ${match.id} for update`;
          const [updated] = await sql<BookingRow[]>`
            update stock_bookings
            set status = 'completed', completed_by = ${actor}, completed_at = now(),
                fulfilled_item_id = ${match.id}
            where id = ${id} returning *
          `;
          const available_after = await availableOf(sql, match.id);
          return {
            booking: updated!,
            matched_item: { id: match.id, name: match.name, unit: match.unit },
            available_after,
          };
        });

        return {
          ok: true,
          booking: { ...result.booking, qty: Number(result.booking.qty) },
          matched_item: result.matched_item,
          available_after: result.available_after,
        };
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
        request.log.error({ err }, "stock fulfill failed");
        return reply.code(500).send({ error: "Gagal memenuhi booking." });
      }
    },
  );

  // ── 10 · GET /api/stock/rep-stats ──────────────────────────────────────────
  // Per-sales long-booking tracker, all uploads, all time (R15). Grouped by
  // rep_key with fallback lower(rep_name) when null. Timer derivation done in
  // JS so the R13 rules stay in exactly one place. "Open" now splits into
  // aktif + outstanding — a booking carried unfulfilled through several stock
  // checks is the strongest lama signal there is.
  app.get("/api/stock/rep-stats", async (_req, reply) => {
    const db = getSql();
    if (!db) return dbErr(reply);

    const now = Date.now();
    const rows = await db<BookingRow[]>`select b.* from stock_bookings b`;

    interface Agg {
      rep_key: string | null; rep_name: string;
      total: number; long_count: number;
      ended_count: number; ended_seconds: number;
      outcomes: Record<Outcome, number>;
      active_now: number; active_long_now: number;
      outstanding_now: number; outstanding_long_now: number;
    }
    const map = new Map<string, Agg>();
    for (const b of rows) {
      const key = b.rep_key ? b.rep_key : `name:${b.rep_name.toLowerCase()}`;
      let a = map.get(key);
      if (!a) {
        a = {
          rep_key: b.rep_key, rep_name: b.rep_name,
          total: 0, long_count: 0, ended_count: 0, ended_seconds: 0,
          outcomes: { selesai: 0, dibatalkan: 0, ditolak: 0, aktif: 0, outstanding: 0 },
          active_now: 0, active_long_now: 0,
          outstanding_now: 0, outstanding_long_now: 0,
        };
        map.set(key, a);
      }
      const t = timerFor(b, now);
      a.total++;
      a.outcomes[t.outcome]++;
      if (t.long) a.long_count++;
      if (t.running) {
        if (t.outcome === "outstanding") {
          a.outstanding_now++;
          if (t.long) a.outstanding_long_now++;
        } else {
          a.active_now++;
          if (t.long) a.active_long_now++;
        }
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
        outstanding_now: a.outstanding_now,
        outstanding_long_now: a.outstanding_long_now,
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

    // Two families of booking touch this item (R16):
    //   • origin bookings (item_id = X) — booked here, whatever became of them;
    //   • bookings Penuhi'd INTO here from an older period (fulfilled_item_id = X).
    const now = Date.now();
    const bookingRows = await db<(BookingRow & { origin_period: string | null })[]>`
      select b.*,
             coalesce(nullif(ou.sheet_name, ''), ou.filename, 'periode ' || ou.id) as origin_period
      from stock_bookings b
      join stock_uploads ou on ou.id = b.upload_id
      where b.item_id = ${id} or b.fulfilled_item_id = ${id}
      order by b.created_at asc, b.id asc
    `;

    // Where does a Penuhi'd booking's qty actually land? Needed to label an
    // origin row that has since been fulfilled into some other period.
    const movedIds = bookingRows
      .filter((b) => b.fulfilled_item_id && !eqId(b.fulfilled_item_id, id))
      .map((b) => b.fulfilled_item_id as string);
    const movedLabels = new Map<string, string>();
    if (movedIds.length) {
      const rows = await db<{ item_id: string; period: string }[]>`
        select i.id as item_id,
               coalesce(nullif(u.sheet_name, ''), u.filename, 'periode ' || u.id) as period
        from stock_items i join stock_uploads u on u.id = i.upload_id
        where i.id = any(${movedIds})
      `;
      for (const r of rows) movedLabels.set(String(r.item_id), r.period);
    }

    const qtyInitial = Number(item.qty_initial);
    interface Ev { at: string | null; sort: number; ev: Record<string, unknown> }
    const bookingEvents: Ev[] = [];

    for (const b of bookingRows) {
      const t = timerFor(b, now);
      const isOrigin = eqId(b.item_id, id);
      const effHere = eqId(b.fulfilled_item_id ?? b.item_id, id);
      // Currently counting against THIS item per the canonical booked() rule.
      const deducting = (DEDUCTING as readonly string[]).includes(b.status) && effHere;
      const viaPenuhi = !isOrigin && effHere;

      // Markers for an origin row whose qty no longer counts here (R16).
      let moved: string | null = null;
      let movedPeriod: string | null = null;
      if (isOrigin && !deducting) {
        if (b.status === "outstanding") moved = "outstanding";
        else if (b.status === "completed" && b.fulfilled_item_id && !effHere) {
          moved = "fulfilled";
          movedPeriod = movedLabels.get(String(b.fulfilled_item_id)) ?? null;
        }
      }
      // Struck-through only for genuinely dead bookings; carried/moved rows
      // keep their marker instead so the trail stays readable.
      const reversed = isOrigin && (b.status === "cancelled" || b.status === "rejected");

      // A fulfilled-in booking belongs at its completed_at, not its created_at.
      const at = viaPenuhi ? (b.completed_at ?? b.created_at) : b.created_at;
      bookingEvents.push({
        at,
        sort: Date.parse(at ?? b.created_at),
        ev: {
          type: "booking",
          at,
          reversed,
          via_penuhi: viaPenuhi,
          ...(viaPenuhi ? { origin_period: b.origin_period } : {}),
          ...(moved ? { moved, moved_period: movedPeriod } : {}),
          _deducting: deducting,
          _qty: Number(b.qty),
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
        },
      });
    }

    bookingEvents.sort((a, b) => a.sort - b.sort);

    const events: Record<string, unknown>[] = [{
      type: "upload",
      at: upload?.created_at ?? null,
      qty: qtyInitial,
      sisa: qtyInitial,
    }];
    let sisa = qtyInitial;
    for (const { ev } of bookingEvents) {
      if (ev._deducting) sisa = round2(sisa - (ev._qty as number));
      delete ev._deducting; delete ev._qty;
      events.push({ ...ev, sisa });
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
