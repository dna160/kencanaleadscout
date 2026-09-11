/**
 * WP-7 · The TS↔SQL canonical-SKU-key parity test (CONTRACTS §1, invariant §7.4).
 *
 * WHY THIS IS THE MOST VALUABLE TEST IN THE BUILD: mirrored SO detail rows carry
 * `sn_fg = NULL`, so demand joins supply by `sku_key` and by nothing else. The key
 * is computed twice — `canonicalSkuKey()` on write (TypeScript, in the sync worker)
 * and `erp_sku_key(...)` on read (SQL, inside the commitment views). If the two
 * implementations ever diverge by a single byte, commitments stop matching stock:
 * `open_commitment` silently drops to zero for the affected SKUs and ATP goes
 * quietly, catastrophically high across the catalogue. Nothing else in the system
 * would raise an error. This test is the only thing standing between that change
 * and production.
 *
 * The parity assertions compare LIVE SQL OUTPUT against LIVE TS OUTPUT. There is
 * no hardcoded expected string anywhere in the parity block — a fixture whose
 * "expected" value was typed by hand would prove only that a human agreed with
 * themselves twice.
 *
 * DB-dependency: the SQL half needs Postgres. Without DATABASE_URL the parity
 * block SKIPS (it does not fail) — a red suite for an absent optional dependency
 * is noise, not signal. The pure-TS block always runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalSkuKey,
  normalizeSegment,
  resolveSkuSegments,
  DEFAULT_SKU_SEGMENTS,
  SKU_SEGMENTS,
  SKU_SEGMENT_KINDS,
  SKU_SEGMENT_SEPARATOR,
  type SkuParts,
  type SkuSegmentName,
  type SkuValue,
} from "../src/erp/sku.js";
import { closeDatabase, getSql } from "../src/db/client.js";
import { runErpStockMigrations } from "../src/db/migrateErpStock.js";

const hasDb = Boolean(process.env.DATABASE_URL);

// ── Fixture table ────────────────────────────────────────────────────────────
// One row = one (kode_barang, warna, th, p, l) tuple pushed through both
// implementations. `sqlUnreachable` marks a tuple the SQL side cannot physically
// receive, because the mirror columns for th/p/l are `numeric` and the value is
// not castable — those rows assert TS behaviour only, and the reason is recorded
// so the gap is visible rather than implied.

type Fixture = {
  readonly label: string;
  readonly parts: SkuParts;
  /** Non-empty ⇒ SQL cannot be handed this tuple; TS-only assertion + named gap. */
  readonly sqlUnreachable?: string;
};

/** Postgres' own numeric-literal grammar, minus NaN/Infinity (see §"known divergence"). */
const PG_NUMERIC_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function castableToNumeric(v: SkuValue): boolean {
  if (v === null || v === undefined) return true; // NULL is a legal numeric param
  if (typeof v === "number") return Number.isFinite(v);
  return PG_NUMERIC_LITERAL.test(v.trim());
}

const NUMERIC_SEGMENTS: readonly SkuSegmentName[] = (
  Object.keys(SKU_SEGMENT_KINDS) as SkuSegmentName[]
).filter((n) => SKU_SEGMENT_KINDS[n] === "numeric");

/** A fixture is SQL-reachable only if every numeric slot holds a castable value. */
function autoUnreachable(parts: SkuParts): string | undefined {
  for (const n of NUMERIC_SEGMENTS) {
    if (!castableToNumeric(parts[n])) {
      return `${n}=${JSON.stringify(parts[n])} is not castable to numeric; the mirror column is numeric, so this tuple can only arrive on the TS side`;
    }
  }
  return undefined;
}

function fx(label: string, parts: SkuParts): Fixture {
  const reason = autoUnreachable(parts);
  return reason ? { label, parts, sqlUnreachable: reason } : { label, parts };
}

const BASE: SkuParts = { kode_barang: "ACP-4MM", warna: "004", th: 0.3, p: 4880, l: 1220 };
const withTh = (th: SkuValue): SkuParts => ({ ...BASE, th });
const withKode = (kode_barang: SkuValue): SkuParts => ({ ...BASE, kode_barang });
const withWarna = (warna: SkuValue): SkuParts => ({ ...BASE, warna });

const FIXTURES: readonly Fixture[] = [
  // ── The PRD §5A subject itself ─────────────────────────────────────────────
  fx("PRD §5A Black Galaxy", BASE),
  fx("Black Galaxy, trailing-zero dimensions", {
    kode_barang: "ACP-4MM",
    warna: "004",
    th: "0.30",
    p: "4880.00",
    l: "1220.000",
  }),

  // ── Rule 1: positional integrity — every empty form collapses to '-' ───────
  fx("all NULL", { kode_barang: null, warna: null, th: null, p: null, l: null }),
  fx("all undefined (absent keys)", {}),
  fx("empty string kode", withKode("")),
  fx("empty string warna", withWarna("")),
  fx("whitespace-only kode (spaces)", withKode("   ")),
  fx("whitespace-only kode (tab/newline/CR)", withKode("\t\n\r ")),
  fx("whitespace-only kode (vertical tab + form feed)", withKode("\v\f")),
  fx("kode strips to nothing ('###')", withKode("###")),
  fx("kode strips to nothing (all punctuation)", withKode("@#$%^&*()_+=[]{}")),
  fx("warna strips to nothing", withWarna("***")),

  // ── Rule 2: trim → upper → collapse → strip, in that order ────────────────
  fx("lower case folds", withKode("acp-4mm")),
  fx("mixed case folds", withKode("AcP-4Mm")),
  fx("leading/trailing spaces trimmed", withKode("  ACP-4MM  ")),
  fx("internal runs collapse to one space", withKode("ACP    4MM")),
  fx("mixed whitespace kinds collapse", withKode("ACP \t\n 4MM")),
  fx("collapse happens before strip (space survives a stripped neighbour)", withKode("A #B")),
  fx("trailing space survives when its neighbour is stripped", withKode("A #")),
  fx("leading stripped char leaves no space", withKode("#A")),
  fx("allowed punctuation survives: . - /", withKode("A.B-C/D")),
  fx("digits survive", withKode("1234567890")),
  fx("underscore is stripped", withKode("ACP_4MM")),
  fx("comma is stripped", withKode("ACP,4MM")),
  fx("plus is stripped in a text segment", withKode("ACP+4MM")),
  fx("percent/star/quote stripped", withKode("A%B*C'D\"E")),
  fx("backslash stripped", withKode("A\\B")),
  fx("regex metacharacters in the value are data, not pattern", withKode("A.*B$C^D[E]F")),
  fx("SQL-ish payload is inert", withKode("'); drop table erp_so_line; --")),

  // ── The separator may never survive inside a segment (injection guard) ─────
  fx("literal | inside kode is stripped", withKode("AB|CD")),
  fx("literal | inside warna is stripped", withWarna("00|4")),
  fx("|-only segment degrades to '-'", withKode("|")),
  fx("many pipes", withKode("|||A|||B|||")),
  fx("a value that spells a whole key", withKode("ACP|004|0.3|4880|1220")),

  // ── Non-ASCII: BOTH sides fold case in ASCII only, deliberately (A10) ──────
  // upper()/\s are collation-dependent; 'ß' uppercases to 'SS' in JS and stays
  // put under the C locale. The contract's answer is to strip non-ASCII on both
  // sides, so these fixtures pin that agreement rather than the folding.
  fx("sharp s", withKode("ß")),
  fx("sharp s among ASCII", withKode("STRAßE")),
  fx("fi ligature", withKode("ﬁ")),
  fx("accented uppercase", withKode("ÉÀÜ")),
  fx("accented lowercase", withKode("éàü")),
  fx("Turkish dotted/dotless i", withKode("İı")),
  fx("Greek", withKode("ΣΊΓΜΑ")),
  fx("Cyrillic", withKode("ЖУК")),
  fx("CJK", withKode("黑銀河")),
  fx("emoji", withKode("A🙂B")),
  fx("non-breaking space is NOT whitespace to either side", withKode("A B")),
  fx("zero-width joiner is stripped", withKode("A‍B")),
  fx("combining acute is stripped, base letter survives", withKode("é")),
  fx("mixed script with ASCII survivors", withKode("ACP-Ω-4MM")),

  // ── Rule 3: rounding. Postgres round(numeric,2) is exact decimal, half away
  // from zero. Math.round / toFixed round the BINARY DOUBLE and disagree on ties
  // (1.005 → "1.00" in V8, 1.01 in Postgres). These are the fixtures that catch
  // a well-meaning "simplification" of the TS numeric path.
  fx("tie 1.005", withTh("1.005")),
  fx("tie 0.005", withTh("0.005")),
  fx("tie 0.125", withTh("0.125")),
  fx("tie 99.995 (carries into a new digit)", withTh("99.995")),
  fx("tie -0.005 (half away from zero, negative)", withTh("-0.005")),
  fx("tie 2.675 (the classic double-representation trap)", withTh("2.675")),
  fx("tie 8.835", withTh("8.835")),
  fx("tie 1.045", withTh("1.045")),
  fx("9.999 rounds up through the integer", withTh("9.999")),
  fx("-9.999 rounds away from zero", withTh("-9.999")),
  fx("999.999 cascades", withTh("999.999")),
  fx("below the tie stays down", withTh("0.004")),
  fx("-0.001 must not render as -0", withTh("-0.001")),
  fx("0.001 → 0", withTh("0.001")),
  fx("plain zero", withTh("0")),
  fx("negative zero literal", withTh("-0")),
  fx("negative zero as a JS number", withTh(-0)),
  fx("zero with scale", withTh("0.00")),

  // ── Rule 3: rendering forms ───────────────────────────────────────────────
  fx("trailing zeros dropped (0.50)", withTh("0.50")),
  fx("trailing zeros dropped (1220.00)", withTh("1220.00")),
  fx("integer rendering keeps all digits (1220 ≠ 122)", withTh("1220")),
  fx("integer ending in zeros", withTh("1000")),
  fx("leading zeros dropped (007)", withTh("007")),
  fx("leading zeros with a fraction (007.500)", withTh("007.500")),
  fx("bare leading point (.5)", withTh(".5")),
  fx("bare trailing point (5.)", withTh("5.")),
  fx("explicit plus sign", withTh("+5")),
  fx("negative fraction", withTh("-0.5")),
  fx("exponent form 1e3", withTh("1e3")),
  fx("exponent form 1E3 (capital)", withTh("1E3")),
  fx("exponent form 1.5e-3 (rounds to 0)", withTh("1.5e-3")),
  fx("exponent form 1.5e-1", withTh("1.5e-1")),
  fx("exponent form 1.005e0 (tie via exponent)", withTh("1.005e0")),
  fx("exponent form 1005e-3 (the same tie, written as an integer)", withTh("1005e-3")),
  fx("exponent form -1.005e2", withTh("-1.005e2")),
  fx("exponent with explicit plus", withTh("1.5e+2")),
  fx("tiny exponent 1e-9", withTh("1e-9")),
  fx("large exponent 1e9", withTh("1e9")),
  fx("value beyond IEEE-754 integer safety", withTh("12345678901234567890.125")),
  fx("many fraction digits", withTh("0.123456789012345678")),
  fx("surrounding whitespace on a numeric", withTh("  1.005  ")),
  fx("number (not string) input", withTh(0.3)),
  fx("number input needing rounding", withTh(1.239)),
  fx("large plain integer as number", withTh(1220)),

  // ── Rule 3 fallthrough: non-numeric in a numeric slot → rule 2 ────────────
  // SQL-unreachable by construction (the column is `numeric`) — asserted TS-side
  // only, and recorded as a named gap rather than silently skipped.
  fx("non-numeric th falls through to rule 2", withTh("ABC")),
  fx("empty-string th", withTh("")),
  fx("whitespace-only th", withTh("   ")),
  fx("th with a unit suffix", withTh("0.3mm")),
  fx("th with a thousands separator", withTh("1,220")),
  fx("th as a hex literal", withTh("0x10")),
  fx("th with a stray pipe", withTh("0.3|4")),

  // ── Cross-segment: the same digits distributed differently must not collide ─
  fx("dimension order matters (4880×1220)", { ...BASE, p: 4880, l: 1220 }),
  fx("dimension order matters (1220×4880)", { ...BASE, p: 1220, l: 4880 }),
  fx("kode/warna boundary is not smeared", { ...BASE, kode_barang: "ACP", warna: "4MM004" }),
  fx("kode/warna boundary, the other way", { ...BASE, kode_barang: "ACP4MM", warna: "004" }),

  // ── Realistic catalogue shapes ────────────────────────────────────────────
  fx("realistic ACP", { kode_barang: "ACP-3MM-PE", warna: "SILVER MET", th: 3, p: 4880, l: 1220 }),
  fx("realistic with spacing noise", {
    kode_barang: " acp-3mm-pe ",
    warna: "silver   met",
    th: "3.00",
    p: "4880",
    l: "1220",
  }),
  fx("long code", { ...BASE, kode_barang: "A".repeat(200) }),
];

// ── Deterministic fuzz ───────────────────────────────────────────────────────
// The hand-written table above encodes what we thought of. The fuzz covers what
// we did not. Seeded, so a failure is reproducible from the printed index.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_TEXT_ALPHABET = [
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."0123456789",
  ..." .-/",
  ..."|_,+*%@#$&()[]{}<>=?!:;'\"\\`~^",
  "\t", "\n", "\r", "\v", "\f",
  "ß", "ﬁ", "É", "à", "Ü", "İ", "ı", "Ω", "ж", "黑", "🙂", " ", "‍", "́",
];

function fuzzText(rnd: () => number): string {
  const len = Math.floor(rnd() * 12);
  let out = "";
  for (let i = 0; i < len; i += 1) {
    const idx = Math.floor(rnd() * FUZZ_TEXT_ALPHABET.length);
    out += FUZZ_TEXT_ALPHABET[idx] ?? "";
  }
  return out;
}

/** Always a valid Postgres numeric literal, so the SQL side is always reachable. */
function fuzzNumeric(rnd: () => number): string {
  const sign = rnd() < 0.3 ? "-" : rnd() < 0.1 ? "+" : "";
  const intLen = Math.floor(rnd() * 6);
  let int = "";
  for (let i = 0; i < intLen; i += 1) int += String(Math.floor(rnd() * 10));
  const fracLen = Math.floor(rnd() * 6);
  let frac = "";
  for (let i = 0; i < fracLen; i += 1) frac += String(Math.floor(rnd() * 10));
  // Bias hard toward ties: '...5' at the third decimal is where a double-based
  // implementation and Postgres `numeric` part company.
  if (rnd() < 0.35) frac = `${frac.slice(0, 2).padEnd(2, String(Math.floor(rnd() * 10)))}5`;
  if (int === "" && frac === "") int = "0";
  let body = frac === "" ? int : `${int}.${frac}`;
  if (body === "" || body === ".") body = "0";
  const exp = rnd() < 0.25 ? `e${rnd() < 0.5 ? "-" : ""}${Math.floor(rnd() * 12)}` : "";
  return `${sign}${body}${exp}`;
}

const FUZZ_COUNT = 400;
const FUZZ_FIXTURES: readonly Fixture[] = (() => {
  const rnd = mulberry32(0x5715c0de);
  const out: Fixture[] = [];
  for (let i = 0; i < FUZZ_COUNT; i += 1) {
    out.push(
      fx(`fuzz #${i}`, {
        kode_barang: rnd() < 0.1 ? null : fuzzText(rnd),
        warna: rnd() < 0.1 ? null : fuzzText(rnd),
        th: rnd() < 0.1 ? null : fuzzNumeric(rnd),
        p: rnd() < 0.1 ? null : fuzzNumeric(rnd),
        l: rnd() < 0.1 ? null : fuzzNumeric(rnd),
      }),
    );
  }
  return out;
})();

const ALL_FIXTURES: readonly Fixture[] = [...FIXTURES, ...FUZZ_FIXTURES];

// ─────────────────────────────────────────────────────────────────────────────
// Pure-TS structural properties. No database; always run.
// ─────────────────────────────────────────────────────────────────────────────

describe("canonicalSkuKey — structural invariants (no database required)", () => {
  it("uses the v1 composition kode_barang|warna|th|p|l", () => {
    expect(SKU_SEGMENTS).toEqual(DEFAULT_SKU_SEGMENTS);
    expect(canonicalSkuKey(BASE)).toBe("ACP-4MM|004|0.3|4880|1220");
  });

  it("emits exactly one field per configured segment, for every fixture", () => {
    for (const { label, parts } of ALL_FIXTURES) {
      const fields = canonicalSkuKey(parts).split(SKU_SEGMENT_SEPARATOR);
      expect(fields, label).toHaveLength(SKU_SEGMENTS.length);
    }
  });

  it("never lets the separator survive inside a segment (injection guard)", () => {
    // If a '|' could survive normalization, a crafted kode_barang would forge a
    // different SKU's key and steal its commitments.
    for (const { label, parts } of ALL_FIXTURES) {
      for (const field of canonicalSkuKey(parts).split(SKU_SEGMENT_SEPARATOR)) {
        expect(field.includes(SKU_SEGMENT_SEPARATOR), label).toBe(false);
      }
    }
  });

  it("never emits an empty segment — an absent value is '-' (positional integrity)", () => {
    for (const { label, parts } of ALL_FIXTURES) {
      for (const field of canonicalSkuKey(parts).split(SKU_SEGMENT_SEPARATOR)) {
        expect(field, label).not.toBe("");
      }
    }
  });

  it("is deterministic — the same input yields the same key", () => {
    for (const { label, parts } of ALL_FIXTURES) {
      expect(canonicalSkuKey(parts), label).toBe(canonicalSkuKey(parts));
    }
  });

  it("treats null, undefined, '' and whitespace-only as the same absent value", () => {
    const dash = ["-", "-", "-", "-", "-"].join(SKU_SEGMENT_SEPARATOR);
    expect(canonicalSkuKey({ kode_barang: null, warna: null, th: null, p: null, l: null })).toBe(dash);
    expect(canonicalSkuKey({})).toBe(dash);
    expect(
      canonicalSkuKey({ kode_barang: "", warna: "  ", th: "", p: "\t", l: undefined }),
    ).toBe(dash);
  });

  it("keeps a segment that normalizes away distinct from a shifted key", () => {
    // '###' → '-' must occupy its slot; it must not slide the later segments left.
    expect(canonicalSkuKey({ ...BASE, warna: "###" })).toBe("ACP-4MM|-|0.3|4880|1220");
  });

  it("rounds ties half away from zero on the decimal string, not the double", () => {
    // Math.round(1.005 * 100) / 100 === 1 and (1.005).toFixed(2) === "1.00".
    // Postgres says 1.01. The TS side must say 1.01 too.
    expect(normalizeSegment("1.005", "numeric")).toBe("1.01");
    expect(normalizeSegment("2.675", "numeric")).toBe("2.68");
    expect(normalizeSegment("-0.005", "numeric")).toBe("-0.01");
    expect(Math.round(1.005 * 100) / 100).not.toBe(1.01); // the trap, pinned
  });

  it("has no negative zero (Postgres numeric has none either)", () => {
    expect(normalizeSegment("-0", "numeric")).toBe("0");
    expect(normalizeSegment(-0, "numeric")).toBe("0");
    expect(normalizeSegment("-0.001", "numeric")).toBe("0");
  });

  it("maps non-finite numbers to '-' rather than to a numeric rendering", () => {
    // KNOWN PARITY HOLE, reported not fixed: `'NaN'::numeric` and
    // `'Infinity'::numeric` are legal Postgres values, and erp_sku_key renders
    // them 'NaN'/'Infinity' while TS renders '-' (number) or 'NAN' (string).
    // Nothing in the mirror schema forbids storing them. Owner: WP-2 (the sync
    // worker must reject a non-finite numeric before it reaches the mirror).
    expect(normalizeSegment(Number.NaN, "numeric")).toBe("-");
    expect(normalizeSegment(Number.POSITIVE_INFINITY, "numeric")).toBe("-");
    expect(normalizeSegment("NaN", "numeric")).toBe("NAN");
  });

  it("whitelists the configured segment list and falls back to v1", () => {
    expect(resolveSkuSegments(["warna", "kode_barang"])).toEqual(["warna", "kode_barang"]);
    expect(resolveSkuSegments(["warna", "warna"])).toEqual(["warna"]);
    expect(resolveSkuSegments(["kode_barang", "drop table"])).toEqual(["kode_barang"]);
    expect(resolveSkuSegments([])).toEqual(DEFAULT_SKU_SEGMENTS);
    expect(resolveSkuSegments(["nonsense"])).toEqual(DEFAULT_SKU_SEGMENTS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The parity block. Needs Postgres; skips cleanly without it.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!hasDb)("erp_sku_key(SQL) === canonicalSkuKey(TS) — parity (invariant §7.4)", () => {
  const reachable = ALL_FIXTURES.filter((f) => !f.sqlUnreachable);
  /** label → the key Postgres produced. Filled once, in one round trip. */
  const sqlKeys = new Map<string, string>();

  beforeAll(async () => {
    const db = getSql();
    if (!db) throw new Error("DATABASE_URL is set but getSql() returned null");

    // Only run the migration when the function is genuinely missing: it also
    // recreates the commitment views, and needless view churn would race other
    // suites sharing this database.
    const [probe] = await db<{ oid: string | null }[]>`
      select to_regprocedure('erp_sku_key(text,text,numeric,numeric,numeric)')::text as oid
    `;
    if (!probe?.oid) await runErpStockMigrations(db);

    const asText = (v: SkuValue): string | null =>
      v === null || v === undefined ? null : String(v);

    const labels = reachable.map((f) => f.label);
    const kode = reachable.map((f) => asText(f.parts.kode_barang));
    const warna = reachable.map((f) => asText(f.parts.warna));
    const th = reachable.map((f) => asText(f.parts.th));
    const p = reachable.map((f) => asText(f.parts.p));
    const l = reachable.map((f) => asText(f.parts.l));

    // One statement, so the comparison is over the whole fixture table at once.
    // th/p/l arrive as text and are cast to `numeric` here exactly as the mirror
    // column would coerce them on insert.
    const rows = await db<{ label: string; key: string }[]>`
      select t.label, erp_sku_key(t.kode, t.warna, t.th::numeric, t.p::numeric, t.l::numeric) as key
      from unnest(
        ${labels}::text[], ${kode}::text[], ${warna}::text[],
        ${th}::text[], ${p}::text[], ${l}::text[]
      ) as t(label, kode, warna, th, p, l)
    `;
    for (const r of rows) sqlKeys.set(r.label, r.key);
  }, 60_000);

  afterAll(async () => {
    await closeDatabase();
  });

  it("evaluated every SQL-reachable fixture", () => {
    expect(sqlKeys.size).toBe(reachable.length);
    expect(reachable.length).toBeGreaterThan(400);
  });

  it("produces byte-identical output for the whole fixture table", () => {
    // One assertion over the entire table so a divergence prints every offending
    // row at once, not just the first.
    const divergences = reachable
      .map((f) => ({ label: f.label, ts: canonicalSkuKey(f.parts), sql: sqlKeys.get(f.label) }))
      .filter((r) => r.ts !== r.sql);
    expect(divergences).toEqual([]);
  });

  // A named test per hand-written fixture, so a regression report says which
  // rule broke rather than "the parity test failed".
  it.each(FIXTURES.filter((f) => !f.sqlUnreachable).map((f) => [f.label, f.parts] as const))(
    "parity: %s",
    (label, parts) => {
      expect(sqlKeys.get(label), label).toBe(canonicalSkuKey(parts));
    },
  );

  it("agrees on the key stored by the mirror for a round-tripped row", () => {
    // The end-to-end shape of the contract: whatever the SQL function computes
    // for a row is what the TS function computes for the same row's fields.
    const key = canonicalSkuKey(BASE);
    expect(sqlKeys.get("PRD §5A Black Galaxy")).toBe(key);
    expect(key).toBe("ACP-4MM|004|0.3|4880|1220");
  });

  it("names the fixtures SQL cannot be given, rather than skipping them silently", () => {
    const gaps = ALL_FIXTURES.filter((f) => f.sqlUnreachable);
    // Rule 3's "non-numeric → rule 2" fallthrough is unreachable from SQL by
    // construction: erp_so_line.th/p/l are `numeric`, so a non-numeric value can
    // only ever exist on the TypeScript side of the join. The fallthrough is
    // therefore TS-only behaviour and is NOT covered by the parity guarantee.
    expect(gaps.length).toBeGreaterThan(0);
    for (const g of gaps) {
      expect(g.sqlUnreachable, g.label).toBeTruthy();
      // Still assert TS does something defined with it.
      expect(canonicalSkuKey(g.parts).split(SKU_SEGMENT_SEPARATOR)).toHaveLength(
        SKU_SEGMENTS.length,
      );
    }
  });
});
