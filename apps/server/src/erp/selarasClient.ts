/**
 * Selaras ERP REST client (CONTRACTS §5, ST-R6).
 *
 * ⚠️ REMAPPED 2026-09-11 against the VERIFIED Selaras API documentation. What is
 * now fact rather than assumption:
 *
 *   - base URL `https://selaras2.io/kencana/api` (the `/api` suffix belongs in
 *     SELARAS_BASE_URL). `https://selaras2.io/kencana/table_documentation` is the
 *     human-facing documentation SPA, NOT the API root — pointing the env var at
 *     it is the obvious wrong turn and costs twenty minutes.
 *   - rows come from `GET <base>/table/{table}` — NOT `GET <base>/{table}`.
 *     `GET <base>/tables` lists the tables and `GET <base>/table/{table}/columns`
 *     returns a schema; neither is needed by the sync, both are worth knowing.
 *   - auth is the header pair `X-Secret-Key` / `X-Secret-Token` (preferred), or
 *     `?secret_key=` / `?secret_token=` as query params.
 *   - the envelope is `{ success, table, meta: { count, total, total_pages, page,
 *     limit, offset, order_by, order_dir, filters }, data: [...] }` — assumption
 *     A1 was right, so the tolerant reader stays, plus `success === false` now
 *     fails the page.
 *   - every table carries `deleted_at`; a non-null value means the row is gone.
 *   - upserts key on `{table}_id`, e.g. `tbl_1203_SOSalesOrderDetailNID_id`.
 *
 * Everything this module believes about the wire format is still deliberately
 * concentrated here:
 *
 *   - ONE `adaptRow` per mirrored table (`adaptSoHeaderRow`, `adaptSoLineRow`,
 *     `adaptLiveFgRow`). The sync worker never touches a raw ERP field name.
 *   - ONE envelope reader (`readEnvelope`) that ASSUMES A1
 *     (`{ data: [...], meta: { page, total_pages } }`) but TOLERATES the common
 *     alternatives instead of throwing, and logs once — clearly — when what came
 *     back is not what we assumed. That log line is what a human uses to correct
 *     A1 in thirty seconds.
 *   - ONE endpoint map (`SELARAS_ENDPOINTS`) from our logical table name to the
 *     ERP table name the PRD cites.
 *
 * When the real shape lands, the correction is a diff in this file alone.
 *
 * SECRET HANDLING (invariant §7.9): `config.selarasToken` must never reach a log
 * line, an error message or an HTTP response. The usual leak is an error object
 * that stringifies its request options, so this module NEVER stringifies a raw
 * error — it extracts `name`/`message`/`code` and pushes the result through
 * `redactSecrets()` before it is allowed anywhere near a console.
 *
 * Transport posture matches `packages/core/src/fetchPage.ts`: undici, explicit
 * per-request timeout, one retry with backoff, and a resolved result object
 * rather than a thrown transport error — a bad ERP page must never crash a run.
 */
import { request, type Dispatcher } from "undici";
import { config } from "../config.js";
import { canonicalSkuKey, SKU_SEGMENT_SOURCES } from "./sku.js";

// ── Logical tables ───────────────────────────────────────────────────────────

/**
 * The mirrored tables, in the order a run must process them (§5): the colour
 * master first (it is small and everything else displays through it), then
 * headers before lines because lines reference them, and live_fg LAST so
 * on-hand is the freshest half of the ATP subtraction.
 */
export const SYNC_TABLES = ["warna", "so_header", "so_line", "live_fg"] as const;
export type SelarasTable = (typeof SYNC_TABLES)[number];

/**
 * Logical name → ERP table name. VERIFIED 2026-09-11: the table names were
 * already right; the path shape was not — rows come from `<base>/table/<name>`.
 */
export const SELARAS_ENDPOINTS: Record<SelarasTable, string> = {
  warna: "tbl_1228_DBRMWarnaID",
  so_header: "tbl_1202_SOSalesOrderNID",
  so_line: "tbl_1203_SOSalesOrderDetailNID",
  live_fg: "tbl_1210_STLiveFGMX",
};

/**
 * The path segment rows are read from. `GET <base>/table/{table}`, with
 * `<base>/tables` and `<base>/table/{table}/columns` as the two sibling
 * endpoints the sync does not use.
 */
const TABLE_PATH = "table";

/**
 * The primary key column, per the documented `{table}_id` convention — e.g.
 * `tbl_1203_SOSalesOrderDetailNID_id`. Derived from the endpoint map rather than
 * spelled out, so the two can never drift apart.
 */
export function primaryKeyField(table: SelarasTable): string {
  return `${SELARAS_ENDPOINTS[table]}_id`;
}

// ── Mirrored row shapes (exactly the columns migrateErpStock.ts defines) ─────

/**
 * Every mirrored row carries the ERP's soft-delete marker (verified: EVERY table
 * has `deleted_at`). A non-null value means the row is DELETED upstream: the
 * worker does not mirror it and removes it from the mirror if it is already
 * there. It is never a mirror column — a deleted row simply is not in the
 * mirror — which is why it sits on this base type and not in any insert list.
 */
export interface MirrorRowBase {
  /** Non-null ⇒ deleted upstream. Routine deletions come through here (FIX 6). */
  deleted_at: Date | null;
}

export interface SoHeaderRow extends MirrorRowBase {
  id: string;
  so_number: string | null;
  customer_name_text: string | null;
  sales_name_text: string | null;
  po_date: string | null; // 'YYYY-MM-DD'; the column is `date`
  status_order: string | null;
  erp_updated_at: Date | null;
}

/**
 * The demand side. NOTE what is absent: `kode_barang` and a bare `th`, neither
 * of which exists on `tbl_1203`. The identity columns are the mirror's canonical
 * six, mapped from the SO table's own spellings by `SKU_SEGMENT_SOURCES`.
 */
export interface SoLineRow extends MirrorRowBase {
  id: string;
  so_id: string | null;
  brand: string | null;
  brand_text: string | null;
  warna: string | null;
  warna_text: string | null;
  th: number | null;       // aluminium skin  ← tbl_1203.th_alu_skin
  th_panel: number | null; // total panel     ← tbl_1203.total_thickness_acp
  p: number | null;
  l: number | null;
  qty_order: number | null;
  qty_delivered: number | null;
  qty_balance: number;
  status_order: string | null;
  approval: string | null;
  auto_approval: string | null;
  estimate_delivery: string | null; // 'YYYY-MM-DD'; the column is `date`
  sn_fg: string | null;
  sku_key: string;
  erp_updated_at: Date | null;
}

export interface LiveFgRow extends MirrorRowBase {
  /** The mirror's primary key: the ERP row id (`tbl_1210_STLiveFGMX_id`). */
  erp_row_id: string;
  /**
   * The ERP's ROLL SERIAL — what PPIC reads off the physical panel and what
   * `/api/stock/sku/:sku_key` shows in `on_hand_rows[]`. Not the primary key
   * (the spec keys every table on `{table}_id`) and not part of the SKU key
   * (SO lines carry `sn_fg = NULL`, which is why the join is by product
   * identity at all). Nullable, because a row may not have one.
   */
  sn_fg: string | null;
  /** Display only. The SO side has no such column, so it is NOT in the key. */
  kode_barang: string | null;
  brand: string | null;
  brand_text: string | null;
  warna: string | null;
  warna_text: string | null;
  th: number | null;       // aluminium skin  ← tbl_1210.th
  th_panel: number | null; // total panel     ← tbl_1210.t
  p: number | null;
  l: number | null;
  qty: number;
  qty_m2: number | null;
  buffer_qty: number | null;
  buffer_status: string | null;
  lokasi: string | null;
  sku_key: string;
  erp_updated_at: Date | null;
}

/** The colour master `tbl_1228_DBRMWarnaID` — 273 rows, `warna` 4 = BLACK GALAXY. */
export interface WarnaRow extends MirrorRowBase {
  id: string;
  /** The colour code a mirrored `warna` carries — the master's own, else the id. */
  code: string;
  /** That code as a number, so a mirrored '004' still finds a master '4'. */
  code_num: number | null;
  rm_warna: string | null;
  erp_updated_at: Date | null;
}

/** Maps a logical table to the row type its adapter produces. */
export interface SelarasRowByTable {
  warna: WarnaRow;
  so_header: SoHeaderRow;
  so_line: SoLineRow;
  live_fg: LiveFgRow;
}

// ── Secret redaction (invariant §7.9) ────────────────────────────────────────

/** Long enough that scrubbing it cannot blank out ordinary words. */
const MIN_SECRET_LEN = 6;

function secretValues(): string[] {
  const out: string[] = [];
  for (const s of [
    config.selarasToken,
    config.selarasSecretKey,
    config.selarasSecretToken,
    config.databaseUrl,
  ]) {
    if (typeof s === "string" && s.length >= MIN_SECRET_LEN) out.push(s);
  }
  return out;
}

/**
 * Turn an unknown throwable into text WITHOUT stringifying the object. undici
 * and Node errors routinely hang the request options (headers included, and the
 * bearer token with them) off the error; `String(err)` / `JSON.stringify(err)` /
 * `util.inspect(err)` are all leaks waiting to happen. Only name, message and
 * the errno code are ever read.
 */
function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    const base = err.message || err.name;
    return code ? `${base} (${code})` : base;
  }
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "boolean") return String(err);
  return "unknown error";
}

/**
 * Last line of defence before any string reaches a log or a response: scrub the
 * literal secret values, plus anything that merely *looks* like a credential
 * (an `Authorization: Bearer …`, a `?token=` query param) in case a future edit
 * introduces a leak this module does not know about.
 */
export function redactSecrets(input: unknown): string {
  let s = typeof input === "string" ? input : errorText(input);
  for (const secret of secretValues()) s = s.split(secret).join("***");
  s = s.replace(/(bearer\s+)[^\s"',;)}\]]+/gi, "$1***");
  s = s.replace(/(authorization"?\s*[:=]\s*"?)[^\s"',;)}\]]+/gi, "$1***");
  s = s.replace(
    /([?&](?:token|access_token|api_key|apikey|key|secret|secret_key|secret_token)=)[^&\s]+/gi,
    "$1***",
  );
  // Both placements' CONFIGURED names are redacted — query mode puts the pair on
  // the URL (the single most likely thing to reach a log line) and header mode
  // can still have a header name echoed back in an error body.
  for (const name of [
    config.selarasKeyParam,
    config.selarasTokenParam,
    config.selarasKeyHeader,
    config.selarasTokenHeader,
  ]) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) continue;
    s = s.replace(new RegExp(`([?&]${name}=)[^&\\s]+`, "gi"), "$1***");
    s = s.replace(new RegExp(`("?${name}"?\\s*[:=]\\s*"?)[^\\s"',;)}\\]]+`, "gi"), "$1***");
  }
  return s;
}

// ── Envelope handling (A1, and the tolerated alternatives) ───────────────────

/**
 * The verified envelope's row key. A1 turned out to be RIGHT — the real body is
 * `{ success, table, meta: { count, total, total_pages, page, limit, offset,
 * order_by, order_dir, filters }, data: [...] }` — so the reader keeps its
 * tolerance (it costs nothing and a second ERP endpoint may differ) and the
 * `matchedAssumption` flag now means "matched the verified shape".
 */
const ASSUMED_ROWS_KEY = "data";

/** Keys that have been seen to carry the row array in REST envelopes. */
const ROW_KEYS = ["data", "results", "items", "rows", "records", "list"] as const;

/** Keys that carry a page count directly. */
const TOTAL_PAGES_KEYS = ["total_pages", "totalPages", "pages", "page_count", "pageCount", "last_page", "lastPage"] as const;

/** Keys that carry a ROW count, from which a page count can be derived. */
const TOTAL_ROWS_KEYS = ["total", "count", "total_count", "totalCount", "total_rows", "totalRows", "recordsTotal"] as const;

export interface SelarasEnvelope {
  rows: unknown[];
  /**
   * The verified envelope carries a top-level `success`. `false` means the ERP
   * refused the request even under a 200, so the page must FAIL rather than be
   * read as "no new rows" — which would advance the cursor past data we never
   * saw. `null` when the body carries no such field (a bare array, say).
   */
  success: boolean | null;
  /** Total pages when the ERP told us, else null — then paging stops on a short page. */
  totalPages: number | null;
  /** Human-readable description of the shape actually observed (for the notice). */
  shape: string;
  /** True when the envelope matched assumption A1 exactly. */
  matchedAssumption: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Read a page envelope defensively.
 *
 * Assumes A1 (`{ data: [...], meta: { page, total_pages } }`) and accepts, in
 * order: a bare array, `results`/`items`/`rows`/`records`/`list`, a page count
 * under any of several spellings at `meta.*` or top level, and a ROW count
 * (`total`/`count`/…) from which the page count is derived using `limit`.
 *
 * NEVER throws: an unreadable body yields zero rows and a shape notice, because
 * a mis-guessed envelope must degrade into "no new data" (the old mirror stays
 * readable, ST-R7), not into a crashed sync worker.
 */
export function readEnvelope(body: unknown, limit: number): SelarasEnvelope {
  if (Array.isArray(body)) {
    return { rows: body, success: null, totalPages: null, shape: "bare array (no envelope)", matchedAssumption: false };
  }
  if (!isRecord(body)) {
    return { rows: [], success: null, totalPages: null, shape: `non-object body (${typeof body})`, matchedAssumption: false };
  }
  const success = typeof body["success"] === "boolean" ? body["success"] : null;

  let rows: unknown[] = [];
  let rowsKey: string | null = null;
  for (const key of ROW_KEYS) {
    const v = body[key];
    if (Array.isArray(v)) {
      rows = v;
      rowsKey = key;
      break;
    }
  }
  // `{ data: { items: [...] } }` — one level of nesting is common enough to absorb.
  if (rowsKey === null && isRecord(body["data"])) {
    const inner = body["data"];
    for (const key of ROW_KEYS) {
      const v = inner[key];
      if (Array.isArray(v)) {
        rows = v;
        rowsKey = `data.${key}`;
        break;
      }
    }
  }

  const meta = isRecord(body["meta"])
    ? body["meta"]
    : isRecord(body["pagination"])
      ? body["pagination"]
      : body;

  let totalPages: number | null = null;
  let metaKey: string | null = null;
  for (const key of TOTAL_PAGES_KEYS) {
    const n = positiveInt(meta[key]);
    if (n !== null) {
      totalPages = n;
      metaKey = key;
      break;
    }
  }
  if (totalPages === null) {
    for (const key of TOTAL_ROWS_KEYS) {
      const n = positiveInt(meta[key]);
      if (n !== null) {
        totalPages = limit > 0 ? Math.max(1, Math.ceil(n / limit)) : null;
        metaKey = `${key} (rows → pages)`;
        break;
      }
    }
  }

  const matchedAssumption =
    rowsKey === ASSUMED_ROWS_KEY && isRecord(body["meta"]) && metaKey === "total_pages";

  const shapeParts = [
    rowsKey === null ? `no row array (keys: ${Object.keys(body).slice(0, 8).join(", ") || "none"})` : `rows at '${rowsKey}'`,
    metaKey === null ? "no page/row count" : `page count from '${metaKey}'`,
  ];
  return { rows, success, totalPages, shape: shapeParts.join("; "), matchedAssumption };
}

// One notice per distinct (table, shape) per process. Loud enough to act on,
// quiet enough not to drown the log every 3 minutes for the next six months.
const noticedShapes = new Set<string>();

/** Test seam: forget which shape notices have already been emitted. */
export function resetShapeNotices(): void {
  noticedShapes.clear();
}

function noticeShape(table: SelarasTable, env: SelarasEnvelope): void {
  if (env.matchedAssumption) return;
  const key = `${table}:${env.shape}`;
  if (noticedShapes.has(key)) return;
  noticedShapes.add(key);
  console.warn(
    `[selaras] response envelope for '${table}' is NOT the verified shape ` +
      `{ success, table, meta: { total_pages, ... }, data: [...] } — observed: ${env.shape}. ` +
      `Parsing continued with a tolerated alternative, so rows were still read. If this is what ` +
      `the API really sends now, correct readEnvelope() in erp/selarasClient.ts. ` +
      `(An ERP-reported failure is NOT this: success:false has its own message.)`,
  );
}

// ── Auth failures get their own unmistakable line ────────────────────────────
//
// A 401 is the single most likely first-run failure: the credential pair is
// wrong, absent, or in the wrong placement (header vs query). Buried inside a
// generic "HTTP 401 from ERP" it reads like any other transport hiccup and the
// sync simply looks stale. Once per process, per table, it says what to check.

const noticedAuthFailures = new Set<string>();

/** Test seam: forget which auth failures have already been announced. */
export function resetAuthNotices(): void {
  noticedAuthFailures.clear();
}

function noticeAuthFailure(table: SelarasTable, status: number): void {
  const key = `${table}:${status}`;
  if (noticedAuthFailures.has(key)) return;
  noticedAuthFailures.add(key);
  const mode = config.selarasAuthMode;
  const names =
    mode === "header" ? `${config.selarasKeyHeader} / ${config.selarasTokenHeader} (headers)`
    : mode === "query" ? `${config.selarasKeyParam} / ${config.selarasTokenParam} (query params)`
    : "Authorization: Bearer (legacy single-token mode)";
  console.error(
    `[selaras] ERP REJECTED OUR CREDENTIALS — HTTP ${status} on '${table}'. NOTHING will sync until ` +
      `this is fixed: the mirror keeps serving whatever it already holds and every stock figure ` +
      `ages from here. Auth mode '${mode}' is sending ${names}. Verified 2026-09-11: Selaras wants ` +
      `X-Secret-Key + X-Secret-Token as headers, or ?secret_key= + ?secret_token= as query params. ` +
      `Check SELARAS_SECRET_KEY / SELARAS_SECRET_TOKEN are both set (values never logged), that ` +
      `SELARAS_AUTH_MODE matches how they were issued, and that SELARAS_BASE_URL is the API root ` +
      `(…/kencana/api) and not the table_documentation page.`,
  );
}

/**
 * A 4xx, described so the log says what to do about it. 401/403 additionally get
 * the dedicated line above; 400 is what an unknown filter column returns, which
 * is the other realistic first-run fault.
 */
/** The failure kind for an HTTP status the ERP answered with. */
function failureKind(status: number): SelarasFailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "server";
  if (status >= 400) return "erp_error";
  return "other";
}

function describeClientError(table: SelarasTable, status: number): string {
  if (status === 401 || status === 403) {
    noticeAuthFailure(table, status);
    return `HTTP ${status} from ERP — credentials rejected (auth mode '${config.selarasAuthMode}'); see the [selaras] line above`;
  }
  if (status === 400) {
    return `HTTP 400 from ERP — the request was refused, most likely an unknown filter or order_by column for '${SELARAS_ENDPOINTS[table]}' (GET <base>/table/${SELARAS_ENDPOINTS[table]}/columns lists them)`;
  }
  if (status === 404) {
    return `HTTP 404 from ERP — no such endpoint. Rows come from <base>/table/${SELARAS_ENDPOINTS[table]}; check SELARAS_BASE_URL ends at /api`;
  }
  return `HTTP ${status} from ERP`;
}

/**
 * `success: false` under a 200 (FIX 5). Treated as a FAILED page, never as an
 * empty one: an empty page would advance the cursor past rows we never saw, and
 * the mirror would keep a stale commitment forever with nothing in the log.
 */
function successFailure(table: SelarasTable, env: SelarasEnvelope): string {
  void env;
  return (
    `ERP answered 200 with success=false for '${SELARAS_ENDPOINTS[table]}' — the ERP itself refused ` +
    `the request, so the page fetched nothing, the cursor stays put and nothing was mirrored. This ` +
    `is an ERP-side error, NOT a client shape problem: check the ERP, not the envelope reader`
  );
}

// ── Field access: casing- and separator-tolerant (A2) ────────────────────────

/**
 * Fold a raw row into a lookup keyed by `lowercase, alphanumerics only`, so
 * `kode_barang`, `kodeBarang`, `KodeBarang`, `KODE_BARANG` and `Kode Barang`
 * all answer to the same probe. Field casing is unverified (HANDOVER §2); this
 * makes the adapters indifferent to it instead of wrong about it.
 */
function foldKeys(raw: Record<string, unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [k, v] of Object.entries(raw)) {
    const folded = k.toLowerCase().replace(/[^a-z0-9]/g, "");
    // First spelling wins, so an exact snake_case key is never shadowed later.
    if (!out.has(folded)) out.set(folded, v);
  }
  return out;
}

function pick(row: Map<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    const v = row.get(n.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

function asText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

// ── Numeric parsing, and the separator ambiguity (A22) ──────────────────────
//
// THE PROBLEM, and why there is no clever parser that solves it:
//
//   "1.234"  means 1234 in Indonesian notation and 1.234 in English notation.
//   "0.350"  is a genuine thickness of 0.35 that the Indonesian rule reads as 350.
//
// Both strings are ambiguous in isolation. This is not hypothetical for this
// company: `num()` in `routes/stock.ts` parses PPIC's own Excel as id-locale
// ("dot = thousands separator, comma = decimal", PRD §8.4) and getting it wrong
// was a real bug, fixed in fc4ab5a. If Selaras emits the same convention and we
// read it as English, a stock quantity is wrong BY A FACTOR OF 1000, silently,
// with no error anywhere — the worst failure this module can produce.
//
// So the shape is classified structurally (locale-independent) and only then
// resolved by the declared `SELARAS_NUMBER_FORMAT`:
//
//   both '.' and ',' present  → the LAST separator is the decimal in either
//                               convention. Unambiguous.
//   one separator, repeated   → must be grouping. Unambiguous.
//   one separator, once, and
//     exactly 3 digits after
//     and 1-3 digits before   → could be grouping OR a decimal. AMBIGUOUS.
//   anything else             → cannot be grouping. Decimal. Unambiguous.
//
// Under `auto` an ambiguous string is REFUSED (null, or 0 for the two not-null
// columns), counted, and logged. A refused quantity reserves nothing; a guessed
// one can over- or under-promise by 1000×. Under `id` or `en` the operator has
// told us the emitter and the value is read accordingly.

export type NumberFormat = "auto" | "id" | "en";

export interface NumberReading {
  value: number | null;
  /** True only when the string was genuinely ambiguous AND the mode is `auto`. */
  ambiguous: boolean;
  /**
   * X11: the token was NaN / ±Infinity, or a finite-looking token that overflowed
   * to one. Distinguished from merely unreadable because it is far more alarming —
   * see `isNonFiniteToken()` for why it must never reach the mirror.
   */
  nonFinite: boolean;
}

const UNREADABLE: NumberReading = { value: null, ambiguous: false, nonFinite: false };
const NON_FINITE: NumberReading = { value: null, ambiguous: false, nonFinite: true };

/** `NaN`, `Infinity`, `-inf`, … in any casing. Postgres `numeric` accepts these. */
const NON_FINITE_TOKEN_RE = /^(nan|inf|infinity)$/i;
/** A plain integer, optionally with an exponent. No separators by this point. */
const PLAIN_INT_RE = /^\d+(?:[eE][+-]?\d+)?$/;

function finite(n: number, neg: boolean): NumberReading {
  // Every caller has already validated the digit shape, so a non-finite result
  // here can only be an overflow ("1e999"), never unparseable text.
  if (!Number.isFinite(n)) return NON_FINITE;
  return { value: neg ? -n : n, ambiguous: false, nonFinite: false };
}

function countOf(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n += 1;
  return n;
}

/**
 * Read one numeric token. Exported because the ambiguity rule is the whole point
 * of A22 and deserves to be tested directly, mode by mode, rather than only
 * through an adapter.
 *
 * Returns `null` rather than `NaN` for anything unreadable: `NaN` would reach
 * Postgres as the literal `NaN` and poison a `numeric` column.
 */
export function parseErpNumber(v: unknown, mode: NumberFormat = config.selarasNumberFormat): NumberReading {
  if (typeof v === "number") {
    return Number.isFinite(v) ? { value: v, ambiguous: false, nonFinite: false } : NON_FINITE;
  }
  if (typeof v !== "string") return UNREADABLE;

  let s = v.trim();
  if (s === "") return UNREADABLE;
  let neg = false;
  const sign = s.charAt(0);
  if (sign === "+" || sign === "-") {
    neg = sign === "-";
    s = s.slice(1);
  }

  const dots = countOf(s, ".");
  const commas = countOf(s, ",");

  // No separator at all — including exponent forms. Nothing to disambiguate.
  if (dots === 0 && commas === 0) {
    if (NON_FINITE_TOKEN_RE.test(s)) return NON_FINITE; // "NaN" / "Infinity" (X11)
    if (!PLAIN_INT_RE.test(s)) return UNREADABLE; // ordinary garbage text
    return finite(Number(s), neg);
  }

  // Both separators present: the last one is the decimal and the other is
  // grouping, in BOTH conventions. "1.234,50" and "1,234.50" are both 1234.5.
  if (dots > 0 && commas > 0) {
    const decSep = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const grpSep = decSep === "." ? "," : ".";
    if (countOf(s, decSep) !== 1) return UNREADABLE; // two decimal points: malformed
    const normalized = s.split(grpSep).join("").replace(decSep, ".");
    if (!/^\d*\.\d+$/.test(normalized)) return UNREADABLE;
    return finite(Number(normalized), neg);
  }

  const sep = dots > 0 ? "." : ",";
  const parts = s.split(sep);

  // Repeated separator ⇒ it can only be grouping ("1.234.567").
  if (parts.length > 2) {
    const head = parts[0] ?? "";
    const valid = /^\d{1,3}$/.test(head) && parts.slice(1).every((p) => /^\d{3}$/.test(p));
    return valid ? finite(Number(parts.join("")), neg) : UNREADABLE;
  }

  const head = parts[0] ?? "";
  const tail = parts[1] ?? "";
  if (!/^\d*$/.test(head) || !/^\d+$/.test(tail)) return UNREADABLE; // e.g. "1.2a"

  // Grouping is always exactly three digits after a separator, and at most three
  // before it. Fail either and the separator can only be a decimal point.
  const couldBeGrouping = /^\d{1,3}$/.test(head) && tail.length === 3;
  if (!couldBeGrouping) return finite(Number(`${head || "0"}.${tail}`), neg);

  // Genuinely ambiguous. Only a declared locale resolves it.
  switch (mode) {
    case "id":
      // id: dot = thousands, comma = decimal. "1.234" → 1234, "1,234" → 1.234.
      return sep === "." ? finite(Number(head + tail), neg) : finite(Number(`${head || "0"}.${tail}`), neg);
    case "en":
      // en: comma = thousands, dot = decimal. "1,234" → 1234, "1.234" → 1.234.
      return sep === "," ? finite(Number(head + tail), neg) : finite(Number(`${head || "0"}.${tail}`), neg);
    case "auto":
      return { value: null, ambiguous: true, nonFinite: false };
  }
}

/**
 * Per-page tally of refused-because-ambiguous tokens. A module-level collector is
 * safe because adaptation is a single synchronous loop inside `fetchPage()` —
 * it is installed and torn down around that loop, never held across an await.
 */
export interface AmbiguityTally {
  count: number;
  /** Up to three raw tokens, redacted. Never a whole row. */
  samples: string[];
}

const MAX_AMBIGUITY_SAMPLES = 3;

interface PageTally {
  ambiguous: AmbiguityTally;
  nonFinite: AmbiguityTally;
  /** Date/timestamp values that were present and unreadable (the zero date). */
  badDates: AmbiguityTally;
}

let tally: PageTally | null = null;

function note(into: AmbiguityTally, raw: unknown): void {
  into.count += 1;
  const token = redactSecrets(typeof raw === "string" ? raw : String(raw)).slice(0, 40);
  if (into.samples.length < MAX_AMBIGUITY_SAMPLES && !into.samples.includes(token)) {
    into.samples.push(token);
  }
}

/**
 * Nullable numeric column. THE ONLY WAY a numeric reaches a mirrored row.
 *
 * Two classes of value are refused here rather than written through:
 *
 *  - AMBIGUOUS (A22): "1.234" is 1234 or 1.234 depending on the emitter's locale.
 *    Refused under `auto`, counted, logged.
 *
 *  - NON-FINITE (X11): `'NaN'::numeric` and `'Infinity'::numeric` are LEGAL
 *    values in Postgres and the frozen schema does not forbid them in `th`/`p`/`l`.
 *    If one were stored, `erp_sku_key()` would render the literal text `NaN` while
 *    `canonicalSkuKey()` renders `'-'` — the two key implementations would disagree
 *    (invariant §7.4) and that SKU's commitments would silently stop matching its
 *    stock. The parity test would not catch it, because the divergence is created
 *    at WRITE time, not by either key function. Keeping the value out of the mirror
 *    entirely is better than teaching two functions to agree about a value that
 *    should never have been stored.
 */
function asNumber(v: unknown): number | null {
  const read = parseErpNumber(v);
  if (tally) {
    if (read.ambiguous) note(tally.ambiguous, v);
    else if (read.nonFinite) note(tally.nonFinite, v);
  }
  return read.value;
}

/**
 * Numeric with a floor: `qty` / `qty_balance` are `not null` in the schema, and
 * 0 is the safe refusal — it reserves nothing and promises nothing.
 */
function asNumberOr(v: unknown, fallback: number): number {
  return asNumber(v) ?? fallback;
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;
const ISO_DATE_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})[T ]/;
const NAIVE_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * THE BUG THIS EXISTS TO KILL (production, so_header, every run for months):
 *
 *   MySQL stores an UNSET date as `0000-00-00` / `0000-00-00 00:00:00`. It is not
 *   rare — it is what older `tbl_1202_SOSalesOrderNID` rows carry in `po_date`.
 *   It matches `DATE_ONLY_RE` perfectly, so a shape-only check waved it straight
 *   through as a well-formed 'YYYY-MM-DD' string. postgres.js then looked up the
 *   parameter's real type from Postgres (`po_date` is `date`, OID 1082) and
 *   applied its `date` serializer, which is literally
 *
 *       serialize: x => (x instanceof Date ? x : new Date(x)).toISOString()
 *
 *   `new Date('0000-00-00')` is Invalid Date, so `.toISOString()` threw
 *   `RangeError: Invalid time value` during Bind — inside `commitPage`'s
 *   transaction. The page rolled back, the whole so_header pass aborted, and the
 *   cursor stayed pinned at the last good run. FOREVER: a cursor only moves
 *   forward, and this table's never moved at all.
 *
 * So shape is not enough. A date is only accepted if it denotes a REAL calendar
 * day that `new Date()` can also parse — which is the actual contract the write
 * path has with postgres.js. Anything else is refused: null out, count it, log
 * once per table per run with examples (`badDates`), exactly the posture
 * `asNumber()` already takes for NaN/Infinity. Never fabricated, never "now".
 */
function realCalendarDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  // Year 0 is MySQL's zero date; years 1-99 are refused too, because `Date.UTC()`
  // maps them into the 1900s and no ERP row legitimately carries one.
  if (y < 100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  // `Date.UTC` rolls 2026-02-31 forward to 2026-03-03 rather than refusing it;
  // anything that moved was not a real day.
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** 'YYYY-MM-DD' for a real day, or null. Parts arrive as captured strings. */
function dateOnlyFrom(y: string | undefined, m: string | undefined, d: string | undefined): string | null {
  if (!y || !m || !d) return null;
  const yy = Number(y);
  const mm = Number(m);
  const dd = Number(d);
  if (!realCalendarDate(yy, mm, dd)) return null;
  return `${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/**
 * A refusal that is DISTINGUISHABLE from an absent value. `null`, `undefined` and
 * a blank string are simply "the ERP has no date here" — `po_date` is nullable
 * and a null is routine, so counting one would be noise. `bad: true` is reserved
 * for a value that was PRESENT and could not be read.
 */
interface DateReading<T> {
  value: T | null;
  bad: boolean;
}

const ABSENT = { value: null, bad: false } as const;
const BAD = { value: null, bad: true } as const;

function readDateOnly(v: unknown): DateReading<string> {
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? BAD : { value: v.toISOString().slice(0, 10), bad: false };
  }
  const s = asText(v);
  if (s === null) return ABSENT;

  const iso = DATE_ONLY_RE.exec(s);
  if (iso) {
    const out = dateOnlyFrom(iso[1], iso[2], iso[3]);
    return out === null ? BAD : { value: out, bad: false }; // '0000-00-00' lands here
  }
  const prefix = ISO_DATE_PREFIX_RE.exec(s);
  if (prefix) {
    const out = dateOnlyFrom(prefix[1], prefix[2], prefix[3]);
    return out === null ? BAD : { value: out, bad: false }; // '0000-00-00 00:00:00' too
  }
  const dmy = DMY_RE.exec(s);
  if (dmy) {
    // A17: day-first, the Indonesian convention.
    const out = dateOnlyFrom(dmy[3], dmy[2], dmy[1]);
    return out === null ? BAD : { value: out, bad: false };
  }
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? BAD : { value: parsed.toISOString().slice(0, 10), bad: false };
}

/**
 * `date` columns (`po_date`, `estimate_delivery`) are handed to Postgres as a
 * 'YYYY-MM-DD' string, never as a JS Date — a Date would be converted through
 * the process timezone and can land a day early or late. Accepts ISO date,
 * ISO timestamp (date part taken) and dd/mm/yyyy (A17: day-first, the Indonesian
 * convention; an ISO string is always preferred when both could parse).
 *
 * An unreadable value is NULL in the mirror and one tick on the `badDates`
 * tally. It is never guessed at and never replaced with today — a fabricated
 * date is worse than a missing one, because nothing downstream can tell.
 */
function asDateOnly(v: unknown): string | null {
  const read = readDateOnly(v);
  if (read.bad && tally) note(tally.badDates, v);
  return read.value;
}

function readTimestamp(v: unknown): DateReading<Date> {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? BAD : { value: v, bad: false };
  if (typeof v === "number") {
    // Seconds vs milliseconds epoch: anything below ~Sep 2001 in ms is seconds.
    const ms = v < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? BAD : { value: d, bad: false };
  }
  const s = asText(v);
  if (s === null) return ABSENT;

  // Reject the zero date on its SHAPE before `new Date()` ever sees it, so the
  // refusal is the same whether it arrives as a date or as a timestamp.
  const iso = DATE_ONLY_RE.exec(s) ?? ISO_DATE_PREFIX_RE.exec(s);
  if (iso && dateOnlyFrom(iso[1], iso[2], iso[3]) === null) return BAD;

  let norm = s;
  if (DATE_ONLY_RE.test(s)) norm = `${s}T00:00:00Z`;
  else if (NAIVE_TIMESTAMP_RE.test(s)) norm = `${s.replace(" ", "T")}Z`;
  const d = new Date(norm);
  return Number.isNaN(d.getTime()) ? BAD : { value: d, bad: false };
}

/**
 * `timestamptz` columns (`erp_updated_at`, and the `deleted_at` marker) — the
 * sync cursor is read from `erp_updated_at`, so a bad parse must yield null
 * (the cursor does not advance) rather than an Invalid Date, which postgres.js
 * would reject mid-batch and take the whole run down with it.
 *
 * A18: a timestamp with no zone designator is read as UTC, not as local time.
 * `new Date('2026-09-11 14:05:00')` is LOCAL in V8, which would shift every
 * cursor by the container's offset; appending 'Z' pins it.
 */
function asTimestamp(v: unknown): Date | null {
  const read = readTimestamp(v);
  if (read.bad && tally) note(tally.badDates, v);
  return read.value;
}

/** The ERP's `updated_at`, under every spelling we are prepared to see (A2). */
function pickUpdatedAt(row: Map<string, unknown>): Date | null {
  return asTimestamp(pick(row, "updated_at", "updatedAt", "last_update", "lastUpdate", "modified_at", "tgl_update"));
}

/** The six product-identity fields, already typed for both the row and the key. */
interface IdentityFields {
  brand: string | null;
  warna: string | null;
  th: number | null;
  th_panel: number | null;
  p: number | null;
  l: number | null;
}

/** The `_text` display twins, which are NOT part of the key (they are names). */
interface IdentityTextFields {
  brand_text: string | null;
  warna_text: string | null;
}

/**
 * Read the key's six segments for ONE side of the join.
 *
 * The probe names come from `SKU_SEGMENT_SOURCES` in erp/sku.ts rather than
 * being spelled again here, because the two sides diverging is precisely the bug
 * this remap exists to fix: the SO table has `th_alu_skin` / `total_thickness_acp`
 * where the FG table has `th` / `t`, and both must land on the same mirror
 * column or demand stops matching supply — silently, and in the direction that
 * over-promises.
 *
 * Nothing outside `SKU_SEGMENT_SOURCES[*][side]` is probed: a fallback to "try
 * `th` on the SO side too" would resurrect exactly the wrong-column bug.
 */
function skuParts(row: Map<string, unknown>, side: "so_line" | "live_fg"): IdentityFields {
  const read = (segment: keyof IdentityFields): unknown =>
    pick(row, ...SKU_SEGMENT_SOURCES[segment][side]);
  return {
    brand: asText(read("brand")),
    warna: asText(read("warna")),
    th: asNumber(read("th")),
    th_panel: asNumber(read("th_panel")),
    p: asNumber(read("p")),
    l: asNumber(read("l")),
  };
}

/**
 * `brand` and `warna` are IDs; the ERP carries a `_text` twin for each, which is
 * what a human should read. Preferred for display, never used for matching.
 */
function identityText(row: Map<string, unknown>): IdentityTextFields {
  return {
    brand_text: asText(pick(row, "brand_text")),
    warna_text: asText(pick(row, "warna_text")),
  };
}

/** The soft-delete marker every table carries (FIX 6). */
function pickDeletedAt(row: Map<string, unknown>): Date | null {
  return asTimestamp(pick(row, "deleted_at", "deletedAt"));
}

// ── adaptRow, one per table (the single place the wire format is believed) ───

/**
 * Every adapter returns `null` for a row it cannot key, and NEVER throws: a
 * malformed row is dropped (and counted) rather than allowed to abort a page.
 * Losing one unkeyable row is recoverable on the next sync; losing the run is
 * not (ST-R7).
 */
function rowMap(raw: unknown): Map<string, unknown> | null {
  return isRecord(raw) ? foldKeys(raw) : null;
}

export function adaptSoHeaderRow(raw: unknown): SoHeaderRow | null {
  const row = rowMap(raw);
  if (!row) return null;
  const id = asText(pick(row, ...pkNames("so_header")));
  if (id === null) return null; // no primary key ⇒ nothing to upsert onto
  return {
    id,
    so_number: asText(pick(row, "so_number", "soNumber", "no_so", "nomor_so", "no_order")),
    customer_name_text: asText(pick(row, "customer_name_text", "customer_name", "customer", "nama_customer", "nama_pelanggan")),
    sales_name_text: asText(pick(row, "sales_name_text", "sales_name", "sales", "nama_sales")),
    po_date: asDateOnly(pick(row, "po_date", "poDate", "tgl_po", "tanggal_po", "order_date")),
    status_order: asText(pick(row, "status_order", "statusOrder", "status")),
    erp_updated_at: pickUpdatedAt(row),
    deleted_at: pickDeletedAt(row),
  };
}

export function adaptSoLineRow(raw: unknown): SoLineRow | null {
  const row = rowMap(raw);
  if (!row) return null;
  const id = asText(pick(row, ...pkNames("so_line")));
  if (id === null) return null;
  const parts = skuParts(row, "so_line");
  return {
    id,
    so_id: asText(pick(row, "so_id", "soId", "header_id", "id_so", "parent_id", `${SELARAS_ENDPOINTS.so_header}_id`)),
    ...parts,
    ...identityText(row),
    qty_order: asNumber(pick(row, "qty_order", "qtyOrder", "qty", "qty_so")),
    qty_delivered: asNumber(pick(row, "qty_delivered", "qtyDelivered", "qty_kirim", "qty_deliver")),
    // `not null default 0` in the schema, and it drives the liveness predicate:
    // an unreadable balance must read as 0 (reserves nothing) rather than NULL.
    qty_balance: asNumberOr(pick(row, "qty_balance", "qtyBalance", "qty_sisa", "sisa", "outstanding"), 0),
    status_order: asText(pick(row, "status_order", "statusOrder", "status")),
    approval: asText(pick(row, "approval", "approval_status", "approved")),
    auto_approval: asText(pick(row, "auto_approval", "autoApproval", "auto_approve")),
    estimate_delivery: asDateOnly(pick(row, "estimate_delivery", "estimateDelivery", "eta", "tgl_kirim", "estimasi_kirim")),
    sn_fg: asText(pick(row, "sn_fg", "snFg", "serial")), // observed NULL in practice (ST-R5.1)
    sku_key: canonicalSkuKey(parts),
    erp_updated_at: pickUpdatedAt(row),
    deleted_at: pickDeletedAt(row),
  };
}

export function adaptLiveFgRow(raw: unknown): LiveFgRow | null {
  const row = rowMap(raw);
  if (!row) return null;
  const rowId = asText(pick(row, ...pkNames("live_fg")));
  if (rowId === null) return null;
  const parts = skuParts(row, "live_fg");
  return {
    erp_row_id: rowId,
    // The serial is read from its own column and kept as its own column. It used
    // to BE the primary key, which quietly threw the real serial away and showed
    // an operator a row id where they expect FG-AAA-0001.
    sn_fg: asText(pick(row, "sn_fg", "snFg", "serial", "serial_number")),
    // Display only (§FIX 1): there is no `kode_barang` on the demand side, so it
    // can never be part of the key — but it is what PPIC calls the product.
    kode_barang: asText(pick(row, "kode_barang", "kodeBarang", "kode")),
    ...parts,
    ...identityText(row),
    // Canonical unit is lembar (A4, ST-R5.4); qty_m2 is display only.
    qty: asNumberOr(pick(row, "qty", "qty_lembar", "quantity", "stock"), 0),
    qty_m2: asNumber(pick(row, "qty_m2", "qtyM2", "m2", "qty_meter", "luas")),
    buffer_qty: asNumber(pick(row, "buffer_qty", "bufferQty")),
    buffer_status: asText(pick(row, "buffer_status", "bufferStatus")),
    lokasi: asText(pick(row, "lokasi", "location", "gudang", "warehouse")),
    sku_key: canonicalSkuKey(parts),
    erp_updated_at: pickUpdatedAt(row),
    deleted_at: pickDeletedAt(row),
  };
}

/**
 * The colour master. `warna` on the two mirrored tables is an ID into this
 * table — 273 rows, `warna = 4` is "BLACK GALAXY" — so this is what turns a "4"
 * on screen into a colour name. Matching still happens on the id (FIX 7).
 */
export function adaptWarnaRow(raw: unknown): WarnaRow | null {
  const row = rowMap(raw);
  if (!row) return null;
  const id = asText(pick(row, ...pkNames("warna")));
  if (id === null) return null;
  // The code a mirrored row's `warna` actually carries. The master may publish
  // it as its own column (`warna_code`); where it does not, the row id IS the
  // code. Both are kept, plus a numeric form, because '004' and '4' are the same
  // colour and the normalization rule belongs in one place — here.
  const code = asText(pick(row, "warna_code", "kode_warna_id", "code")) ?? id;
  const numeric = parseErpNumber(code, "en");
  return {
    id,
    code,
    code_num: numeric.value,
    rm_warna: asText(pick(row, "rm_warna", "rmWarna", "warna_text", "nama_warna", "warna")),
    erp_updated_at: pickUpdatedAt(row),
    deleted_at: pickDeletedAt(row),
  };
}

const ADAPTERS: { [K in SelarasTable]: (raw: unknown) => SelarasRowByTable[K] | null } = {
  warna: adaptWarnaRow,
  so_header: adaptSoHeaderRow,
  so_line: adaptSoLineRow,
  live_fg: adaptLiveFgRow,
};

// ── Primary keys ─────────────────────────────────────────────────────────────

/**
 * The tolerated spellings of a table's primary key, DOCUMENTED NAME FIRST.
 *
 * `{table}_id` (e.g. `tbl_1203_SOSalesOrderDetailNID_id`) is what the verified
 * documentation says a row is upserted by, and it is derived from
 * `SELARAS_ENDPOINTS` so it cannot drift from the endpoint it belongs to. The
 * older guesses stay behind it as fallbacks: they cost nothing, and a mirror
 * seeded before the remap keys the same way.
 */
const PK_FALLBACKS: Record<SelarasTable, readonly string[]> = {
  warna: ["id", "warna_id", "nid"],
  so_header: ["id", "so_id", "nid", "id_so", "soid"],
  so_line: ["id", "detail_id", "nid", "id_detail", "so_detail_id"],
  live_fg: ["sn_fg", "snFg", "serial", "serial_number", "id"],
};

function pkNames(table: SelarasTable): string[] {
  return [primaryKeyField(table), ...PK_FALLBACKS[table]];
}

/**
 * The ERP field the reconciliation sweep asks for as a projection, per table —
 * the documented primary key, which is also the first thing every adapter picks.
 */
export const SELARAS_KEY_FIELDS: Record<SelarasTable, string> = {
  warna: primaryKeyField("warna"),
  so_header: primaryKeyField("so_header"),
  so_line: primaryKeyField("so_line"),
  live_fg: primaryKeyField("live_fg"),
};

/**
 * The primary key of a RAW row, read through exactly the same tolerant `pick()`
 * name list the adapters use — because a key set that spelled the key
 * differently from the adapter would mark live rows as deleted and purge them.
 * The two agree by construction: both call `pkNames()`.
 */
export function extractRowKey(table: SelarasTable, raw: unknown): string | null {
  const row = rowMap(raw);
  if (!row) return null;
  return asText(pick(row, ...pkNames(table)));
}

/** True when a RAW row is soft-deleted upstream (FIX 6). */
export function isRowDeleted(raw: unknown): boolean {
  const row = rowMap(raw);
  return row !== null && pickDeletedAt(row) !== null;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 64 * 1024 * 1024; // a 1,000-row page of wide rows, with room
const DEFAULT_RETRY_DELAY_MS = 500;

export interface FetchPageOptions {
  /** Cursor: only rows with `updated_at >= since`. Null ⇒ full pull. */
  since?: Date | null;
  /** 1-based page number (PRD §4). */
  page: number;
  /** `limit` query param. */
  limit: number;
  /** Test seam: undici dispatcher (MockAgent) so tests never touch a network. */
  dispatcher?: Dispatcher;
  /** Test seam: backoff before the single retry. */
  retryDelayMs?: number;
}

export interface SelarasPage<T> {
  rows: T[];
  /** Rows the ERP returned before adaptation — `rows.length` may be smaller. */
  rawCount: number;
  /** Rows dropped by the adapter because they had no usable primary key. */
  dropped: number;
  /**
   * Numeric strings refused as ambiguous under `SELARAS_NUMBER_FORMAT=auto`
   * (A22). The worker sums these across a table's pages and logs once per run —
   * that one line turns "ATP is mysteriously 1000× off" into a 30-second fix.
   */
  ambiguousNumbers: AmbiguityTally;
  /** Numerics refused for being NaN / ±Infinity (X11). Never written through. */
  nonFiniteNumbers: AmbiguityTally;
  /**
   * Date/timestamp values that were PRESENT and unreadable — MySQL's
   * `0000-00-00` zero date above all. Refused to NULL rather than handed to
   * postgres.js, whose `date` serializer calls `.toISOString()` on them and
   * throws `RangeError: Invalid time value` mid-transaction, aborting the run.
   * A blank or absent value is not counted here: that is a missing date, not a
   * broken one.
   */
  badDates: AmbiguityTally;
  page: number;
  /** Null when the ERP did not tell us; then paging stops on a short page. */
  totalPages: number | null;
}

/**
 * WHY a page failed, as a value rather than a sentence (FIX D).
 *
 * The stock pages need to tell an operator "wait" from "call IT", and an auth
 * failure is the one where those differ completely — it is also the likeliest
 * first-run outcome. Classifying by grepping `last_error` for /HTTP 401/ works
 * only until someone rewords a message, and then the page silently downgrades to
 * "sync failing" and tells people to wait for something that will never fix
 * itself. So the kind travels with the failure and is stored beside it.
 */
export type SelarasFailureKind =
  /** 401/403 — the credential pair is wrong, absent, or in the wrong placement. */
  | "auth"
  /** Transport: timeout, DNS, reset, TLS. Usually transient. */
  | "network"
  /** A 2xx body we could not read as JSON (a login page, an HTML error). */
  | "shape"
  /** The ERP answered, understood us, and refused (a 4xx, or success:false). */
  | "erp_error"
  /** A 5xx, after the one retry. */
  | "server"
  | "other";

export type SelarasResult<T> =
  | { ok: true; page: SelarasPage<T> }
  | { ok: false; error: string; status: number | null; kind: SelarasFailureKind; retryable: boolean };

// ── The cursor's datetime grammar (FIX A) ───────────────────────────────────
//
// THE FAILURE THIS PREVENTS, because it is silent and permanent:
//
// The verified documentation spells datetimes `YYYY-MM-DD` or
// `YYYY-MM-DD HH:mm:ss`, in **WIB (UTC+7)**. It says nothing about ISO-8601.
// This client used to send `2026-09-02T03:00:00.000Z`. Three things could
// happen, and only the third is dangerous:
//   1. the ERP honours the `Z`                        → correct;
//   2. the ERP rejects it                             → a 400, loud, diagnosable;
//   3. the ERP parses it and DISCARDS the offset, reading 03:00Z as 03:00 WIB →
//      the cursor sits SEVEN HOURS AHEAD of where it belongs. Every row updated
//      in that window is skipped, and because a cursor only ever moves forward
//      no later run revisits them. Nothing logs. ATP is quietly wrong for every
//      SKU whose commitment landed in a skipped window.
//
// So we send exactly what is documented, rather than hoping the parser is
// liberal — and we subtract a lookback wide enough to absorb a whole misread
// timezone anyway (STOCK_SYNC_LOOKBACK_MINUTES, 12h by default > the 7h offset).
// Re-fetching costs nothing: every write is an idempotent upsert keyed on the
// ERP's primary key, which is the property that makes this free.

const WIB_OFFSET_MINUTES = 7 * 60;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** `YYYY-MM-DD HH:mm:ss` in WIB — the documented grammar, and nothing else. */
export function formatErpDatetime(instant: Date): string {
  const wib = new Date(instant.getTime() + WIB_OFFSET_MINUTES * 60_000);
  return (
    `${wib.getUTCFullYear()}-${pad(wib.getUTCMonth() + 1)}-${pad(wib.getUTCDate())} ` +
    `${pad(wib.getUTCHours())}:${pad(wib.getUTCMinutes())}:${pad(wib.getUTCSeconds())}`
  );
}

/**
 * The exact `updated_at__gte` value a request will carry, cursor and lookback
 * included. Exported so the sync worker can LOG it verbatim on the first page of
 * each table: the grammar question above is answerable from one real log line,
 * and unanswerable by inference.
 */
export function cursorParam(since: Date | null | undefined): string | null {
  if (!since) return null;
  const minutes = config.stock.syncLookbackMinutes > 0 ? config.stock.syncLookbackMinutes : 0;
  const lookbackMs = minutes * 60_000;
  return formatErpDatetime(new Date(since.getTime() - lookbackMs));
}

/**
 * `<base>/table/<erp table>` — VERIFIED 2026-09-11. It is NOT `<base>/<table>`,
 * which is what this client sent before the documentation arrived and what would
 * have 404'd on the first real request. Trailing slashes on the base are
 * stripped, so both `…/kencana/api` and `…/kencana/api/` work.
 */
function tableUrl(table: SelarasTable): string {
  const base = config.selarasBaseUrl.replace(/\/+$/, "");
  return `${base}/${TABLE_PATH}/${SELARAS_ENDPOINTS[table]}`;
}

/**
 * `?updated_at__gte=<cursor>&order_by=updated_at&order_dir=asc&limit=N&page=P`
 * exactly as PRD §4 states (A2).
 *
 * NOTE the `__gte` (not `__gt`): the boundary row is deliberately re-fetched on
 * every run. Two rows can share an `updated_at` and straddle a page boundary, so
 * a strict `>` cursor would silently skip one. Re-fetching is free because every
 * write is an idempotent upsert keyed on the ERP primary key (§5) — there is no
 * delta path anywhere, which is precisely what makes this safe.
 */
export function buildPageUrl(table: SelarasTable, opts: { since?: Date | null; page: number; limit: number }): string {
  const url = new URL(tableUrl(table));
  const since = cursorParam(opts.since);
  if (since !== null) url.searchParams.set("updated_at__gte", since);
  url.searchParams.set("order_by", "updated_at");
  url.searchParams.set("order_dir", "asc");
  url.searchParams.set("limit", String(opts.limit));
  url.searchParams.set("page", String(opts.page));
  applyQueryAuth(url);
  return url.toString();
}

/**
 * Credentials in the query string, when `SELARAS_AUTH_MODE=query`.
 *
 * Kept in one function so that a URL carrying secrets is produced in exactly one
 * place — which is also why `redactSecrets()` strips these parameter names: a
 * URL is the single most likely thing to end up in a log line or an error.
 */
export function applyQueryAuth(url: URL): void {
  if (config.selarasAuthMode !== "query") return;
  if (config.selarasSecretKey) url.searchParams.set(config.selarasKeyParam, config.selarasSecretKey);
  if (config.selarasSecretToken) url.searchParams.set(config.selarasTokenParam, config.selarasSecretToken);
}

/**
 * The reconciliation sweep's URL: the FULL current key set, so no cursor, and a
 * `fields=<pk>` projection hint so the ERP can answer cheaply.
 *
 * `fields` is documented as a query parameter but we have never seen it honoured
 * on real data (selaras2.io is unreachable from here). It is a harmless
 * unknown query param if unsupported, and `fetchKeyPage()` reports which of the
 * two actually happened so the log says it plainly rather than pretending.
 */
export function buildKeyPageUrl(table: SelarasTable, opts: { page: number; limit: number }): string {
  const url = new URL(tableUrl(table));
  url.searchParams.set("fields", SELARAS_KEY_FIELDS[table]);
  url.searchParams.set("order_by", SELARAS_KEY_FIELDS[table]);
  url.searchParams.set("order_dir", "asc");
  applyQueryAuth(url);
  url.searchParams.set("limit", String(opts.limit));
  url.searchParams.set("page", String(opts.page));
  return url.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) resolve();
    else setTimeout(resolve, ms).unref?.();
  });
}

interface RawResponse {
  status: number;
  body: unknown;
}

/**
 * A 2xx body that is not JSON. Carries only a length — never the body — because
 * an auth-failure page routinely echoes the credential it rejected (§7.9).
 */
class BodyNotJsonError extends Error {
  constructor(readonly bytes: number) {
    super(`ERP returned a non-JSON body (${bytes} bytes)`);
    this.name = "BodyNotJsonError";
  }
}

async function requestOnce(url: string, timeoutMs: number, dispatcher?: Dispatcher): Promise<RawResponse> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "kencana-leadscout/1.0 (stock-sync)",
  };
  // Bearer auth (§5). The token exists in exactly this one expression; it is
  // never interpolated into a URL, a log line or an error message.
  // Auth (§5). Selaras issues a key + token PAIR, so a single bearer credential
  // cannot authenticate against it; `bearer` is kept only for the pre-Selaras
  // shape. Every credential reference in this file is inside this one block.
  if (config.selarasAuthMode === "bearer") {
    if (config.selarasToken) headers["authorization"] = `Bearer ${config.selarasToken}`;
  } else if (config.selarasAuthMode === "header") {
    // VERIFIED: the HEADERS are `X-Secret-Key` / `X-Secret-Token` — NOT the query
    // parameter names lower-cased, which is what this used to send (`secret_key:`)
    // and is a guaranteed 401 on the first real request. Each placement now has
    // its own configured name; undici lower-cases header names anyway, and HTTP
    // header names are case-insensitive, so `x-secret-key` is on the wire.
    if (config.selarasSecretKey) headers[config.selarasKeyHeader.toLowerCase()] = config.selarasSecretKey;
    if (config.selarasSecretToken) headers[config.selarasTokenHeader.toLowerCase()] = config.selarasSecretToken;
  }
  // `query` mode puts them on the URL — see applyQueryAuth().

  const res = await request(url, {
    method: "GET",
    headers,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    ...(dispatcher ? { dispatcher } : {}),
  });

  res.body.on("error", () => {}); // a destroyed undici body emits a benign abort

  if (res.statusCode >= 400) {
    res.body.destroy();
    return { status: res.statusCode, body: null };
  }

  let received = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of res.body) {
    const buf = chunk as Buffer;
    received += buf.length;
    if (received > MAX_BODY_BYTES) {
      res.body.destroy();
      throw new Error(`response body exceeded ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return { status: res.statusCode, body: null };
  try {
    return { status: res.statusCode, body: JSON.parse(text) as unknown };
  } catch {
    // Deliberately NOT rethrowing the parser's own message: V8 embeds a prefix
    // of the offending body in it, and an auth-error body can quote the bearer
    // token back at us. The byte count is all a human needs to diagnose this.
    throw new BodyNotJsonError(text.length);
  }
}

/**
 * Fetch one page of one table. RESOLVES ALWAYS — a transport failure comes back
 * as `{ ok: false }`, matching the `packages/core/src/fetchPage.ts` posture, so
 * an ERP outage is data to the worker rather than an exception to survive.
 *
 * One retry with backoff on 5xx and network errors; no retry on 4xx (§5) — a
 * 401/404 is a configuration fault and hammering it twice fixes nothing.
 */
export async function fetchPage<K extends SelarasTable>(
  table: K,
  opts: FetchPageOptions,
): Promise<SelarasResult<SelarasRowByTable[K]>> {
  const url = buildPageUrl(table, opts);
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let last: { error: string; status: number | null; kind: SelarasFailureKind; retryable: boolean } = {
    error: "no attempt made",
    status: null,
    kind: "other",
    retryable: false,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(retryDelayMs * attempt);
    try {
      const res = await requestOnce(url, config.selarasTimeoutMs, opts.dispatcher);
      if (res.status >= 500) {
        last = { error: `HTTP ${res.status} from ERP`, status: res.status, kind: "server", retryable: true };
        continue;
      }
      if (res.status >= 400) {
        // 4xx is terminal for this run: no retry (§5).
        return {
          ok: false,
          error: describeClientError(table, res.status),
          status: res.status,
          kind: failureKind(res.status),
          retryable: false,
        };
      }

      const env = readEnvelope(res.body, opts.limit);
      if (env.success === false) {
        // FIX C: checked BEFORE the shape notice. A well-formed `{success:false}`
        // error body is not the A1 shape (it has no meta.total_pages), so the
        // envelope warning used to fire and send an operator to
        // erp/selarasClient.ts at the exact moment the problem is at the ERP.
        // Not retryable either: the ERP understood us and said no.
        return {
          ok: false,
          error: successFailure(table, env),
          status: res.status,
          kind: "erp_error",
          retryable: false,
        };
      }
      noticeShape(table, env);

      const adapt = ADAPTERS[table];
      const rows: SelarasRowByTable[K][] = [];
      let dropped = 0;
      // Install the ambiguity collector around the SYNCHRONOUS adapt loop only.
      const pageTally: PageTally = {
        ambiguous: { count: 0, samples: [] },
        nonFinite: { count: 0, samples: [] },
        badDates: { count: 0, samples: [] },
      };
      tally = pageTally;
      try {
        for (const raw of env.rows) {
          let adapted: SelarasRowByTable[K] | null = null;
          try {
            adapted = adapt(raw);
          } catch {
            // An adapter is written not to throw; if one ever does, the row is
            // dropped, not the page (a malformed row never kills a run).
            adapted = null;
          }
          if (adapted === null) dropped += 1;
          else rows.push(adapted);
        }
      } finally {
        tally = null;
      }
      return {
        ok: true,
        page: {
          rows,
          rawCount: env.rows.length,
          dropped,
          ambiguousNumbers: pageTally.ambiguous,
          nonFiniteNumbers: pageTally.nonFinite,
          badDates: pageTally.badDates,
          page: opts.page,
          totalPages: env.totalPages,
        },
      };
    } catch (err) {
      // redactSecrets() is applied HERE, at the boundary, so no caller can
      // accidentally log a raw undici error carrying the request options.
      const message = redactSecrets(err);
      // An unparseable body is a shape fault, not a transient blip — retrying
      // would only hide it. Everything else gets its one retry.
      const isShape = err instanceof BodyNotJsonError;
      last = { error: message, status: null, kind: isShape ? "shape" : "network", retryable: !isShape };
      if (isShape) break;
    }
  }

  return { ok: false, ...last };
}

// ── Key listing, for the reconciliation sweep ────────────────────────────────

export interface SelarasKeyPage {
  /** Primary keys on this page, in ERP order, unkeyable rows already dropped. */
  keys: string[];
  /** Rows the ERP returned before key extraction — `keys.length` may be smaller. */
  rawCount: number;
  /** Rows that carried no readable primary key. Counted, never guessed at. */
  dropped: number;
  page: number;
  totalPages: number | null;
  /**
   * True when every returned row carried ONLY the requested key field — i.e. the
   * `fields=` projection was actually honoured. False means the ERP ignored it
   * and sent whole rows: still correct, just expensive, and the worker says so.
   */
  projected: boolean;
}

export type SelarasKeyResult =
  | { ok: true; page: SelarasKeyPage }
  | { ok: false; error: string; status: number | null; kind: SelarasFailureKind; retryable: boolean };

/**
 * One page of the FULL current key set for a table. Same transport posture as
 * `fetchPage()` (one retry on 5xx/network, none on 4xx, redaction at the
 * boundary, resolves rather than rejects) — it is deliberately the same code
 * path with a different projection, not a second HTTP client.
 */
export async function fetchKeyPage(
  table: SelarasTable,
  opts: { page: number; limit: number; dispatcher?: Dispatcher; retryDelayMs?: number },
): Promise<SelarasKeyResult> {
  const url = buildKeyPageUrl(table, opts);
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let last: { error: string; status: number | null; kind: SelarasFailureKind; retryable: boolean } = {
    error: "no attempt made",
    status: null,
    kind: "other",
    retryable: false,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(retryDelayMs * attempt);
    try {
      const res = await requestOnce(url, config.selarasTimeoutMs, opts.dispatcher);
      if (res.status >= 500) {
        last = { error: `HTTP ${res.status} from ERP`, status: res.status, kind: "server", retryable: true };
        continue;
      }
      if (res.status >= 400) {
        return {
          ok: false,
          error: describeClientError(table, res.status),
          status: res.status,
          kind: failureKind(res.status),
          retryable: false,
        };
      }

      const env = readEnvelope(res.body, opts.limit);
      if (env.success === false) {
        return {
          ok: false,
          error: successFailure(table, env),
          status: res.status,
          kind: "erp_error",
          retryable: false,
        };
      }
      const keys: string[] = [];
      let dropped = 0;
      let projected = env.rows.length > 0;
      for (const raw of env.rows) {
        // A projected row carries one field; anything wider means `fields=` was
        // ignored. Checked before extraction so a dropped row still counts.
        if (!isRecord(raw) || Object.keys(raw).length !== 1) projected = false;
        // A soft-deleted row is NOT part of the current key set (FIX 6): leaving
        // it in would keep a deleted row alive in the mirror forever. Invisible
        // when `fields=` is honoured — a projected row carries the key alone —
        // which is fine: the incremental pull deletes it by `deleted_at` anyway.
        if (isRowDeleted(raw)) continue;
        const key = extractRowKey(table, raw);
        if (key === null) dropped += 1;
        else keys.push(key);
      }
      return {
        ok: true,
        page: { keys, rawCount: env.rows.length, dropped, page: opts.page, totalPages: env.totalPages, projected },
      };
    } catch (err) {
      const message = redactSecrets(err);
      const isShape = err instanceof BodyNotJsonError;
      last = { error: message, status: null, kind: isShape ? "shape" : "network", retryable: !isShape };
      if (isShape) break;
    }
  }

  return { ok: false, ...last };
}

/** The surface the sync worker depends on — lets a test inject a fake client. */
export interface SelarasClient {
  fetchPage<K extends SelarasTable>(table: K, opts: FetchPageOptions): Promise<SelarasResult<SelarasRowByTable[K]>>;
  fetchKeyPage(
    table: SelarasTable,
    opts: { page: number; limit: number; dispatcher?: Dispatcher; retryDelayMs?: number },
  ): Promise<SelarasKeyResult>;
}

export const selarasClient: SelarasClient = { fetchPage, fetchKeyPage };
