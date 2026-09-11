/**
 * Stok Booking 1.0 — RETIRED, kept as a read-only archive (ST-R14, ST-R15).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS FILE IS NO LONGER THE STOCK MODULE. It is the archive of the one that
 * came before. The live module is `routes/stock-atp.ts`; the spec for all of it
 * is in `docs/stock-2.0/` (read CONTRACTS.md §4 for the HTTP surface, PRD.md §8
 * for why bookings went away).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What 1.0 was: a manual booking ledger. PPIC uploaded an Excel that *became*
 * the inventory, sales placed bookings that deducted from it, and overbookings
 * landed in a PPIC verify queue. It existed only because LeadScout had no link
 * to the ERP. It has one now, so stock consumption follows the Sales Order and
 * the number the app shows is Available-to-Promise, derived per read:
 *
 *     ATP(sku) = on_hand − open_commitment + manual_adjustment
 *
 * What changed here:
 *   - `GET /summary` MOVED to routes/stock-atp.ts. Same URL, ATP-shaped body,
 *     so /stock migrated without a URL break (ST-R15). It is registered there
 *     and NOT here — registering it in both files would shadow one silently.
 *   - Every booking/upload WRITE answers **410 Gone** with a Bahasa message.
 *     Loud failure beats a POST that looks like it worked.
 *   - Every booking/upload READ still works, unchanged, forever: the frozen
 *     history of what was booked before cutover is audit material (ST-R14).
 *
 * The tables stay. `stock_uploads`, `stock_items` and `stock_bookings` are not
 * dropped and `db/migrateStock.ts` still creates them — but nothing in the
 * codebase writes to them any more. If you are adding a write here, you are in
 * the wrong file.
 *
 * Surviving endpoints (all read-only):
 *   GET  /uploads?limit               — upload history, newest first
 *   GET  /uploads/:id                 — one archived period with its bookings
 *   GET  /bookings?status&item_id&rep_key&upload_id — bookings + timer fields
 *   GET  /rep-stats                   — per-sales long-booking tracker (R15)
 *   GET  /items/:id/riwayat           — per-product combined riwayat (R16)
 *
 * Retired (410 Gone):
 *   POST /uploads · /bookings · /bookings/:id/{verify,cancel,complete,fulfill}
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


/** LAMA threshold — a booking is *lama* when its lifetime exceeds this (R14). */
const LONG_THRESHOLD_HOURS = 24;


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
  so_number: string | null;
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
    so_number: b.so_number,
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

export async function stockRoutes(app: FastifyInstance): Promise<void> {
  const dbErr = (reply: import("fastify").FastifyReply) =>
    reply.code(503).send({ error: "Database tidak tersedia." });

  /**
   * ST-R15 retirement. The booking ledger and the Excel ingest are gone; stock
   * consumption now follows the ERP Sales Order. These POSTs answer 410 Gone so
   * an old tab, a bookmarked script or a cached page fails loudly and in Bahasa
   * rather than appearing to succeed. The rows they used to write are kept and
   * still readable below (ST-R14) — frozen, for audit.
   */
  const RETIRED = "Booking sudah tidak digunakan. Stok kini mengikuti Sales Order dari ERP.";
  const gone = (_req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) =>
    reply.code(410).send({ error: RETIRED });

  for (const path of [
    "/api/stock/uploads",
    "/api/stock/bookings",
    "/api/stock/bookings/:id/verify",
    "/api/stock/bookings/:id/cancel",
    "/api/stock/bookings/:id/complete",
    "/api/stock/bookings/:id/fulfill",
  ]) {
    app.post(path, gone);
  }


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
            so_number: b.so_number,
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
