/**
 * Stock 2.0 — Available-to-Promise engine + routes (WP-3 read, WP-4 write).
 *
 * Everything under /api/stock that is NOT frozen 1.0 archive history lives here.
 * `routes/stock.ts` is now the archive + the 410 tombstones; this file is the
 * live module. See `docs/stock-2.0/CONTRACTS.md` §4 (the frozen HTTP contract)
 * and §7 (the invariants this file is judged against).
 *
 * The one formula (CONTRACTS §0, PRD §3):
 *
 *     ATP(sku) = on_hand(sku) − open_commitment(sku) + manual_adjustment(sku)
 *
 * DERIVED ON EVERY READ, NEVER STORED. There is no `atp` column, no incremental
 * "subtract the new SO" path, and no cache. `loadItems()` below is the entire
 * engine: ONE grouped SQL aggregate over
 *
 *     erp_live_fg          → on_hand        (physical truth, ERP-owned)
 *     v_live_commitments   → committed      (ST-R17 liveness lives in the VIEW)
 *     v_stale_commitments  → stale_committed (quarantined, NOT subtracted)
 *     stock_adjustments    → adjustment     (signed, additive, audited)
 *
 * joined on `sku_key` (erp/sku.ts + erp_sku_key() — invariant §7.4). Never a
 * per-row loop, never N+1: /summary returns every SKU from one round trip.
 *
 * Three rules that are easy to break and expensive to break:
 *   §7.3  The liveness predicate is spelled ONCE, in v_live_commitments. This
 *         file never re-spells `approval = 'Approved' and estimate_delivery >=
 *         current_date - N and ...`. It only ever selects FROM the views.
 *   §7.5  ATP may be negative — that is the production signal (ST-R4). Nothing
 *         here clamps it, and there is no greatest(0, …) anywhere.
 *   §7.2  No route writes an erp_* table. The only writes below are to
 *         stock_adjustments and stock_commitment_overrides, both LeadScout-owned.
 *
 * AMENDMENT 1: an approved line with `estimate_delivery is null` is LIVE and
 * reserves stock. Every commitment this file returns carries `undated`, and
 * /stale-commitments accepts `segment=undated` so PPIC can triage those lines
 * next to the genuinely stale ones.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Sql } from "../db/client.js";
import { getSql } from "../db/client.js";
import { config, hasErp } from "../config.js";

/** Canonical unit for ATP maths in v1 (A4, ST-R5.4). qty_m2 is display only. */
const UNIT = "lembar";

/** Hard server-side cap on any paginated list — a client may not ask for 4,000. */
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

/** Cap on one bulk confirm-close. An explicit id list, never a filter (ST-R21). */
const MAX_BATCH_CLOSE = 200;

/** mm² → m². Used only when a SKU has no FG rows to take a real ratio from. */
const MM2_PER_M2 = 1_000_000;

// ── small shared helpers (house style: routes/stock.ts) ───────────────────────

const dbErr = (reply: FastifyReply) => reply.code(503).send({ error: "Database tidak tersedia." });

function str(v: unknown): string {
  return String(v ?? "").trim();
}
function optStr(v: unknown): string | null {
  const s = str(v);
  return s || null;
}
/** Round to at most 2 dp without trailing-zero noise (same rule as 1.0's round2). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
/** postgres.js hands numerics back as strings; absent/NaN reads as 0 for a sum. */
function numOf(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
/**
 * timestamptz → ISO-8601 on the wire. postgres.js returns a Date for timestamptz;
 * `date` columns are cast to text in SQL instead, so an ETA stays "2020-08-27"
 * and never drifts a day across a timezone boundary.
 */
function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

/** `?page=&limit=` with a server-side cap (never trust the client's page size). */
function pageParams(q: { page?: string; limit?: string; offset?: string }): {
  page: number;
  limit: number;
  offset: number;
} {
  // FLOOR BOTH. `limit`/`offset` are interpolated into `limit $n offset $n`,
  // where Postgres wants a bigint: `?limit=10.5` is `22P02 invalid input syntax
  // for type bigint`, i.e. a 500 from a query string. `?page=1.2` was the same
  // fault one step removed — the fraction survived into `(page - 1) * limit` and
  // produced "9.999999999999998". A fractional page is nonsense, not an error
  // worth a 500, so it is floored at the edge like every other numeric param.
  const limit = Math.floor(Math.min(Math.max(Number(q.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT));
  const page = Math.floor(Math.max(Number(q.page) || 1, 1));
  const explicitOffset = Number(q.offset);
  const offset = Number.isFinite(explicitOffset) && explicitOffset >= 0
    ? Math.floor(explicitOffset)
    : (page - 1) * limit;
  return { page, limit, offset };
}

/**
 * `?min_age_days=` → a whole number of days, or nothing.
 *
 * The value is interpolated as `current_date - $1::int`, so Postgres needs a
 * literal integer: `1.5` is `22P02 invalid input syntax for type integer`, i.e.
 * a 500 from a query string. Flooring is also what the slider means — "older
 * than 1.5 days" is "older than 1 day" — so a fraction is rounded down rather
 * than rejected. Zero and negatives disable the filter (every row is at least
 * 0 days old, so they only ever meant "no filter").
 */
function safeMinAgeDays(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  const days = Math.floor(raw);
  return days > 0 ? days : null;
}

/** Query-string booleans arrive as text — `only_do=true` from the PPIC page. */
function isTruthy(v: unknown): boolean {
  if (v === true) return true;
  const s = str(v).toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

/** Free-text `?q=` → an ILIKE needle. Wildcards in user input are escaped. */
function likeNeedle(raw: string): string {
  return `%${raw.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

// ── wire types — two front-end agents compile against these ───────────────────

export type SkuState = "tersedia" | "habis" | "kosong" | "perlu_produksi";

/** The item object in /summary.items[], /sku/:sku_key.item and /shortfall.items[]. */
export interface SkuItem {
  sku_key: string;
  name: string;
  /** FG-side display code. NULL for a SKU we hold no stock of — tbl_1203 has none. */
  kode_barang: string | null;
  /** Product line id, and its `_text` display twin. Part of the key. */
  brand: string | null;
  brand_text: string | null;
  /** Colour ID (matching is by id) … */
  warna: string | null;
  /** … and the name it resolves to — `warna_text`, else the tbl_1228 master. */
  warna_name: string | null;
  /** Aluminium skin thickness. Unchanged meaning: FG `th` / SO `th_alu_skin`. */
  th: number | null;
  /** Total panel thickness. FG `t` / SO `total_thickness_acp`. */
  th_panel: number | null;
  p: number | null;
  l: number | null;
  unit: string;
  on_hand: number;
  committed: number;
  adjustment: number;
  atp: number;
  atp_m2: number | null;
  state: SkuState;
  stale_committed: number;
  nearest_eta: string | null;
}

/** One SO line, as returned by /sku/:sku_key, /stale-commitments and /exceptions. */
export interface CommitLine {
  so_line_id: string;
  sku_key: string;
  name: string;
  /** No `kode_barang`: tbl_1203 has no such column (verified 2026-09-11). */
  brand: string | null;
  brand_text: string | null;
  warna: string | null;
  warna_name: string | null;
  th: number | null;
  th_panel: number | null;
  p: number | null;
  l: number | null;
  so_id: string | null;
  so_number: string | null;
  customer_name_text: string | null;
  sales_name_text: string | null;
  qty_order: number | null;
  qty_delivered: number | null;
  qty_balance: number;
  status_order: string | null;
  approval: string | null;
  estimate_delivery: string | null;
  /**
   * AMENDMENT 12 — the SO's order date, from the header. An undated line has no
   * ETA to age from, so this is the only way to show how old it is, on exactly
   * the population that reserves stock. 'YYYY-MM-DD'.
   */
  po_date: string | null;
  /** AMENDMENT 1 — approved, undelivered, nobody scheduled it. Still reserves. */
  undated: boolean;
  /** Days past ETA; null when undated. Negative when the ETA is in the future. */
  age_days: number | null;
  /** 'live' reserves stock · 'stale' is quarantined · 'closed' was confirm-closed. */
  state: "live" | "stale" | "closed";
  /** True when this SKU has no erp_live_fg row at all (ST-R5.3 exception). */
  unmatched: boolean;
  override: CommitOverride | null;
}

export interface CommitOverride {
  so_line_id: string;
  state: string;
  reason: string | null;
  actor: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface Freshness {
  last_ok_at: string | null;
  stale: boolean;
  erp_connected: boolean;
  /**
   * FIX D — false ONLY when the last sync attempt failed authentication
   * (HTTP 401/403); true otherwise, including when nothing has ever synced.
   *
   * It exists so a page can tell "wait, the ERP is unreachable" from "call IT,
   * the credentials were rejected" — the likeliest first-run outcome, and the
   * one where waiting is exactly the wrong advice because the fix is an admin
   * action. Previously the only way to know was to grep `last_error` for
   * /HTTP 401/, which silently stops working the day somebody rewords it.
   */
  erp_authorized: boolean;
}

/** Mirrors `SelarasFailureKind` in erp/selarasClient.ts; stored per table. */
export type SyncErrorKind = "auth" | "network" | "shape" | "erp_error" | "server" | "other";

export interface SummaryTotals {
  skus: number;
  tersedia: number;
  habis: number;
  kosong: number;
  perlu_produksi: number;
  stale_commitments: number;
  /**
   * AMENDMENT 12. Count of LIVE commitment lines with no `estimate_delivery`
   * (AMENDMENT 1) — the review tab's second segment. It is here because without
   * it the page cannot label that segment and fired a throwaway
   * `segment=undated&limit=1` probe purely to count it. Lines, not quantity, so
   * it reads the same way as `stale_commitments` beside it.
   */
  undated_commitments: number;
  /** ST-R5.3 unmatched demand, counted in SO LINES. */
  exceptions: number;
  /**
   * FIX E — the same unmatched demand counted in distinct SKUs, so it can be
   * compared against `skus` without inflating the share. Several lines routinely
   * share one SKU, so `exceptions / skus` overstates the problem (a realistic
   * population measured 512%); `exception_skus / skus` is a true fraction, which
   * is what an alarm threshold should be set against.
   */
  exception_skus: number;
}

export interface SummaryResponse {
  freshness: Freshness;
  totals: SummaryTotals;
  items: SkuItem[];
}

export interface AdjustmentRow {
  id: string;
  sku_key: string;
  name: string;
  qty_delta: number;
  reason: string;
  actor: string;
  created_at: string | null;
}

export interface OnHandRow {
  /** The ERP's roll serial — what PPIC reads off the panel. May be absent. */
  sn_fg: string | null;
  /** The mirror's primary key for the row (`tbl_1210_STLiveFGMX_id`). */
  erp_row_id: string;
  lokasi: string | null;
  qty: number;
  qty_m2: number | null;
  buffer_qty: number | null;
  buffer_status: string | null;
  erp_updated_at: string | null;
}

export interface SkuDetailResponse {
  item: SkuItem;
  live_commitments: CommitLine[];
  stale_commitments: CommitLine[];
  adjustments: AdjustmentRow[];
  on_hand_rows: OnHandRow[];
}

/**
 * The list envelope, AMENDMENT 8. `rows` is the ratified key; `items` is emitted
 * beside it as a byte-identical alias because both shipped front-end packages
 * read it and the duplicate costs one property. New clients read `rows`.
 *
 * `total` is the count matching the operator's filters (it drives the pager);
 * `grand_total` is the same list with the filters removed, so the UI can say
 * "filtered from 4,158" instead of falling back to a vaguer count line.
 */
export interface PagedResponse<T> {
  rows: T[];
  /** @deprecated alias of `rows` — kept for the shipped pages. */
  items: T[];
  total: number;
  grand_total: number;
  page: number;
  limit: number;
  has_more: boolean;
}

/** Response of POST /stale-commitments/:id/close and /reinstate. */
export interface OverrideResponse {
  ok: true;
  so_line_id: string;
  sku_key: string;
  /** Signed, MEASURED (not predicted) change this action made to ATP(sku_key). */
  atp_delta: number;
  atp_before: number;
  atp_after: number;
  override: CommitOverride;
  commitment: CommitLine | null;
}

/** Response of POST /stale-commitments/close-batch. */
export interface BatchCloseResponse {
  ok: true;
  closed: number;
  skipped: { so_line_id: string; reason: string }[];
  atp_delta_by_sku: Record<string, number>;
}

export interface SyncTableStatus {
  table_name: string;
  cursor_value: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  /** Why the last attempt failed, as a value rather than a sentence (FIX D). */
  last_error_kind: SyncErrorKind | null;
  last_error_at: string | null;
  rows_synced: number;
  running: boolean;
}

export interface SyncStatusResponse {
  freshness: Freshness;
  running: boolean;
  interval_ms: number;
  stale_after_ms: number;
  tables: SyncTableStatus[];
}

// ── the ATP engine ────────────────────────────────────────────────────────────

/** Raw shape of one row of the grouped aggregate. numerics arrive as strings. */
interface AggregateRow {
  sku_key: string;
  kode_barang: string | null;
  brand: string | null;
  brand_text: string | null;
  warna: string | null;
  warna_name: string | null;
  th: string | null;
  th_panel: string | null;
  p: string | null;
  l: string | null;
  on_hand: string | null;
  on_hand_m2: string | null;
  stock_rows: string | null;
  committed: string | null;
  live_lines: string | null;
  undated_lines: string | null;
  nearest_eta: string | null;
  stale_committed: string | null;
  stale_lines: string | null;
  adjustment: string | null;
}

/** An SkuItem plus the counters /summary's totals and /exceptions need. */
interface EngineItem extends SkuItem {
  stock_rows: number;
  live_lines: number;
  undated_lines: number;
  stale_lines: number;
}

/**
 * FIX 7 — resolve a colour ID to its name through the mirrored master
 * `erp_warna` (`tbl_1228_DBRMWarnaID`, 273 rows: `warna = 4` → "BLACK GALAXY").
 *
 * A LATERAL with `limit 1`, never a plain join: two master rows could match one
 * code ('4' and '04'), and a join that fans out would duplicate stock rows and
 * double-count ATP. The exact id match is preferred over the numeric one, and
 * `erp_num_or_null()` (migrateErpStock.ts) does the numeric comparison without
 * ever casting a non-numeric string — a bare `::numeric` here would 22P02 on the
 * first colour code that is not a number.
 *
 * `alias` is the source relation carrying `warna`; it is a literal from this
 * file, never anything a request supplies. The join publishes `wn.rm_warna`.
 */
function warnaName(db: Sql, alias: "i" | "c" | "a") {
  const col = alias === "i" ? db`i.warna` : alias === "c" ? db`c.warna` : db`a.warna`;
  return db`
    left join lateral (
      select w.rm_warna
      from erp_warna w
      where w.id = ${col}
         or (w.code_num is not null and w.code_num = erp_num_or_null(${col}))
      order by (w.id = ${col}) desc nulls last
      limit 1
    ) wn on true
  `;
}

/** Everything the display name is built from. Codes on the left, names preferred. */
interface NameParts {
  kode_barang?: string | null;
  brand: string | null;
  brand_text: string | null;
  warna: string | null;
  warna_name: string | null;
  th: number | null;
  th_panel: number | null;
  p: number | null;
  l: number | null;
}

/**
 * Display name, composed deterministically from the identity columns in the same
 * idiom the 1.0 page used (` · ` between groups, `×` between dimensions):
 *   "ACP 4 BLACK GALAXY 0.3 · 4880×1220"
 *
 * FIX 7 — `brand` and `warna` are IDs, not names: `warna = 4` is "BLACK GALAXY"
 * in `tbl_1228_DBRMWarnaID`. Rendering the raw code shows a user "4". So the
 * resolved name wins wherever one exists (`_text` twin first, then the colour
 * master), and the code is only the fallback — never nothing.
 *
 * Falls back to the sku_key so a row is never nameless.
 */
function composeName(parts: NameParts, skuKey: string): string {
  const brand = parts.brand_text ?? parts.brand ?? parts.kode_barang ?? null;
  const warna = parts.warna_name ?? parts.warna ?? null;
  const head = [
    brand,
    warna,
    parts.th_panel != null ? String(parts.th_panel) : null,
    parts.th != null ? String(parts.th) : null,
  ]
    .filter((v) => v !== null && v !== "")
    .join(" ");
  const dims = parts.p != null && parts.l != null ? `${parts.p}×${parts.l}` : "";
  const name = [head, dims].filter((v) => v !== "").join(" · ");
  return name || skuKey;
}

/**
 * ST-R10 state, derived server-side exactly once. The front end renders what it
 * is sent and never recomputes this.
 *
 * AMENDMENT 10 — `perlu_produksi` is tested FIRST, ahead of `kosong`. CONTRACTS
 * §4.1 originally listed `kosong` first, which shadowed it: a SKU with no stock
 * and 120 lembar of demand (atp −120) read as *Kosong* — "nothing here" — when
 * PRD ST-R5.3 and ST-R10 both say unmatched demand must read *Perlu Produksi*.
 * The distinction is the whole point of surfacing negative ATP: `kosong` is an
 * absence nobody is waiting on, `perlu_produksi` is an absence somebody has
 * already ordered against. Only a SKU with neither stock nor demand is `kosong`.
 */
function deriveState(onHand: number, adjustment: number, atp: number): SkuState {
  const effectiveOnHand = onHand + adjustment;
  if (atp < 0) return "perlu_produksi";
  if (effectiveOnHand <= 0) return "kosong";
  // `habis` tests EFFECTIVE on-hand, not the raw mirror figure. An opname
  // adjustment is a correction to physical truth — it says the stock really is
  // there — so `on_hand 0, adjustment +5, committed 5` is stock that exists and
  // is entirely promised, which is precisely what habis means. Testing raw
  // `on_hand > 0` here left that case matching no row of the ladder at all.
  if (atp <= 0) return "habis";
  // Total by construction: past the two guards above, effective stock is
  // positive and atp is not negative, so atp is either 0 (habis) or positive.
  return "tersedia";
}

/**
 * THE ENGINE. One grouped aggregate, one round trip, every SKU (CONTRACTS §4.1,
 * WP-3 done-criterion). Four independent GROUP BYs are unioned on their keys and
 * left-joined, so a SKU that exists on only one axis still appears:
 *   - stock with no demand      → tersedia
 *   - demand with no stock      → ATP negative (ST-R5.3: never silently dropped)
 *   - an adjustment alone       → the opname correction is visible immediately
 *
 * `committed` comes from v_live_commitments and ONLY from there; the stale sum
 * is carried beside it as context and is never subtracted (§5A, ST-R17).
 */
async function loadItems(
  db: Sql,
  skuKey?: string | readonly string[] | null,
): Promise<EngineItem[]> {
  // One parameterized filter, reused in each CTE so a single-SKU read touches
  // only that SKU's rows. Empty fragment = no filter (postgres.js dynamic where).
  const f =
    skuKey == null || skuKey === "" ? db``
    : Array.isArray(skuKey) ? db`where sku_key = any(${skuKey as string[]})`
    : db`where sku_key = ${skuKey as string}`;

  const rows = await db<AggregateRow[]>`
    with fg as (
      select sku_key,
             sum(qty)                     as on_hand,
             sum(coalesce(qty_m2, 0))     as on_hand_m2,
             count(*)                     as stock_rows
      from erp_live_fg ${f}
      group by sku_key
    ),
    live as (
      -- ST-R17 liveness lives in the view, not here (§7.3).
      select sku_key,
             sum(qty_balance)                                       as committed,
             count(*)                                               as live_lines,
             count(*) filter (where estimate_delivery is null)      as undated_lines,
             to_char(min(estimate_delivery), 'YYYY-MM-DD')          as nearest_eta
      from v_live_commitments ${f}
      group by sku_key
    ),
    stale as (
      select sku_key,
             sum(qty_balance) as stale_committed,
             count(*)         as stale_lines
      from v_stale_commitments ${f}
      group by sku_key
    ),
    adj as (
      select sku_key, sum(qty_delta) as adjustment
      from stock_adjustments ${f}
      group by sku_key
    ),
    -- Identity columns: prefer the FG row (physical truth), fall back to the SO
    -- line so demand for a SKU we hold no stock of still renders with a name.
    -- kode_barang exists only on the FG side (tbl_1203 has no such column), so
    -- the demand arm contributes a NULL for it and the brand carries the name.
    ident_src as (
      select sku_key, 1 as pri, min(kode_barang) as kode_barang,
             min(brand) as brand, min(brand_text) as brand_text,
             min(warna) as warna, min(warna_text) as warna_text,
             min(th) as th, min(th_panel) as th_panel, min(p) as p, min(l) as l
      from erp_live_fg ${f} group by sku_key
      union all
      select sku_key, 2 as pri, null::text as kode_barang,
             min(brand) as brand, min(brand_text) as brand_text,
             min(warna) as warna, min(warna_text) as warna_text,
             min(th) as th, min(th_panel) as th_panel, min(p) as p, min(l) as l
      from erp_so_line ${f} group by sku_key
    ),
    ident as (
      select distinct on (sku_key) sku_key, kode_barang, brand, brand_text,
             warna, warna_text, th, th_panel, p, l
      from ident_src order by sku_key, pri
    ),
    keys as (
      select sku_key from fg
      union select sku_key from live
      union select sku_key from stale
      union select sku_key from adj
    )
    select k.sku_key,
           i.kode_barang,
           i.brand,
           i.brand_text,
           i.warna,
           -- FIX 7: warna is an id into tbl_1228_DBRMWarnaID, so a user would
           -- otherwise read "4" instead of "BLACK GALAXY". The _text twin wins
           -- when the ERP sends one; the mirrored master is the fallback.
           coalesce(i.warna_text, wn.rm_warna) as warna_name,
           i.th::text       as th,
           i.th_panel::text as th_panel,
           i.p::text   as p,
           i.l::text   as l,
           coalesce(fg.on_hand, 0)::text          as on_hand,
           coalesce(fg.on_hand_m2, 0)::text       as on_hand_m2,
           coalesce(fg.stock_rows, 0)::text       as stock_rows,
           coalesce(live.committed, 0)::text      as committed,
           coalesce(live.live_lines, 0)::text     as live_lines,
           coalesce(live.undated_lines, 0)::text  as undated_lines,
           live.nearest_eta                       as nearest_eta,
           coalesce(stale.stale_committed, 0)::text as stale_committed,
           coalesce(stale.stale_lines, 0)::text   as stale_lines,
           coalesce(adj.adjustment, 0)::text      as adjustment
    from keys k
    left join ident i    on i.sku_key    = k.sku_key
    ${warnaName(db, "i")}
    left join fg         on fg.sku_key    = k.sku_key
    left join live       on live.sku_key  = k.sku_key
    left join stale      on stale.sku_key = k.sku_key
    left join adj        on adj.sku_key   = k.sku_key
    order by k.sku_key
  `;

  return rows.map((r) => {
    const th = numOrNull(r.th);
    const th_panel = numOrNull(r.th_panel);
    const p = numOrNull(r.p);
    const l = numOrNull(r.l);
    const on_hand = round2(numOf(r.on_hand));
    const on_hand_m2 = numOf(r.on_hand_m2);
    const committed = round2(numOf(r.committed));
    const adjustment = round2(numOf(r.adjustment));

    // The formula. No clamp, no greatest(0, …) — a negative ATP is the point.
    const atp = round2(on_hand - committed + adjustment);

    // m² is display-only (A4). Prefer the real ERP ratio; fall back to the
    // nominal panel area when we hold no stock to take a ratio from.
    const m2PerUnit = on_hand > 0 && on_hand_m2 > 0
      ? on_hand_m2 / on_hand
      : p != null && l != null && p > 0 && l > 0
        ? (p * l) / MM2_PER_M2
        : null;

    const identity = {
      kode_barang: r.kode_barang,
      brand: r.brand,
      brand_text: r.brand_text,
      warna: r.warna,
      warna_name: r.warna_name,
      th,
      th_panel,
      p,
      l,
    };

    return {
      sku_key: r.sku_key,
      name: composeName(identity, r.sku_key),
      ...identity,
      unit: UNIT,
      on_hand,
      committed,
      adjustment,
      atp,
      atp_m2: m2PerUnit != null ? round2(atp * m2PerUnit) : null,
      state: deriveState(on_hand, adjustment, atp),
      stale_committed: round2(numOf(r.stale_committed)),
      nearest_eta: r.nearest_eta,
      stock_rows: numOf(r.stock_rows),
      live_lines: numOf(r.live_lines),
      undated_lines: numOf(r.undated_lines),
      stale_lines: numOf(r.stale_lines),
    };
  });
}

/** sku_key → ATP, for measuring what a write actually did to the number. */
function atpBySku(items: readonly EngineItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[it.sku_key] = it.atp;
  return out;
}

/** Strip the engine's internal counters — /summary.items[] is exactly §4.1. */
function toWire(it: EngineItem): SkuItem {
  return {
    sku_key: it.sku_key,
    name: it.name,
    kode_barang: it.kode_barang,
    brand: it.brand,
    brand_text: it.brand_text,
    warna: it.warna,
    warna_name: it.warna_name,
    th: it.th,
    th_panel: it.th_panel,
    p: it.p,
    l: it.l,
    unit: it.unit,
    on_hand: it.on_hand,
    committed: it.committed,
    adjustment: it.adjustment,
    atp: it.atp,
    atp_m2: it.atp_m2,
    state: it.state,
    stale_committed: it.stale_committed,
    nearest_eta: it.nearest_eta,
  };
}

// ── freshness (ST-R7) ─────────────────────────────────────────────────────────

interface SyncStateRow {
  table_name: string;
  cursor_value: Date | string | null;
  last_ok_at: Date | string | null;
  last_error: string | null;
  last_error_kind: string | null;
  last_error_at: Date | string | null;
  rows_synced: string | null;
  running: boolean;
}

async function loadSyncState(db: Sql): Promise<SyncStateRow[]> {
  return db<SyncStateRow[]>`
    select table_name, cursor_value, last_ok_at, last_error, last_error_kind,
           last_error_at, rows_synced, running
    from erp_sync_state
    order by case table_name
               when 'so_header' then 1 when 'so_line' then 2 when 'live_fg' then 3 else 4
             end, table_name
  `;
}

/** How long without a successful sync before the amber banner lights (ST-R7). */
function staleAfterMs(): number {
  return config.stock.syncIntervalMs * config.stock.syncStaleAlertIntervals;
}

/**
 * `last_ok_at` is the most recent success across the mirrored tables — that is
 * the "Data ERP per 14:05" the header shows. `stale` is only ever true when the
 * ERP is actually configured: with SELARAS_BASE_URL unset the page renders the
 * "ERP tidak terhubung" box instead, and UX-SPEC §4 forbids showing both.
 */
/** Whitelist the stored kind: it reaches a response, so it is never free text. */
const SYNC_ERROR_KINDS: readonly SyncErrorKind[] = [
  "auth",
  "network",
  "shape",
  "erp_error",
  "server",
  "other",
];

function errorKind(raw: string | null): SyncErrorKind | null {
  if (raw === null) return null;
  const hit = SYNC_ERROR_KINDS.find((k) => k === raw);
  return hit ?? "other";
}

function freshnessOf(rows: readonly SyncStateRow[]): Freshness {
  let newest: number | null = null;
  for (const r of rows) {
    const t = iso(r.last_ok_at);
    if (!t) continue;
    const ms = Date.parse(t);
    if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
  }
  const stale = hasErp && (newest === null || Date.now() - newest > staleAfterMs());
  // FIX D: unauthorized ONLY on a recorded auth failure. Never having synced is
  // not an authorization verdict, and claiming it is would put an alarming "call
  // IT" banner on every fresh deployment.
  const erpAuthorized = !rows.some((r) => errorKind(r.last_error_kind) === "auth");
  return {
    last_ok_at: newest === null ? null : new Date(newest).toISOString(),
    stale,
    erp_connected: hasErp,
    erp_authorized: erpAuthorized,
  };
}

// ── commitment reads — always FROM the views, never re-spelling liveness ──────

interface CommitRow {
  id: string;
  so_id: string | null;
  sku_key: string;
  brand: string | null;
  brand_text: string | null;
  warna: string | null;
  warna_name: string | null;
  th: string | null;
  th_panel: string | null;
  p: string | null;
  l: string | null;
  qty_order: string | null;
  qty_delivered: string | null;
  qty_balance: string | null;
  status_order: string | null;
  approval: string | null;
  estimate_delivery: string | null;
  po_date: string | null;
  so_number: string | null;
  customer_name_text: string | null;
  sales_name_text: string | null;
  line_state: string;
  undated: boolean;
  age_days: string | null;
  unmatched: boolean;
  ov_state: string | null;
  ov_reason: string | null;
  ov_actor: string | null;
  ov_created_at: Date | string | null;
  ov_updated_at: Date | string | null;
  total_count: string | null;
}

type CommitSegment = "live" | "stale" | "undated" | "closed" | "all" | "exceptions";

/**
 * The FROM clause for a commitment listing. Every branch selects the same column
 * list so the outer query is written once.
 *
 * `live`/`stale`/`undated` read the views — the ST-R17 predicate is never
 * repeated here (§7.3); `undated` is simply the live view narrowed to the lines
 * AMENDMENT 1 keeps live, for PPIC triage. `closed` is a different set entirely:
 * lines a human confirm-closed, which by construction left both views, so it is
 * read from the mirror joined to the override table.
 */
function commitSource(db: Sql, segment: CommitSegment) {
  // Columns are enumerated, never `v.*`: the views select `l.*`, so a new mirror
  // column (or the `undated` column AMENDMENT 1 adds to the view) would otherwise
  // collide with the aliases the outer query computes.
  const cols = db`
    select v.id, v.so_id, v.sku_key, v.brand, v.brand_text, v.warna, v.warna_text,
           v.th, v.th_panel, v.p, v.l,
           v.qty_order, v.qty_delivered, v.qty_balance, v.status_order, v.approval,
           v.estimate_delivery, v.po_date, v.so_number, v.customer_name_text, v.sales_name_text
  `;

  const fromLive = db`${cols}, 'live'::text as line_state from v_live_commitments v`;
  const fromStale = db`${cols}, 'stale'::text as line_state from v_stale_commitments v`;
  const fromUndated = db`
    ${cols}, 'live'::text as line_state
    from v_live_commitments v
    where v.estimate_delivery is null
  `;
  const fromClosed = db`
    ${cols}, 'closed'::text as line_state
    from (
      select l.id, l.so_id, l.sku_key, l.brand, l.brand_text, l.warna, l.warna_text,
             l.th, l.th_panel, l.p, l.l,
             l.qty_order, l.qty_delivered, l.qty_balance, l.status_order, l.approval,
             l.estimate_delivery, h.po_date, h.so_number, h.customer_name_text, h.sales_name_text
      from erp_so_line l
      left join erp_so_header h on h.id = l.so_id
    ) v
    join stock_commitment_overrides oc on oc.so_line_id = v.id and oc.state = 'closed'
  `;

  switch (segment) {
    case "live":
      return fromLive;
    case "stale":
      return fromStale;
    case "undated":
      return fromUndated;
    case "closed":
      return fromClosed;
    case "all":
      // The PPIC review queue as a whole: stale lines + the undated live lines
      // AMENDMENT 1 routes here alongside them.
      return db`${fromStale} union all ${fromUndated}`;
    case "exceptions":
      // Every line that is still demand — live or stale — so the unmatched
      // filter below can pick the ones with no FG SKU (ST-R5.3).
      return db`${fromLive} union all ${fromStale}`;
  }
}

interface CommitQueryOpts {
  segment: CommitSegment;
  skuKey?: string | null;
  soLineId?: string | null;
  q?: string | null;
  minAgeDays?: number | null;
  statusOrder?: string | null;
  onlyDo?: boolean;
  unmatchedOnly?: boolean;
  sort?: string | null;
  limit?: number;
  offset?: number;
  /** Skip the unfiltered counts — only the four list endpoints need them. */
  withTotals?: boolean;
}

/** Stitch a list of predicates into `where a and b and c`, or nothing at all. */
function andWhere(db: Sql, parts: readonly ReturnType<Sql>[]) {
  let out = db``;
  for (const [i, frag] of parts.entries()) {
    out = i === 0 ? db`where ${frag}` : db`${out} and ${frag}`;
  }
  return out;
}

/**
 * One paged read of SO lines. `count(*) over ()` rides along so the pager gets a
 * `total` without a second round trip; `grand_total` and `status_facets` need one
 * more, because AMENDMENT 8 defines them as the UNFILTERED figures ("filtered
 * from 4,158") and a windowed count cannot produce them.
 *
 * Predicates split in two, and the split is the whole point:
 *   - DEFINITIONAL — what this endpoint *is* (the segment, `unmatchedOnly` for
 *     /exceptions, a pinned sku or line). These bound `grand_total` too.
 *   - USER FILTERS — what the operator typed (q, age tier, status, only_do).
 *     `grand_total` deliberately ignores these, so the UI can say how much the
 *     operator's own filtering removed.
 */
async function loadCommitments(
  db: Sql,
  o: CommitQueryOpts,
): Promise<{ rows: CommitLine[]; total: number; grandTotal: number; statusFacets: string[] }> {
  const scope: ReturnType<Sql>[] = [];
  if (o.skuKey) scope.push(db`c.sku_key = ${o.skuKey}`);
  if (o.soLineId) scope.push(db`c.id = ${o.soLineId}`);
  if (o.unmatchedOnly) scope.push(db`fg.sku_key is null`);

  const filters: ReturnType<Sql>[] = [];
  // AMENDMENT 8 ratified `status`; `statusOrder` is the value either spelling
  // lands in. ST-R22's `only_do` is the narrower, safety-critical one: the
  // "delivered but never closed" phantoms, which is what a bulk close is for.
  if (o.statusOrder) filters.push(db`c.status_order = ${o.statusOrder}`);
  if (o.onlyDo) filters.push(db`(c.status_order = 'DO' and c.qty_balance > 0)`);
  // NOT the liveness window (§7.3) — that already ran, inside the view, to
  // decide which rows exist here at all. This is the operator's "only show me
  // lines older than N days" slider on top of the result.
  const minAgeDays = safeMinAgeDays(o.minAgeDays);
  if (minAgeDays != null) {
    // The `::int` cast is load-bearing. Without it postgres.js sends the value
    // untyped, Postgres resolves `current_date - $1` as `date - date -> integer`
    // rather than `date - integer -> date`, and the comparison blows up with
    // `operator does not exist: date <= integer` (42883) — a 500, not a
    // degraded filter. Do not remove it.
    //
    // The cast fixed type RESOLUTION but not the VALUE: `?min_age_days=1.5`
    // reached Postgres as "1.5" and `invalid input syntax for type integer`
    // (22P02) is the same 500 from the other side. safeMinAgeDays() floors it,
    // which is what the slider means anyway.
    filters.push(db`c.estimate_delivery <= current_date - ${minAgeDays}::int`);
  }
  if (o.q) {
    const needle = likeNeedle(o.q);
    filters.push(db`(
      c.sku_key ilike ${needle} escape '\\'
      or coalesce(c.brand_text, c.brand, '') ilike ${needle} escape '\\'
      or coalesce(c.warna_text, c.warna, '') ilike ${needle} escape '\\'
      or coalesce(c.so_number, '') ilike ${needle} escape '\\'
      or coalesce(c.customer_name_text, '') ilike ${needle} escape '\\'
      or coalesce(c.sales_name_text, '') ilike ${needle} escape '\\'
    )`);
  }

  const whereSql = andWhere(db, [...scope, ...filters]);
  const scopeSql = andWhere(db, scope);

  // Whitelisted sorts only — the value arrives from a query string.
  //
  // AMENDMENT 12: "per-segment sort is server-side and implied by the segment —
  // `stale` by oldest ETA, `undated` by largest balance", and the client sends no
  // `sort` for the review queue at all (AMENDMENT 9). A single `eta_asc` default
  // for every segment silently broke the undated half: every ETA there is NULL,
  // so the sort collapsed to `id asc` and balances came back in mirror order.
  // The default is therefore chosen by segment; an explicit `?sort=` still wins.
  const defaultSort = o.segment === "undated" ? "qty_desc" : "eta_asc";
  const sort = str(o.sort) || defaultSort;
  const orderSql =
    sort === "eta_desc" ? db`order by c.estimate_delivery desc nulls last, c.id asc`
    : sort === "qty_desc" ? db`order by c.qty_balance desc, c.id asc`
    : sort === "sku_asc" ? db`order by c.sku_key asc, c.id asc`
    : sort === "po_date_asc" ? db`order by c.po_date asc nulls last, c.id asc`
    : db`order by c.estimate_delivery asc nulls first, c.id asc`;

  const limit = Math.min(Math.max(o.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(o.offset ?? 0, 0);

  const rows = await db<CommitRow[]>`
    select c.id, c.so_id, c.sku_key, c.brand, c.brand_text, c.warna,
           coalesce(c.warna_text, wn.rm_warna) as warna_name,
           c.th::text as th, c.th_panel::text as th_panel, c.p::text as p, c.l::text as l,
           c.qty_order::text as qty_order, c.qty_delivered::text as qty_delivered,
           c.qty_balance::text as qty_balance,
           c.status_order, c.approval,
           to_char(c.estimate_delivery, 'YYYY-MM-DD') as estimate_delivery,
           to_char(c.po_date, 'YYYY-MM-DD') as po_date,
           c.so_number, c.customer_name_text, c.sales_name_text,
           c.line_state,
           (c.estimate_delivery is null) as undated,
           case when c.estimate_delivery is null then null
                else (current_date - c.estimate_delivery)::text end as age_days,
           (fg.sku_key is null) as unmatched,
           o.state as ov_state, o.reason as ov_reason, o.actor as ov_actor,
           o.created_at as ov_created_at, o.updated_at as ov_updated_at,
           count(*) over () as total_count
    from (${commitSource(db, o.segment)}) c
    ${warnaName(db, "c")}
    left join stock_commitment_overrides o on o.so_line_id = c.id
    left join (select distinct sku_key from erp_live_fg) fg on fg.sku_key = c.sku_key
    ${whereSql}
    ${orderSql}
    limit ${limit} offset ${offset}
  `;

  const first = rows[0];
  const total = first ? numOf(first.total_count) : 0;
  const shaped = rows.map(shapeCommit);

  // The unfiltered figures (AMENDMENT 8). Same source and same definitional
  // scope, none of the operator's filters. Only the list endpoints render them,
  // so a detail read or a single-line re-read does not pay for the extra query.
  if (!o.withTotals) return { rows: shaped, total, grandTotal: total, statusFacets: [] };

  const [grand] = await db<{ grand_total: string; status_facets: string[] | null }[]>`
    select count(*) as grand_total,
           coalesce(
             array_agg(distinct c.status_order) filter (where c.status_order is not null),
             '{}'::text[]
           ) as status_facets
    from (${commitSource(db, o.segment)}) c
    left join (select distinct sku_key from erp_live_fg) fg on fg.sku_key = c.sku_key
    ${scopeSql}
  `;

  return {
    rows: shaped,
    total,
    grandTotal: grand ? numOf(grand.grand_total) : 0,
    statusFacets: (grand?.status_facets ?? []).slice().sort(),
  };
}

function shapeCommit(r: CommitRow): CommitLine {
  const th = numOrNull(r.th);
  const th_panel = numOrNull(r.th_panel);
  const p = numOrNull(r.p);
  const l = numOrNull(r.l);
  const lineState: CommitLine["state"] =
    r.line_state === "closed" ? "closed" : r.line_state === "stale" ? "stale" : "live";
  return {
    so_line_id: String(r.id),
    sku_key: r.sku_key,
    name: composeName(
      {
        brand: r.brand,
        brand_text: r.brand_text,
        warna: r.warna,
        warna_name: r.warna_name,
        th,
        th_panel,
        p,
        l,
      },
      r.sku_key,
    ),
    brand: r.brand,
    brand_text: r.brand_text,
    warna: r.warna,
    warna_name: r.warna_name,
    th,
    th_panel,
    p,
    l,
    so_id: r.so_id,
    so_number: r.so_number,
    customer_name_text: r.customer_name_text,
    sales_name_text: r.sales_name_text,
    qty_order: numOrNull(r.qty_order),
    qty_delivered: numOrNull(r.qty_delivered),
    qty_balance: round2(numOf(r.qty_balance)),
    status_order: r.status_order,
    approval: r.approval,
    estimate_delivery: r.estimate_delivery,
    po_date: r.po_date,
    undated: Boolean(r.undated),
    age_days: numOrNull(r.age_days),
    state: lineState,
    unmatched: Boolean(r.unmatched),
    override: r.ov_state
      ? {
          so_line_id: String(r.id),
          state: r.ov_state,
          reason: r.ov_reason,
          actor: r.ov_actor ?? "",
          created_at: iso(r.ov_created_at),
          updated_at: iso(r.ov_updated_at),
        }
      : null,
  };
}

// ── the sync worker (WP-2), imported lazily ───────────────────────────────────

/**
 * `runErpSyncOnce()` is owned by WP-2 (`src/erp/syncWorker.ts`) and is being
 * written in parallel with this file. The specifier is held in a variable so the
 * module is resolved at call time, not at compile time: `POST /sync` degrades to
 * a Bahasa 503 until WP-2 lands and starts working the moment it does, and this
 * file never grows a sync of its own (the sync has exactly one home, §5).
 */
const SYNC_WORKER_MODULE = "../erp/syncWorker.js";

/** What a recompute reports back. Mirrors SkuKeyRecomputeResult in the worker. */
interface SkuKeyRecomputeResult {
  started: boolean;
  skipped?: string;
  ok: boolean;
  updated: number;
  tables: { table: string; ok: boolean; updated: number; error?: string }[];
  durationMs: number;
}

interface SyncWorkerModule {
  /** `full: true` clears every stored cursor first, then re-pulls every table. */
  runErpSyncOnce: (overrides?: { full?: boolean; actor?: string | null }) => Promise<unknown>;
  /** The cheap in-place repair. Absent on an older worker build; the route copes. */
  recomputeSkuKeys?: () => Promise<SkuKeyRecomputeResult>;
}

async function loadSyncWorker(): Promise<SyncWorkerModule | null> {
  try {
    const mod: unknown = await import(SYNC_WORKER_MODULE);
    const m = mod as Partial<SyncWorkerModule> | null;
    const fn = m?.runErpSyncOnce;
    if (typeof fn !== "function") return null;
    const recompute = m?.recomputeSkuKeys;
    return { runErpSyncOnce: fn, ...(typeof recompute === "function" ? { recomputeSkuKeys: recompute } : {}) };
  } catch {
    return null;
  }
}

// ── routes ────────────────────────────────────────────────────────────────────

export async function stockAtpRoutes(app: FastifyInstance): Promise<void> {
  // ── 1 · GET /api/stock/summary — ST-R15 compatibility endpoint (§4.1) ──────
  // Same URL as 1.0, ATP-shaped body, so /stock migrates without a URL break.
  // Two queries total for the whole page: the engine, and the freshness row.
  app.get("/api/stock/summary", async (_req, reply) => {
    const db = getSql();
    if (!db) return dbErr(reply);

    const [items, syncState] = await Promise.all([loadItems(db), loadSyncState(db)]);

    const totals: SummaryTotals = {
      skus: items.length,
      tersedia: 0,
      habis: 0,
      kosong: 0,
      perlu_produksi: 0,
      stale_commitments: 0,
      undated_commitments: 0,
      exceptions: 0,
      exception_skus: 0,
    };
    for (const it of items) {
      totals[it.state] += 1;
      totals.stale_commitments += it.stale_lines;
      // AMENDMENT 12: the engine already counts these per item; summing them is
      // the whole implementation, and it retires the page's counting probe.
      totals.undated_commitments += it.undated_lines;
      // ST-R5.3: demand against a SKU with no Live FG row at all. Counted both
      // ways — in lines (what the exceptions tray lists) and in SKUs (FIX E:
      // what `skus` can actually be divided by, since many lines share a SKU).
      if (it.stock_rows === 0 && it.live_lines + it.stale_lines > 0) {
        totals.exceptions += it.live_lines + it.stale_lines;
        totals.exception_skus += 1;
      }
    }

    const body: SummaryResponse = {
      freshness: freshnessOf(syncState),
      totals,
      items: items.map(toWire),
    };
    return body;
  });

  // ── 2 · GET /api/stock/sku/:sku_key — ST-R13 timeline (§4.2, frozen shape) ──
  // Fastify decodes the path param, so `%7C` arrives as `|` already. Do NOT
  // decodeURIComponent again — a sku_key legitimately containing '%' would be
  // corrupted by a second pass.
  app.get<{ Params: { sku_key: string } }>("/api/stock/sku/:sku_key", async (request, reply) => {
    const db = getSql();
    if (!db) return dbErr(reply);

    const skuKey = str(request.params.sku_key);
    if (!skuKey) return reply.code(400).send({ error: "Kode SKU wajib diisi." });

    const [item] = await loadItems(db, skuKey);
    if (!item) return reply.code(404).send({ error: "Kode SKU tidak ditemukan." });

    const [live, stale, adjustments, onHand] = await Promise.all([
      loadCommitments(db, { segment: "live", skuKey, sort: "eta_asc", limit: MAX_LIMIT }),
      loadCommitments(db, { segment: "stale", skuKey, sort: "eta_asc", limit: MAX_LIMIT }),
      db<{
        id: string; sku_key: string; qty_delta: string; reason: string; actor: string; created_at: Date | string;
      }[]>`
        select id, sku_key, qty_delta::text as qty_delta, reason, actor, created_at
        from stock_adjustments
        where sku_key = ${skuKey}
        order by created_at desc, id desc
        limit ${MAX_LIMIT}
      `,
      db<{
        erp_row_id: string; sn_fg: string | null; lokasi: string | null; qty: string; qty_m2: string | null;
        buffer_qty: string | null; buffer_status: string | null; erp_updated_at: Date | string | null;
      }[]>`
        select erp_row_id, sn_fg, lokasi, qty::text as qty, qty_m2::text as qty_m2,
               buffer_qty::text as buffer_qty, buffer_status, erp_updated_at
        from erp_live_fg
        where sku_key = ${skuKey}
        order by lokasi nulls last, sn_fg nulls last, erp_row_id
        limit ${MAX_LIMIT}
      `,
    ]);

    // Every array is always present — `[]` when empty, never null, never omitted.
    const body: SkuDetailResponse = {
      item: toWire(item),
      live_commitments: live.rows,
      stale_commitments: stale.rows,
      adjustments: adjustments.map((a) => ({
        id: String(a.id),
        sku_key: a.sku_key,
        name: item.name,
        qty_delta: round2(numOf(a.qty_delta)),
        reason: a.reason,
        actor: a.actor,
        created_at: iso(a.created_at),
      })),
      on_hand_rows: onHand.map((r) => ({
        // The serial, not the row id: an operator matching this against a
        // physical panel needs FG-AAA-0001, not 1210-000001 (FIX B).
        sn_fg: r.sn_fg,
        erp_row_id: r.erp_row_id,
        lokasi: r.lokasi,
        qty: round2(numOf(r.qty)),
        qty_m2: numOrNull(r.qty_m2),
        buffer_qty: numOrNull(r.buffer_qty),
        buffer_status: r.buffer_status,
        erp_updated_at: iso(r.erp_updated_at),
      })),
    };
    return body;
  });

  // ── 3 · GET /api/stock/shortfall — ST-R11 PPIC production trigger (§4.2) ────
  // committed > on_hand + adjustment, ranked deficit desc then nearest ETA asc.
  // Ranking is server-side: the page renders the order it is given.
  app.get<{ Querystring: { page?: string; limit?: string; offset?: string; q?: string } }>(
    "/api/stock/shortfall",
    async (request, reply) => {
      const db = getSql();
      if (!db) return dbErr(reply);

      const { page, limit, offset } = pageParams(request.query);
      const q = str(request.query.q).toLowerCase();

      const items = await loadItems(db);
      const all = items.filter((it) => it.committed > it.on_hand + it.adjustment);
      let short = all;
      if (q) {
        short = short.filter((it) =>
          [it.sku_key, it.name, it.kode_barang, it.brand_text, it.brand, it.warna_name, it.warna]
            .some((v) => (v ?? "").toLowerCase().includes(q)),
        );
      }
      short.sort((a, b) => {
        const da = round2(a.committed - (a.on_hand + a.adjustment));
        const dbb = round2(b.committed - (b.on_hand + b.adjustment));
        if (da !== dbb) return dbb - da;
        // Nearest deadline first; a SKU with no live ETA sorts last.
        if (a.nearest_eta !== b.nearest_eta) {
          if (a.nearest_eta === null) return 1;
          if (b.nearest_eta === null) return -1;
          return a.nearest_eta < b.nearest_eta ? -1 : 1;
        }
        return a.sku_key < b.sku_key ? -1 : 1;
      });

      const slice = short.slice(offset, offset + limit).map((it) => ({
        ...toWire(it),
        // Always positive here by construction; the ATP itself stays signed.
        deficit: round2(it.committed - (it.on_hand + it.adjustment)),
        lines: it.live_lines,
      }));
      const body: PagedResponse<SkuItem & { deficit: number; lines: number }> = {
        rows: slice,
        items: slice,
        total: short.length,
        grand_total: all.length,
        page,
        limit,
        has_more: offset + slice.length < short.length,
      };
      return body;
    },
  );

  // ── 4 · GET /api/stock/stale-commitments — ST-R18 review queue (§4.2) ───────
  // segment (AMENDMENT 8): 'stale' (default) · 'undated' (AMENDMENT 1 live lines
  // with no ETA, triaged here alongside them) · 'closed' (the undo view) · 'all'.
  // Filters: q, min_age_days, status (alias status_order), only_do, sku_key,
  // sort, page, limit.
  app.get<{
    Querystring: {
      page?: string; limit?: string; offset?: string; q?: string;
      min_age_days?: string; status?: string; status_order?: string;
      only_do?: string; sort?: string;
      state?: string; segment?: string; filter?: string; sku_key?: string;
    };
  }>("/api/stock/stale-commitments", async (request, reply) => {
    const db = getSql();
    if (!db) return dbErr(reply);

    const qs = request.query;
    const { page, limit, offset } = pageParams(qs);
    const asked = str(qs.segment) || str(qs.filter);
    // `segment=closed` is load-bearing, not a nicety: a confirm-closed line has
    // left v_stale_commitments, so without this the undo path dies the moment
    // the operator reloads the page and can never reinstate. `state=closed` is
    // kept as an alias — the shipped PPIC page sends that spelling.
    const segment: CommitSegment =
      asked === "closed" || str(qs.state) === "closed" ? "closed"
      : asked === "undated" ? "undated"
      : asked === "all" ? "all"
      : "stale";

    const { rows, total, grandTotal, statusFacets } = await loadCommitments(db, {
      segment,
      withTotals: true,
      skuKey: optStr(qs.sku_key),
      q: optStr(qs.q),
      minAgeDays: numOrNull(qs.min_age_days),
      // `status` is the AMENDMENT 8 name and what the shipped page sends;
      // `status_order` stays accepted so an older caller keeps working.
      statusOrder: optStr(qs.status) ?? optStr(qs.status_order),
      onlyDo: isTruthy(qs.only_do),
      sort: optStr(qs.sort),
      limit,
      offset,
    });

    const body: PagedResponse<CommitLine> & {
      segment: CommitSegment;
      status_facets: string[];
    } = {
      rows,
      items: rows,
      total,
      grand_total: grandTotal,
      page,
      limit,
      has_more: offset + rows.length < total,
      segment,
      // Every status present in this segment before the operator's filters, so
      // the dropdown does not collapse to whatever the current page happens to
      // contain (OQ-1: the enum is not frozen, so it is discovered, not listed).
      status_facets: statusFacets,
    };
    return body;
  });

  // ── 5 · GET /api/stock/exceptions — ST-R5.3 unmatched demand (§4.2) ─────────
  // Approved, non-cancelled demand whose sku_key has no erp_live_fg row at all.
  // It is NOT dropped from ATP: the SKU still appears in /summary with on_hand 0
  // and a negative ATP. This tray is how PPIC sees why (AMENDMENT 2).
  app.get<{ Querystring: { page?: string; limit?: string; offset?: string; q?: string; sort?: string } }>(
    "/api/stock/exceptions",
    async (request, reply) => {
      const db = getSql();
      if (!db) return dbErr(reply);

      const { page, limit, offset } = pageParams(request.query);
      const { rows, total, grandTotal } = await loadCommitments(db, {
        segment: "exceptions",
        withTotals: true,
        q: optStr(request.query.q),
        unmatchedOnly: true,
        sort: optStr(request.query.sort) ?? "qty_desc",
        limit,
        offset,
      });

      // One reason exists in v1: the SKU key resolves to no finished-goods row.
      // UoM mismatch (ST-R5.4) has no column to detect it on yet — see the
      // "Known gap" note in CONTRACTS.
      const shaped = rows.map((r) => ({ ...r, reason: "sku_tidak_cocok" }));
      const body: PagedResponse<CommitLine & { reason: string }> = {
        rows: shaped,
        items: shaped,
        total,
        grand_total: grandTotal,
        page,
        limit,
        has_more: offset + rows.length < total,
      };
      return body;
    },
  );

  // ── 6 · GET /api/stock/sync-status — freshness + cursors + last error ───────
  app.get("/api/stock/sync-status", async (_req, reply) => {
    const db = getSql();
    if (!db) return dbErr(reply);

    const rows = await loadSyncState(db);
    const body: SyncStatusResponse = {
      freshness: freshnessOf(rows),
      running: rows.some((r) => r.running),
      interval_ms: config.stock.syncIntervalMs,
      stale_after_ms: staleAfterMs(),
      tables: rows.map((r) => ({
        table_name: r.table_name,
        cursor_value: iso(r.cursor_value),
        last_ok_at: iso(r.last_ok_at),
        // Never echo a secret into a response (§7.9) — last_error is written by
        // the worker, which is contractually forbidden from putting the token in it.
        last_error: r.last_error,
        last_error_kind: errorKind(r.last_error_kind),
        last_error_at: iso(r.last_error_at),
        rows_synced: numOf(r.rows_synced),
        running: Boolean(r.running),
      })),
    };
    return body;
  });

  // ── 7 · GET /api/stock/adjustments — the audit list (§4.2) ─────────────────
  app.get<{ Querystring: { page?: string; limit?: string; offset?: string; q?: string; sku_key?: string } }>(
    "/api/stock/adjustments",
    async (request, reply) => {
      const db = getSql();
      if (!db) return dbErr(reply);

      const { page, limit, offset } = pageParams(request.query);
      const skuKey = optStr(request.query.sku_key);
      const q = optStr(request.query.q);

      const filters: ReturnType<Sql>[] = [];
      if (skuKey) filters.push(db`a.sku_key = ${skuKey}`);
      if (q) {
        const needle = likeNeedle(q);
        filters.push(db`(
          a.sku_key ilike ${needle} escape '\\'
          or a.actor ilike ${needle} escape '\\'
          or a.reason ilike ${needle} escape '\\'
        )`);
      }
      const whereSql = andWhere(db, filters);

      const rows = await db<{
        id: string; sku_key: string; qty_delta: string; reason: string; actor: string;
        created_at: Date | string; kode_barang: string | null;
        brand: string | null; brand_text: string | null;
        warna: string | null; warna_name: string | null;
        th: string | null; th_panel: string | null; p: string | null; l: string | null;
        total_count: string;
      }[]>`
        select a.id, a.sku_key, a.qty_delta::text as qty_delta, a.reason, a.actor, a.created_at,
               i.kode_barang, i.brand, i.brand_text, i.warna,
               coalesce(i.warna_text, wn.rm_warna) as warna_name,
               i.th::text as th, i.th_panel::text as th_panel, i.p::text as p, i.l::text as l,
               count(*) over () as total_count
        from stock_adjustments a
        left join lateral (
          select kode_barang, brand, brand_text, warna, warna_text, th, th_panel, p, l
          from erp_live_fg f
          where f.sku_key = a.sku_key limit 1
        ) i on true
        left join lateral (
          select w.rm_warna
          from erp_warna w
          where w.id = i.warna
             or (w.code_num is not null and w.code_num = erp_num_or_null(i.warna))
          order by (w.id = i.warna) desc nulls last
          limit 1
        ) wn on true
        ${whereSql}
        order by a.created_at desc, a.id desc
        limit ${limit} offset ${offset}
      `;

      // Unfiltered count (AMENDMENT 8): the whole audit log, so the UI can say
      // how much the operator's own search narrowed it.
      const [grand] = await db<{ grand_total: string }[]>`
        select count(*) as grand_total from stock_adjustments
      `;

      const first = rows[0];
      const total = first ? numOf(first.total_count) : 0;
      const shaped: AdjustmentRow[] = rows.map((r) => ({
        id: String(r.id),
        sku_key: r.sku_key,
        name: composeName(
          {
            kode_barang: r.kode_barang,
            brand: r.brand,
            brand_text: r.brand_text,
            warna: r.warna,
            warna_name: r.warna_name,
            th: numOrNull(r.th),
            th_panel: numOrNull(r.th_panel),
            p: numOrNull(r.p),
            l: numOrNull(r.l),
          },
          r.sku_key,
        ),
        qty_delta: round2(numOf(r.qty_delta)),
        reason: r.reason,
        actor: r.actor,
        created_at: iso(r.created_at),
      }));
      const body: PagedResponse<AdjustmentRow> = {
        rows: shaped,
        items: shaped,
        total,
        grand_total: grand ? numOf(grand.grand_total) : 0,
        page,
        limit,
        has_more: offset + rows.length < total,
      };
      return body;
    },
  );

  // ── 8 · POST /api/stock/adjustments — ST-R12 / ST-R20 opname correction ─────
  // Signed, additive, audited. It inserts ONE row and touches nothing else: the
  // mirror stays a faithful copy of the ERP (§7.2) and the correction is a
  // separate term in the ATP formula, visible beside on_hand rather than hidden
  // inside it. `reason` is required and `qty_delta` may not be zero (ST-R12).
  app.post<{ Body: Record<string, unknown> }>("/api/stock/adjustments", async (request, reply) => {
    const db = getSql();
    if (!db) return dbErr(reply);

    const b = request.body ?? {};
    const sku_key = str(b.sku_key);
    const qty_delta = numOrNull(b.qty_delta);
    const reason = str(b.reason);
    const actor = str(b.actor);

    if (!sku_key) return reply.code(400).send({ error: "Kode SKU wajib diisi." });
    if (qty_delta === null) return reply.code(400).send({ error: "Jumlah penyesuaian tidak valid." });
    if (qty_delta === 0) return reply.code(400).send({ error: "Jumlah penyesuaian tidak boleh nol." });
    if (reason.length < 4) return reply.code(400).send({ error: "Alasan wajib diisi." });
    if (!actor) return reply.code(400).send({ error: "Nama petugas wajib diisi." });

    const [row] = await db<{
      id: string; sku_key: string; qty_delta: string; reason: string; actor: string; created_at: Date | string;
    }[]>`
      insert into stock_adjustments (sku_key, qty_delta, reason, actor)
      values (${sku_key}, ${qty_delta}, ${reason}, ${actor})
      returning id, sku_key, qty_delta::text as qty_delta, reason, actor, created_at
    `;
    if (!row) return reply.code(500).send({ error: "Gagal menyimpan penyesuaian." });

    // Recompute, never mutate: the caller gets the SKU's new ATP straight from
    // the engine, so nobody is tempted to apply the delta client-side.
    const [item] = await loadItems(db, sku_key);
    const adjustment: AdjustmentRow = {
      id: String(row.id),
      sku_key: row.sku_key,
      name: item?.name ?? row.sku_key,
      qty_delta: round2(numOf(row.qty_delta)),
      reason: row.reason,
      actor: row.actor,
      created_at: iso(row.created_at),
    };
    return reply.code(201).send({ adjustment, item: item ? toWire(item) : null });
  });

  // ── 9 · POST /api/stock/stale-commitments/:so_line_id/close — ST-R21 ────────
  // Confirm-close one phantom commitment. The ERP keeps its balance; LeadScout
  // records a human decision that drops the line out of BOTH views. Reversible
  // (see /reinstate) and audited — actor is mandatory.
  //
  // NOTE for PPIC copy: closing a STALE line changes no number (it was already
  // excluded); closing an UNDATED live line RAISES ATP by qty_balance, because
  // the reservation goes away. Same endpoint, very different consequence.
  app.post<{ Params: { so_line_id: string }; Body: Record<string, unknown> }>(
    "/api/stock/stale-commitments/:so_line_id/close",
    async (request, reply) => {
      const db = getSql();
      if (!db) return dbErr(reply);
      return overrideCommitment(db, request, reply, "closed");
    },
  );

  // ── 10 · POST /api/stock/stale-commitments/:so_line_id/reinstate — ST-R21 ───
  // The undo. The line goes back to being whatever the liveness rule says it is:
  // live (reserving again) or stale (back in the queue). We never decide that
  // here — we only remove our own override.
  app.post<{ Params: { so_line_id: string }; Body: Record<string, unknown> }>(
    "/api/stock/stale-commitments/:so_line_id/reinstate",
    async (request, reply) => {
      const db = getSql();
      if (!db) return dbErr(reply);
      return overrideCommitment(db, request, reply, "reinstated");
    },
  );

  // ── 10b · POST /api/stock/stale-commitments/close-batch — ST-R21 + ST-R22 ──
  // One transaction, all-or-nothing. Exists because ST-R22's "delivered but
  // never closed" rows are the known-dead phantoms and there are thousands of
  // them; closing those one tap at a time is work nobody finishes.
  //
  // Two deliberate refusals:
  //   - the request carries an EXPLICIT id list, never a filter. A filter-shaped
  //     "close everything matching X" is one typo away from releasing thousands
  //     of live reservations, and the reservation is the thing protecting stock
  //     that is already owed to a customer.
  //   - `expected_count` must equal the list length. The client states how many
  //     rows it believes it is closing; if its view of the queue has moved since
  //     the operator picked them, we write nothing and say so.
  // `reason` is mandatory here even though a single close may omit it — a bulk
  // action with a blank audit row is exactly the one you cannot reconstruct later.
  app.post<{ Body: Record<string, unknown> }>(
    "/api/stock/stale-commitments/close-batch",
    async (request, reply) => {
      const db = getSql();
      if (!db) return dbErr(reply);

      const b = request.body ?? {};
      const rawIds = Array.isArray(b.so_line_ids) ? b.so_line_ids : null;
      const reason = str(b.reason);
      const actor = str(b.actor);
      const expected = numOrNull(b.expected_count);

      if (!rawIds) return reply.code(400).send({ error: "Daftar baris SO wajib diisi." });
      const cleaned = rawIds.map((v) => str(v)).filter((v) => v !== "");
      const ids = [...new Set(cleaned)];
      if (ids.length === 0) return reply.code(400).send({ error: "Daftar baris SO wajib diisi." });
      // Blank or non-string entries are refused rather than quietly dropped, for
      // the same reason duplicates are: `expected_count` is only a guard while
      // the number the operator was shown equals the number this call can close.
      // ["id", "", null] with expected_count 3 used to pass and close one row.
      if (cleaned.length !== rawIds.length) {
        return reply.code(400).send({
          error: "Daftar baris SO memuat entri kosong. Muat ulang antrean.",
          expected_count: expected,
          received_count: rawIds.length,
          unique_count: ids.length,
        });
      }
      // A duplicate id is refused outright rather than quietly collapsed. The
      // whole job of `expected_count` is to keep the number the operator was
      // shown and the number of commitments actually released in agreement;
      // silently deduplicating [A, A] with expected_count 2 closes one row while
      // the guard reports success, which breaks exactly that property.
      if (ids.length !== cleaned.length) {
        return reply.code(409).send({
          error: "Daftar baris SO memuat duplikat. Muat ulang antrean.",
          expected_count: expected,
          received_count: rawIds.length,
          unique_count: ids.length,
        });
      }
      if (ids.length > MAX_BATCH_CLOSE) {
        return reply.code(400).send({ error: `Maksimum ${MAX_BATCH_CLOSE} baris sekali tutup.` });
      }
      if (reason.length < 4) return reply.code(400).send({ error: "Alasan wajib diisi." });
      if (!actor) return reply.code(400).send({ error: "Nama petugas wajib diisi." });
      if (expected === null) return reply.code(400).send({ error: "Jumlah baris wajib disertakan." });
      // Compared against what the client actually sent. Duplicates were already
      // refused above, so `rawIds.length`, `ids.length` and the number of rows
      // this batch can close are now the same number by construction.
      if (rawIds.length !== expected) {
        return reply.code(409).send({
          error: "Jumlah baris tidak cocok — daftar berubah. Muat ulang antrean.",
          expected_count: expected,
          received_count: rawIds.length,
        });
      }

      // ── The membership guard (the reason this endpoint is dangerous) ────────
      //
      // The operator selected these ids from ONE segment of the review queue.
      // Between that click and this request an ERP sync can land and move a
      // line: a stale line whose `estimate_delivery` is pushed into the future
      // becomes LIVE and starts reserving stock. Closing it then releases a
      // commitment that is genuinely owed to a customer — the exact
      // over-promising failure this module exists to prevent.
      //
      // `expected_count` cannot catch that. The client derives it from the same
      // array it posts, so it only ever compares a list's length to itself; it
      // detects a mis-typed payload, never a moved queue.
      //
      // So the segment is part of the write. `ids` are resolved against the
      // caller's declared segment view, and the INSERT selects from that same
      // view in ONE statement — one snapshot, so nothing can slip between the
      // check and the write. A line that has left the segment is reported in
      // `skipped` and is never closed.
      // Default `all` = stale ∪ undated, i.e. the review queue as a whole: that
      // is the population this endpoint has always been allowed to close, and
      // narrowing it further is the caller's choice, not ours. What `all`
      // excludes — and what the bug let through — is a line that is neither
      // stale nor undated: an ordinary live commitment with a future delivery
      // date, owed to a customer, which must never be closable from here.
      const SEGMENTS = ["stale", "undated", "all"] as const;
      if (b.segment !== undefined && !SEGMENTS.includes(b.segment as (typeof SEGMENTS)[number])) {
        return reply.code(400).send({ error: "Segmen antrean tidak dikenal." });
      }
      const segment: CommitSegment = (b.segment as CommitSegment | undefined) ?? "all";
      /**
       * Eligible = in the declared segment, OR already confirm-closed. The
       * second arm is what keeps the endpoint idempotent: a closed line has
       * left `v_stale_commitments` by definition, so without it re-sending the
       * same batch would report every row as "no longer in the queue" — which
       * is true of the view and false of the operator's intent.
       */
      const eligibleSource = (sql: Sql) => sql`
        select v.id, v.sku_key from (${commitSource(sql, segment)}) v
        union
        select c.id, c.sku_key from (${commitSource(sql, "closed")}) c
      `;

      // Two different skip reasons, because they mean different things to the
      // operator: an id that is not in the mirror at all is a stale browser tab,
      // while an id that exists but has left the queue is a line a sync moved —
      // the case that used to release a live commitment.
      const inMirror = await db<{ id: string }[]>`
        select id from erp_so_line where id = any(${ids})
      `;
      const mirrorSet = new Set(inMirror.map((r) => String(r.id)));
      if (mirrorSet.size === 0) {
        return reply.code(404).send({ error: "Tidak ada baris Sales Order yang cocok." });
      }

      // Pre-read for the ATP snapshot and the skipped list. The authoritative
      // membership test is the INSERT below, not this.
      const found = await db<{ id: string; sku_key: string }[]>`
        select e.id, e.sku_key from (${eligibleSource(db)}) e where e.id = any(${ids})
      `;
      const skus = [...new Set(found.map((r) => r.sku_key))];

      if (found.length === 0) {
        return reply.code(409).send({
          error: "Baris yang dipilih sudah tidak ada di antrean ini. Muat ulang antrean.",
          expected_count: expected,
          received_count: rawIds.length,
        });
      }

      // ATP is derived, so the delta is measured, not predicted: snapshot the
      // affected SKUs, write, snapshot again.
      const before = atpBySku(await loadItems(db, skus));

      // `returning` tells us what the write actually matched, so `closed` counts
      // rows this call closed rather than rows that happened to exist.
      let closedIds: string[] = [];
      await db.begin(async (sql) => {
        const written = await sql<{ so_line_id: string }[]>`
          insert into stock_commitment_overrides (so_line_id, state, reason, actor)
          select v.id, 'closed', ${reason}, ${actor}
          from (${eligibleSource(sql as unknown as Sql)}) v
          where v.id = any(${ids})
          on conflict (so_line_id) do update
            set state = 'closed',
                reason = excluded.reason,
                actor = excluded.actor,
                updated_at = now()
          returning so_line_id
        `;
        closedIds = written.map((r) => String(r.so_line_id));
      });

      const closedSet = new Set(closedIds);
      const skipped = ids
        .filter((id) => !closedSet.has(id))
        .map((id) => ({
          so_line_id: id,
          reason: mirrorSet.has(id) ? "tidak_lagi_di_antrean" : "tidak_ditemukan",
        }));

      const after = atpBySku(await loadItems(db, skus));
      const atp_delta_by_sku: Record<string, number> = {};
      for (const sku of skus) {
        atp_delta_by_sku[sku] = round2((after[sku] ?? 0) - (before[sku] ?? 0));
      }

      return {
        ok: true,
        segment,
        closed: closedIds.length,
        skipped,
        atp_delta_by_sku,
      };
    },
  );

  /**
   * Shared body of close/reinstate: validate, measure ATP, write, measure again.
   *
   * `atp_delta` is computed here and never inferred by the client, because the
   * two populations in the review queue behave in opposite ways: closing a stale
   * line moves ATP by exactly 0 (it was already excluded from the sum), while
   * closing an undated line (AMENDMENT 1) RAISES ATP by its whole balance,
   * because that line was reserving stock. An operator who learned "closing
   * changes nothing" from the first population would silently release reserved
   * stock in the second. The number the UI states has to be the real one.
   */
  async function overrideCommitment(
    db: Sql,
    request: { params: { so_line_id: string }; body: Record<string, unknown> | undefined },
    reply: FastifyReply,
    state: "closed" | "reinstated",
  ) {
    const soLineId = str(request.params.so_line_id);
    if (!soLineId) return reply.code(400).send({ error: "Baris SO tidak valid." });

    const b = request.body ?? {};
    const actor = str(b.actor);
    const reason = optStr(b.reason);
    if (!actor) return reply.code(400).send({ error: "Nama petugas wajib diisi." });

    // The line must exist in the mirror. We read erp_so_line, we never write it.
    const [line] = await db<{ id: string; sku_key: string }[]>`
      select id, sku_key from erp_so_line where id = ${soLineId}
    `;
    if (!line) return reply.code(404).send({ error: "Baris Sales Order tidak ditemukan." });

    const [itemBefore] = await loadItems(db, line.sku_key);
    const atpBefore = itemBefore?.atp ?? 0;

    const [override] = await db<{
      so_line_id: string; state: string; reason: string | null; actor: string;
      created_at: Date | string; updated_at: Date | string;
    }[]>`
      insert into stock_commitment_overrides (so_line_id, state, reason, actor)
      values (${soLineId}, ${state}, ${reason}, ${actor})
      on conflict (so_line_id) do update
        set state = excluded.state,
            reason = excluded.reason,
            actor = excluded.actor,
            updated_at = now()
      returning so_line_id, state, reason, actor, created_at, updated_at
    `;
    if (!override) return reply.code(500).send({ error: "Gagal menyimpan keputusan." });

    const [itemAfter] = await loadItems(db, line.sku_key);
    const atpAfter = itemAfter?.atp ?? 0;

    // Re-read the line through the views so the caller sees where it landed —
    // 'closed', or back to 'live'/'stale' as the liveness rule decides. We never
    // decide that here; removing our override hands the line back to the rule.
    const back = await loadCommitmentById(db, soLineId);

    return {
      ok: true,
      so_line_id: String(line.id),
      sku_key: line.sku_key,
      atp_delta: round2(atpAfter - atpBefore),
      atp_before: atpBefore,
      atp_after: atpAfter,
      override: {
        so_line_id: override.so_line_id,
        state: override.state,
        reason: override.reason,
        actor: override.actor,
        created_at: iso(override.created_at),
        updated_at: iso(override.updated_at),
      } satisfies CommitOverride,
      commitment: back,
    };
  }

  /** One line by id, from whichever set now holds it. Null if it holds none. */
  async function loadCommitmentById(db: Sql, soLineId: string): Promise<CommitLine | null> {
    for (const segment of ["closed", "live", "stale"] as const) {
      const { rows } = await loadCommitments(db, {
        segment,
        limit: 1,
        offset: 0,
        sort: "sku_asc",
        soLineId,
      });
      const hit = rows[0];
      if (hit) return hit;
    }
    return null;
  }

  // ── 11 · POST /api/stock/sync — manual kick (§4.2) ──────────────────────────
  //
  // THREE MODES, one endpoint, because all three take the same run guard and a
  // caller must never be able to start two of them at once.
  //
  //   {}                     — incremental. Unchanged, and the default: pull the
  //                            window since each table's stored cursor.
  //   { recompute: true }    — the CHEAP repair. Recompute every stored `sku_key`
  //                            from the row's OWN mirrored columns. No ERP
  //                            traffic, seconds, awaited so the count comes back
  //                            in the response. Fixes a stale key composition.
  //   { full: true }         — the EXPENSIVE repair. Clear every stored cursor
  //                            and re-fetch every row (~137k SO lines, minutes).
  //                            The only thing that fixes a row whose mirrored
  //                            COLUMNS are wrong, because a cursor only ever
  //                            moves forward and never revisits such a row.
  //
  // `full` and `recompute` REQUIRE an actor and are logged with it. The 137k-row
  // re-pull is not something to trigger by accident, and "who pressed it" is the
  // first question asked when the ERP suddenly sees a minutes-long burst.
  //
  // Idempotent by construction in every mode: the worker upserts by primary key,
  // so kicking it twice yields identical mirror rows and identical ATP (§5).
  app.post<{ Body: Record<string, unknown> }>("/api/stock/sync", async (request, reply) => {
    const db = getSql();
    if (!db) return dbErr(reply);

    const body = request.body ?? {};
    const full = body.full === true;
    const recomputeOnly = body.recompute === true;
    if (full && recomputeOnly) {
      return reply.code(400).send({
        error: "Pilih salah satu: hitung ulang kunci SKU atau tarik ulang penuh.",
      });
    }

    // The recompute never speaks to the ERP, so an ERP that is down or not
    // configured is no reason to refuse it — it is precisely the repair that
    // still works in that state. Every other mode needs the ERP.
    if (!hasErp && !recomputeOnly) return reply.code(503).send({ error: "ERP tidak terhubung." });

    const actor = optStr(request.body?.actor);
    if ((full || recomputeOnly) && !actor) {
      return reply.code(400).send({ error: "Nama petugas wajib diisi." });
    }

    const worker = await loadSyncWorker();
    if (!worker) return reply.code(503).send({ error: "Sinkronisasi ERP belum tersedia." });

    const rows = await loadSyncState(db);
    if (rows.some((r) => r.running)) {
      // AMENDMENT 8: one signal, not three. A refused kick is a 409, so a client
      // that only reads the status code cannot mistake it for one that started.
      // The body still carries started/running for the shipped page's toast.
      //
      // This is also the guard on the full re-sync: a scheduled tick in flight
      // refuses it HERE, before any cursor is cleared, and the worker refuses it
      // a second time under the row lock if the tick starts in between.
      return reply.code(409).send({
        error: full
          ? "Sinkronisasi sedang berjalan — tarik ulang penuh tidak bisa dimulai sekarang."
          : "Sinkronisasi sedang berjalan.",
        started: false,
        running: true,
        mode: full ? "full" : recomputeOnly ? "recompute" : "incremental",
        freshness: freshnessOf(rows),
      });
    }

    // ── The cheap repair. Awaited: it is two UPDATEs and no network, so the
    // operator gets the row count back instead of having to go and read a log.
    if (recomputeOnly) {
      if (!worker.recomputeSkuKeys) {
        return reply.code(503).send({ error: "Hitung ulang kunci SKU belum tersedia." });
      }
      request.log.info({ actor }, "sku_key recompute requested");
      let result: SkuKeyRecomputeResult;
      try {
        result = await worker.recomputeSkuKeys();
      } catch (err) {
        request.log.error({ err }, "sku_key recompute failed");
        return reply.code(500).send({ error: "Gagal menghitung ulang kunci SKU." });
      }
      if (!result.started) {
        return reply.code(409).send({
          error: "Sinkronisasi sedang berjalan.",
          started: false,
          running: true,
          mode: "recompute",
          freshness: freshnessOf(rows),
        });
      }
      return {
        started: true,
        running: false,
        mode: "recompute",
        ok: result.ok,
        updated: result.updated,
        tables: result.tables,
        duration_ms: result.durationMs,
        freshness: freshnessOf(rows),
      };
    }

    if (full) {
      request.log.warn({ actor }, "FULL erp re-sync requested — every cursor cleared, every row re-pulled");
    } else {
      request.log.info({ actor }, "manual erp sync requested");
    }

    // Fire and forget: the worker owns its own error handling and must never
    // throw out of an interval (§5), so a rejection here is logged and dropped.
    // A full re-sync takes minutes; waiting on it would hold the request open
    // past every sane proxy timeout, and the progress is in the logs and in
    // GET /api/stock/sync-status either way.
    void worker.runErpSyncOnce(full ? { full: true, actor } : undefined).catch((err: unknown) => {
      request.log.error({ err, full }, "manual erp sync failed");
    });

    return {
      started: true,
      running: true,
      mode: full ? "full" : "incremental",
      freshness: freshnessOf(rows),
    };
  });
}
