/**
 * Canonical SKU key (ST-R5.1) — the one join between ERP supply and ERP demand.
 *
 * WHY THIS EXISTS: mirrored Sales Order detail rows cannot be matched back to a
 * finished-goods roll by serial, so matching is by *product identity*, and that
 * identity has to be spelled the same way on both sides of the join or
 * `open_commitment` silently under-counts (CONTRACTS §1, ST-R5.1).
 *
 * ⚠️ THE COMPOSITION CHANGED ON 2026-09-11, against the verified Selaras API
 * documentation. The v1 key was `kode_barang|warna|th|p|l`, computed identically
 * on both sides. The verified column list for the SO detail table
 * (`tbl_1203_SOSalesOrderDetailNID`) has **no `kode_barang` and no `th`**: every
 * SO line keyed as `-|4|-|4880|1220` while its stock row keyed as
 * `ACP-4MM|4|0.3|4880|1220`, so NOTHING would ever have matched. That failure is
 * silent and it fails toward over-promising — open_commitment 0 for every SKU,
 * ATP equal to on-hand, the whole inventory reading as promiseable.
 *
 * The key is now built from columns that exist on BOTH sides:
 *
 *   meaning                      SO line tbl_1203        Live FG tbl_1210
 *   ─────────────────────────────────────────────────────────────────────
 *   product line                 brand                   brand
 *   colour id                    warna                   warna
 *   aluminium skin thickness     th_alu_skin             th
 *   total panel thickness        total_thickness_acp     t
 *   length                       p                       p
 *   width                        l                       l
 *
 * The two thickness rows are the judgement call in the whole remap, so they are
 * recorded as fact, not inference: **confirmed by the product owner on
 * 2026-09-11** — `th_alu_skin` (SO) and `th` (FG) are the aluminium skin, and
 * `total_thickness_acp` (SO) and `t` (FG) are the total panel. It is the same
 * split the 1.0 module already made (`num()` in `routes/stock.ts`: `th` =
 * aluminium 0.1–0.5, `mm` = panel 3/4). Do not re-litigate the semantics; only
 * real data disagreeing is grounds to revisit it.
 *
 * `kode_barang` still exists on the FG side and is still mirrored — for DISPLAY.
 * It is simply not part of the key, because the demand side has no such column.
 *
 * The canonical segment names below are the MIRROR's spelling, which each
 * adapter maps its own side onto (`SKU_SEGMENT_SOURCES`). `th` keeps its v1
 * name and its v1 meaning (aluminium skin); `th_panel` is new.
 *
 * The key is produced in exactly TWO places and nowhere else (invariant §7.4):
 *   - this file, `canonicalSkuKey()`                       (TypeScript)
 *   - `erp_sku_key(...)` in `db/migrateErpStock.ts`        (SQL)
 * `test/sku.test.ts` asserts the two agree for every fixture. If you change a
 * rule here, change it there in the same commit — same discipline as the
 * company-name normalizer (`util/company.ts` + its SQL twin).
 *
 * The segment list is STILL provisional: ST-R5.2 (fill/overlap validation
 * against live data) could not be run, so the new composition is verified
 * against the documented COLUMNS but not yet against real ROWS. That is why it
 * sits behind ONE function and ONE config knob (`STOCK_SKU_KEY_SEGMENTS`), and
 * why the sync worker now measures how much of the live demand actually matched
 * stock and shouts when most of it did not (`checkSkuKeyMatch()` in
 * `db/migrateErpStock.ts`).
 *
 * Pure module: no db, no http, no fastify. Safe to import from a test.
 */
import { config } from "../config.js";

export type SkuSegmentKind = "text" | "numeric";

/**
 * The segments a key may be composed of, and how each is normalized. This is the
 * shared definition the SQL side reads too — `migrateErpStock.ts` imports it so
 * the function body is generated from the same list, in the same order.
 */
export const SKU_SEGMENT_KINDS = {
  /** Product line. SO `brand`, FG `brand` — an id, with a `brand_text` twin for display. */
  brand: "text",
  /** Colour id into `tbl_1228_DBRMWarnaID` (e.g. 4 → "BLACK GALAXY"). Matching is by id. */
  warna: "text",
  /** Aluminium skin thickness (0.1–0.5). SO `th_alu_skin`, FG `th`. */
  th: "numeric",
  /** Total panel thickness (3/4). SO `total_thickness_acp`, FG `t`. */
  th_panel: "numeric",
  /** Length (mm). */
  p: "numeric",
  /** Width (mm). */
  l: "numeric",
} as const;

export type SkuSegmentName = keyof typeof SKU_SEGMENT_KINDS;

/**
 * v2 composition (2026-09-11, verified column lists):
 * `brand|warna|th|th_panel|p|l`.
 */
export const DEFAULT_SKU_SEGMENTS: readonly SkuSegmentName[] = [
  "brand",
  "warna",
  "th",
  "th_panel",
  "p",
  "l",
];

/**
 * Where each canonical segment comes from on each side of the join. The adapters
 * in `erp/selarasClient.ts` read their probe names from here rather than
 * spelling them again, so the two sides of the key cannot drift apart in a way
 * that silently stops demand matching supply.
 *
 * First name wins; the rest are tolerated spellings of the same column.
 */
export const SKU_SEGMENT_SOURCES: Record<
  SkuSegmentName,
  { readonly so_line: readonly string[]; readonly live_fg: readonly string[] }
> = {
  brand: { so_line: ["brand"], live_fg: ["brand"] },
  warna: { so_line: ["warna"], live_fg: ["warna"] },
  th: { so_line: ["th_alu_skin"], live_fg: ["th"] },
  th_panel: { so_line: ["total_thickness_acp"], live_fg: ["t"] },
  p: { so_line: ["p"], live_fg: ["p"] },
  l: { so_line: ["l"], live_fg: ["l"] },
};

/**
 * Spellings an operator might plausibly put in `STOCK_SKU_KEY_SEGMENTS`, mapped
 * onto the canonical name. The ERP's own column names are accepted (they are
 * what a reader of the API docs has in front of them), and so is the retired v1
 * `total_thickness_acp` spelling. An unknown name is still dropped.
 */
const SKU_SEGMENT_ALIASES: Record<string, SkuSegmentName> = {
  th_alu_skin: "th",
  th_alu: "th",
  total_thickness_acp: "th_panel",
  t: "th_panel",
  panel_thickness: "th_panel",
};

/** The separator. Never appears in a normalized segment (stripped by rule 2). */
export const SKU_SEGMENT_SEPARATOR = "|";

function isSkuSegmentName(v: string): v is SkuSegmentName {
  return Object.prototype.hasOwnProperty.call(SKU_SEGMENT_KINDS, v);
}

/**
 * Whitelist the configured segment names against the registry above. Unknown or
 * duplicated names are dropped rather than trusted — the resolved list is spliced
 * into the SQL function body at boot, so it must never carry free text.
 * An empty result falls back to the v1 composition.
 */
export function resolveSkuSegments(names: readonly string[]): readonly SkuSegmentName[] {
  const out: SkuSegmentName[] = [];
  for (const raw of names) {
    const lowered = raw.trim().toLowerCase();
    const name = isSkuSegmentName(lowered) ? lowered : SKU_SEGMENT_ALIASES[lowered];
    if (name !== undefined && !out.includes(name)) out.push(name);
  }
  return out.length > 0 ? out : DEFAULT_SKU_SEGMENTS;
}

/** The active composition for this process (ST-R5.2 knob). */
export const SKU_SEGMENTS: readonly SkuSegmentName[] = resolveSkuSegments(
  config.stock.skuKeySegments,
);

export type SkuValue = string | number | null | undefined;
export type SkuParts = Partial<Record<SkuSegmentName, SkuValue>>;

// ── Rule 2 helpers (text segments) ───────────────────────────────────────────
// Deliberately ASCII-only and collation-independent: the SQL twin uses
// translate() + explicit ASCII classes for exactly the same reason. Locale-aware
// upper()/\s would let 'ß' → 'SS' on one side and 'ß' → stripped on the other.
const TRIM_RE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;
const COLLAPSE_RE = /[ \t\n\r\f\v]+/g;
const STRIP_RE = /[^A-Z0-9 ./-]/g;
const LOWER_RE = /[a-z]/g;

function normalizeText(raw: string): string {
  const out = raw
    .replace(TRIM_RE, "")
    .replace(LOWER_RE, (c) => c.toUpperCase())
    .replace(COLLAPSE_RE, " ")
    .replace(STRIP_RE, "");
  // A segment that normalizes away entirely still occupies its position (rule 1
  // — positional integrity), so it degrades to the same placeholder as NULL.
  return out === "" ? "-" : out;
}

// ── Rule 3 helpers (numeric segments) ────────────────────────────────────────
// Round to 2 dp, render with no trailing zeros: 0.50 → "0.5", 1220.00 → "1220".
//
// The arithmetic is done on the DECIMAL STRING, not on the double, because the
// SQL twin rounds a Postgres `numeric` — exact decimal, half away from zero.
// `Math.round(x * 100) / 100` and `toFixed(2)` both round the binary double and
// disagree with Postgres on ties (1.005 → "1.00" in V8, 1.01 in Postgres).
const NUMERIC_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function incrementDigits(digits: string): string {
  const out = digits.split("");
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const d = out[i];
    if (d === undefined) break;
    if (d === "9") {
      out[i] = "0";
      continue;
    }
    out[i] = String(Number(d) + 1);
    return out.join("");
  }
  return `1${out.join("")}`;
}

/** Expand `1.5e3` / `1.5e-3` into a plain `{ neg, int, frac }` decimal. */
function toPlainDecimal(raw: string): { neg: boolean; int: string; frac: string } | null {
  if (!NUMERIC_RE.test(raw)) return null;
  let s = raw;
  let neg = false;
  const sign = s.charAt(0);
  if (sign === "+" || sign === "-") {
    neg = sign === "-";
    s = s.slice(1);
  }
  let exp = 0;
  const e = s.search(/[eE]/);
  if (e !== -1) {
    exp = Number.parseInt(s.slice(e + 1), 10);
    s = s.slice(0, e);
  }
  const dot = s.indexOf(".");
  let int = dot === -1 ? s : s.slice(0, dot);
  let frac = dot === -1 ? "" : s.slice(dot + 1);
  if (int === "") int = "0";
  if (exp > 0) {
    const take = Math.min(exp, frac.length);
    int += frac.slice(0, take) + "0".repeat(exp - take);
    frac = frac.slice(take);
  } else if (exp < 0) {
    const shift = -exp;
    if (int.length > shift) {
      frac = int.slice(int.length - shift) + frac;
      int = int.slice(0, int.length - shift);
    } else {
      frac = "0".repeat(shift - int.length) + int + frac;
      int = "0";
    }
  }
  return { neg, int, frac };
}

function normalizeNumeric(raw: string): string | null {
  const parsed = toPlainDecimal(raw);
  if (!parsed) return null;
  const keep = parsed.frac.slice(0, 2).padEnd(2, "0");
  const next = parsed.frac.charAt(2);
  // Half away from zero, on the decimal digits — matches Postgres round(numeric, 2).
  let scaled = parsed.int + keep;
  if (next !== "" && next >= "5") scaled = incrementDigits(scaled);
  const intPart = (scaled.slice(0, scaled.length - 2) || "0").replace(/^0+(?=\d)/, "");
  const fracPart = scaled.slice(scaled.length - 2).replace(/0+$/, "");
  const body = fracPart === "" ? intPart : `${intPart}.${fracPart}`;
  // Postgres numeric has no negative zero; neither do we.
  const isZero = intPart === "0" && fracPart === "";
  return parsed.neg && !isZero ? `-${body}` : body;
}

/**
 * CONTRACTS §1 `normalizeSegment(v)`:
 *  1. null / undefined / '' → '-' (never drop a segment; positional integrity).
 *  2. text: trim → upper → collapse internal whitespace → strip outside [A-Z0-9 .-/].
 *  3. numeric: round to 2 dp, no trailing zeros. Non-numeric input → rule 2.
 */
export function normalizeSegment(value: SkuValue, kind: SkuSegmentKind = "text"): string {
  if (value === null || value === undefined) return "-";
  const raw = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value);
  if (raw === "") return "-";
  if (kind === "numeric") {
    const n = normalizeNumeric(raw.replace(TRIM_RE, ""));
    if (n !== null) return n;
  }
  return normalizeText(raw);
}

/**
 * `sku_key = segments.map(normalizeSegment).join('|')` — CONTRACTS §1.
 * Must stay byte-identical to `erp_sku_key(...)` in `db/migrateErpStock.ts`.
 */
export function canonicalSkuKey(
  parts: SkuParts,
  segments: readonly SkuSegmentName[] = SKU_SEGMENTS,
): string {
  return segments
    .map((name) => normalizeSegment(parts[name], SKU_SEGMENT_KINDS[name]))
    .join(SKU_SEGMENT_SEPARATOR);
}
