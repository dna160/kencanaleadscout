/**
 * Stock 2.0 — ERP mirror schema (CONTRACTS §2). Idempotent, safe on every boot.
 *
 * Called from bootDatabase() right after runStockMigrations(db). Same style as
 * migrate.ts / migrateStock.ts: each block in its own non-fatal try/catch so a
 * partial failure never blocks the rest of the app from booting.
 *
 * Three groups:
 *   erp_*                       — read-only mirror of Selaras. Written ONLY by
 *                                 the sync worker, never by a route (§7.2).
 *   stock_adjustments,          — LeadScout-owned, additive, audited, reversible
 *   stock_commitment_overrides    (ST-R12, ST-R18/R21). Never an UPDATE of erp_*.
 *   erp_sync_state              — the updated_at cursor per mirrored table (ST-R6).
 *
 *   ATP(sku) = on_hand − open_commitment + manual_adjustment       (never stored)
 *
 * 2026-09-11 — remapped onto the VERIFIED Selaras column lists. The mirror's
 * identity columns are now `brand`, `warna`, `th` (aluminium skin), `th_panel`
 * (total panel), `p`, `l` on BOTH sides; `kode_barang` survives on the FG side
 * as display only and is gone from `erp_so_line`, which never had it upstream.
 * `erp_warna` mirrors the colour master `tbl_1228_DBRMWarnaID` so a row can read
 * "BLACK GALAXY" instead of "4". See `erp/sku.ts` for why the key changed.
 *
 * No table here has an `atp` column and none ever will (§7.1). The liveness
 * predicate (ST-R17) is spelled exactly once, in the shared view spine below —
 * v_live_commitments, v_stale_commitments and v_autoclosed_commitments are three
 * mutually exclusive slices of ONE predicate string, not three predicates (§7.3);
 * ST-R22's auto-close is likewise ONE string, sliced the same way — and it stays
 * one string now that it carries TWO rules (aged delivery order, and the SPB
 * goods-out rule of 2026-09-14): they are disjuncts of a single `autoclosed`
 * expression, not a second mechanism, so `autoclose_basis` is the only thing that
 * distinguishes them downstream. The canonical SKU key is spelled exactly twice —
 * erp/sku.ts and erp_sku_key() below (§7.4).
 */
import type { Sql } from "./client.js";
import { getSql } from "./client.js";
import { config } from "../config.js";
import {
  SKU_SEGMENTS,
  SKU_SEGMENT_KINDS,
  SKU_SEGMENT_SEPARATOR,
  type SkuSegmentName,
} from "../erp/sku.js";

/** Fixed parameter name per segment. The function always takes all six. */
const SKU_SEGMENT_ARGS: Record<SkuSegmentName, string> = {
  brand: "p_brand",
  warna: "p_warna",
  th: "p_th",
  th_panel: "p_th_panel",
  p: "p_p",
  l: "p_l",
};

/**
 * The signature, in one place, so the drop of the retired overload and the
 * create below cannot disagree. Order matches SKU_SEGMENT_ARGS.
 */
export const SKU_KEY_SIGNATURE = "text,text,numeric,numeric,numeric,numeric";

/**
 * The v1 signature (`kode_barang, warna, th, p, l`). `create or replace function`
 * cannot replace a function with a different parameter list — it creates a second
 * OVERLOAD — so the retired one is dropped explicitly. Leaving it behind would
 * leave a working-looking `erp_sku_key(text,text,numeric,numeric,numeric)` in the
 * database that computes the key that could never match (see erp/sku.ts).
 */
const RETIRED_SKU_KEY_SIGNATURES = ["text,text,numeric,numeric,numeric"] as const;

/**
 * Rule 2 (text segments) as SQL. Deliberately ASCII-only and collation
 * independent — translate() rather than upper(), explicit [ \t\n\r\f\v] rather
 * than \s — because upper()/\s are locale-dependent and would drift from the
 * TypeScript twin on non-ASCII input ('ß' → 'SS' in JS, unchanged in C locale).
 * Order matches normalizeSegment(): trim → upper → collapse → strip.
 */
function sqlTextSegment(arg: string): string {
  return `coalesce(nullif(
        regexp_replace(
          regexp_replace(
            translate(
              regexp_replace(coalesce(${arg}, ''), '^[ \\t\\n\\r\\f\\v]+|[ \\t\\n\\r\\f\\v]+$', '', 'g'),
              'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
            '[ \\t\\n\\r\\f\\v]+', ' ', 'g'),
          '[^A-Z0-9 ./-]', '', 'g'),
        ''), '-')`;
}

/**
 * Rule 3 (numeric segments) as SQL: round to 2 dp, then strip trailing zeros and
 * a bare trailing point — 0.50 → '0.5', 1220.00 → '1220', 0.00 → '0'.
 * round(numeric, 2) is exact decimal, half away from zero; the TS twin rounds the
 * decimal STRING for the same reason (a double would disagree on ties).
 * The lazy `(\.[0-9]*?)0+$` cannot touch an integer rendering — there is no '.'
 * to anchor on — so '1220' never becomes '122'.
 */
function sqlNumericSegment(arg: string): string {
  return `case
        when ${arg} is null then '-'
        else regexp_replace(regexp_replace(round(${arg}, 2)::text, '(\\.[0-9]*?)0+$', '\\1'), '\\.$', '')
      end`;
}

/**
 * The SQL twin of canonicalSkuKey() (ST-R5.1). Byte-identical output required —
 * test/sku.test.ts asserts it over a shared fixture table.
 *
 * `immutable` so it can back an index or a generated column; not `strict`,
 * because a NULL argument must normalize to '-' rather than NULL the whole key.
 * The parameter list is fixed at all six columns even when the configured
 * composition uses fewer, so callers never have to branch; only the body varies,
 * and the segment names spliced into it are whitelisted by resolveSkuSegments().
 */
function buildSkuKeyFunctionSql(): string {
  const body = SKU_SEGMENTS.map((name) => {
    const arg = SKU_SEGMENT_ARGS[name];
    return SKU_SEGMENT_KINDS[name] === "numeric" ? sqlNumericSegment(arg) : sqlTextSegment(arg);
  }).join(`\n      || '${SKU_SEGMENT_SEPARATOR}' ||\n      `);

  return `
    create or replace function erp_sku_key(
      p_brand    text,
      p_warna    text,
      p_th       numeric,
      p_th_panel numeric,
      p_p        numeric,
      p_l        numeric
    ) returns text
    language sql
    immutable
    parallel safe
    as $erp_sku_key$
      select ${body}
    $erp_sku_key$
  `;
}

// ── Config → SQL, the ONLY place these values are spliced (CONTRACTS §2.3) ────
// A Postgres view cannot read process env, so the liveness window and the
// cancelled-status set are interpolated when the views are (re)created at boot.
// Everything else in this file is a static string or a driver parameter.

const STATUS_TOKEN_RE = /^[A-Za-z0-9 _-]{1,40}$/;

/** ST-R17 window. Must be a finite positive integer or we fall back to the default. */
function safeWindowDays(raw: number): number {
  if (Number.isSafeInteger(raw) && raw > 0) return raw;
  console.error("[migrateErpStock] STOCK_STALE_WINDOW_DAYS invalid — falling back to 60");
  return 60;
}

/**
 * OQ-1 status whitelist. Anything that is not a plain short token is DROPPED,
 * never escaped — escaping is how an injection bug gets written, and a status
 * value with a quote in it is a misconfiguration, not a thing to accommodate.
 * The env-var name is passed in only so the rejection log names the right knob.
 */
function safeStatuses(raw: readonly string[], envName: string): string[] {
  const ok: string[] = [];
  for (const s of raw) {
    const v = s.trim();
    if (STATUS_TOKEN_RE.test(v)) ok.push(v);
    else console.error(`[migrateErpStock] ignoring malformed ${envName} entry`);
  }
  return ok;
}

/** OQ-1 cancelled set (ST-R7a). Empty is SAFE here: `<> all (array[])` excludes nothing. */
function safeCancelledStatuses(raw: readonly string[]): string[] {
  return safeStatuses(raw, "STOCK_CANCELLED_STATUSES");
}

/**
 * ST-R7b approved set — the same whitelist path, with ONE deliberate asymmetry.
 *
 * An empty cancelled set is harmless. An empty APPROVED set is catastrophic:
 * `approval = any(array[]::text[])` is false for every row, so v_live_commitments
 * empties, open_commitment is 0 for every SKU, ATP equals on-hand and the whole
 * inventory reads as promiseable. That failure looks like good news on screen,
 * which is exactly why it must not be reachable by a typo. So a set that
 * validates down to nothing falls back to the shipped default rather than
 * disabling the commitment gate.
 */
const DEFAULT_APPROVED_STATUSES = ["Approved"] as const;

function safeApprovedStatuses(raw: readonly string[]): string[] {
  const ok = safeStatuses(raw, "STOCK_APPROVED_STATUSES");
  if (ok.length > 0) return ok;
  console.error(
    "[migrateErpStock] STOCK_APPROVED_STATUSES validated down to an empty set — falling back to " +
      `"${DEFAULT_APPROVED_STATUSES.join(",")}". An empty approved set would make EVERY SKU read as ` +
      "fully promiseable (zero live commitments), so it is never honoured.",
  );
  return [...DEFAULT_APPROVED_STATUSES];
}

/**
 * ST-R22 auto-close set. The SAME whitelist path as the cancelled set, and with
 * the cancelled set's symmetry rather than the approved set's: an empty auto-close
 * set closes nothing, which leaves every line in the review queue for a human.
 * Nothing is released by a typo, so no default is forced back in.
 */
function safeAutocloseStatuses(raw: readonly string[]): string[] {
  return safeStatuses(raw, "STOCK_AUTOCLOSE_STATUSES");
}

/**
 * ST-R22 auto-close age. Positive integer or the shipped default — a zero or
 * negative threshold would auto-close every dated line in the mirror.
 */
function safeAutocloseAfterDays(raw: number): number {
  if (Number.isSafeInteger(raw) && raw > 0) return raw;
  console.error("[migrateErpStock] STOCK_AUTOCLOSE_AFTER_DAYS invalid — falling back to 180");
  return 180;
}

/**
 * A boolean config value as a SQL literal. Trivial, and deliberately a function:
 * it is the boolean half of the same discipline `safeStatuses()` applies to the
 * status sets — a config value reaches SQL only through something whose output
 * set is closed. This one can emit exactly `true` or `false`, whatever the env
 * var said, because `bool()` in config.ts has already collapsed it to a boolean.
 */
function sqlBool(value: boolean): "true" | "false" {
  return value ? "true" : "false";
}

/** `array['Cancelled','Void','Batal']`, or a typed empty array when the set is empty. */
function statusArraySql(statuses: readonly string[]): string {
  if (statuses.length === 0) return "array[]::text[]";
  return `array[${statuses.map((s) => `'${s}'`).join(", ")}]`;
}

/**
 * The knobs the commitment views are built from. A struct rather than a read of
 * `config` inside the builder, for one reason: the RULES become testable at
 * settings other than the deployed ones. `STOCK_AUTOCLOSE_SPB_REQUIRE_FULL` is
 * exactly such a knob — a test has to be able to see what the machine does with
 * it off, and the only honest way to check that is to build the real views from
 * the real builder, never to re-spell the predicate in a test.
 */
export interface CommitmentRuleConfig {
  windowDays: number;
  cancelledStatuses: readonly string[];
  approvedStatuses: readonly string[];
  autocloseStatuses: readonly string[];
  autocloseAfterDays: number;
  autocloseAgeAnyStatus: boolean;
  autocloseOnSpb: boolean;
  autocloseSpbRequireFull: boolean;
}

/** The deployed settings, with named overrides for a caller that is exploring. */
export function commitmentRuleConfig(
  over: Partial<CommitmentRuleConfig> = {},
): CommitmentRuleConfig {
  return {
    windowDays: config.stock.staleWindowDays,
    cancelledStatuses: config.stock.cancelledStatuses,
    approvedStatuses: config.stock.approvedStatuses,
    autocloseStatuses: config.stock.autocloseStatuses,
    autocloseAfterDays: config.stock.autocloseAfterDays,
    autocloseAgeAnyStatus: config.stock.autocloseAgeAnyStatus,
    autocloseOnSpb: config.stock.autocloseOnSpb,
    autocloseSpbRequireFull: config.stock.autocloseSpbRequireFull,
    ...over,
  };
}

/**
 * THE commitment rules, as SQL, in the only place they exist (§7.3): the ST-R17
 * liveness predicate and both ST-R22 auto-close rules. Returns `[view name, view
 * body]` pairs; it touches no database, so it is also readable as the spec.
 */
export function buildCommitmentViewSql(
  cfg: CommitmentRuleConfig,
): ReadonlyArray<readonly [string, string]> {
  const windowDays = safeWindowDays(cfg.windowDays);
  const cancelled = statusArraySql(safeCancelledStatuses(cfg.cancelledStatuses));
  // ST-R7b: the commitment gate is config, not a literal (OQ-1). Same validated
  // whitelist path as the cancelled set — nothing unvalidated reaches SQL.
  const approved = statusArraySql(safeApprovedStatuses(cfg.approvedStatuses));
  // ST-R22 auto-close, same validated whitelist path again (§2.3: this block is
  // the ONLY place any config value is spliced into SQL in this repo).
  const autocloseStatuses = statusArraySql(
    safeAutocloseStatuses(cfg.autocloseStatuses),
  );
  const autocloseDays = safeAutocloseAfterDays(cfg.autocloseAfterDays);
  // ST-R22 rule 2's two knobs. Booleans, so the "whitelist" that keeps them out
  // of SQL's reach is a type: `sqlBool()` can only ever emit the two SQL keywords
  // and never the env string that produced them. Same discipline as the status
  // sets above — a config value is validated into a closed set of outputs before
  // it is spliced, and NOTHING else in this file is spliced at all.
  const spbEnabled = sqlBool(cfg.autocloseOnSpb);
  const spbRequireFull = cfg.autocloseSpbRequireFull;

  /**
   * ST-R22 — "delivered but never closed", spelled ONCE.
   *
   * A line whose `status_order` says a delivery order was issued, and whose
   * DELIVERY DATE is more than `autocloseDays` old, is treated as fully
   * delivered: the goods went out, the ERP just never zeroed `qty_balance`.
   *
   * THE AGE BASIS IS `estimate_delivery` AND NOTHING ELSE (product-owner
   * ruling, 2026-09-11). An earlier draft aged an undated line off its header's
   * `po_date`; that was withdrawn deliberately and must not be "restored".
   * The difference is the entire risk profile of this feature:
   *
   *   - a DO line with an OLD ETA is already outside the 60-day liveness
   *     window, so it is already excluded from `open_commitment`. Auto-closing
   *     it moves ATP by exactly ZERO — it only stops demanding a human
   *     decision. Pure queue hygiene.
   *   - a DO line with NO ETA is LIVE and reserving right now (AMENDMENT 1).
   *     Auto-closing it would have RAISED ATP by its whole balance — a machine
   *     silently releasing stock that is already owed to a customer, which is
   *     the exact over-promising failure this module exists to prevent.
   *
   * So an undated line has no age for this purpose and is never a candidate,
   * at any `po_date`. It stays live, keeps reserving, and stays in the
   * `undated` review segment as an audit item for PPIC to resolve with the
   * order's owner — a human decision, which is where releasing stock belongs.
   *
   * NULL-proofed on purpose: `status_order` may be NULL, and `NULL = any(...)`
   * is NULL, not false. An un-coalesced NULL here would propagate through the
   * `not (...)` arm below and drop the line out of EVERY view — a silent
   * inflation of ATP and a breach of §7.6. `coalesce(…, false)` makes the whole
   * thing a two-valued boolean, so the three sets stay a true partition.
   *
   * ST-R21 reversibility rides on the last clause: a machine decision must be
   * undoable exactly like a human one, so a `reinstated` override lifts the
   * auto-close and hands the line straight back to the liveness rule.
   */
  /**
   * AMENDMENT 22 — the age arm's STATUS gate, and whether it exists at all.
   *
   * `STOCK_AUTOCLOSE_AGE_ANY_STATUS` ON (default): the age arm drops the status
   * test entirely — a real `estimate_delivery` older than `autocloseDays` is
   * sufficient on its own, whatever `status_order` says. The product owner's
   * reason, and it is the right one: physical stock and spoken-for stock need a
   * clear boundary, and a line whose delivery date passed five years ago is not
   * spoken for by any reading, whatever status the ERP left on it. Five-year-old
   * approved lines carrying some other status were sitting in the review queue
   * forever, because the status gate meant the age rule never looked at them.
   *
   * OFF: exactly AMENDMENT 20's behaviour, the age arm gated on
   * `STOCK_AUTOCLOSE_STATUSES`.
   *
   * THE WIDENING MOVES ATP BY EXACTLY ZERO, for AMENDMENT 20's own reason:
   * `autocloseDays` (180) sits well above `windowDays` (60), so EVERY line the
   * age arm can reach has already failed the liveness window and is already out
   * of `open_commitment`. Widening which statuses it reaches cannot change that —
   * it only reaches MORE already-excluded lines. That ordering is checked and
   * warned about below, and it is the entire guarantee.
   *
   * WHAT IS EMPHATICALLY NOT WIDENED: the `estimate_delivery IS NULL` case.
   * AMENDMENT 21 scoped AMENDMENT 20's "never auto-closed by age" to the AGE
   * BASIS precisely because inferring from an ABSENT date is a guess, in the
   * over-promising direction. Widening the STATUS does not license widening to
   * undated lines: `NULL < current_date - N` is NULL, the outer `coalesce(…,
   * false)` resolves it to false, and an undated line keeps reserving and stays
   * in review at any status and any age. Only the SPB rule — documentary
   * evidence, not an inference — closes an undated line.
   *
   * Cancelled and unapproved lines are filtered out by the spine's WHERE before
   * any of this is evaluated, so widening the status set reaches none of them.
   */

  /**
   * The age arm's two atoms, each spelled ONCE so the rule, its OFF setting and
   * the counter that measures the difference cannot drift apart.
   *
   * Both are NULL-proofed into two-valued booleans before anything combines them.
   * `status_order` may be NULL and `NULL = any(...)` is NULL, not false; an
   * un-coalesced NULL would propagate through the `not (...)` arms below and drop
   * the line out of EVERY view — a silent inflation of ATP and a breach of §7.6.
   * `estimate_delivery` may be NULL and `NULL < date` is likewise NULL, which is
   * exactly how an undated line is kept out of the age arm (see above).
   */
  const agedPastThreshold = `coalesce(l.estimate_delivery < current_date - ${autocloseDays}, false)`;
  const autocloseStatusMatch = `coalesce(coalesce(l.status_order, '') = any (${autocloseStatuses}), false)`;

  const autoclosedAged = cfg.autocloseAgeAnyStatus
    ? agedPastThreshold
    : `(${autocloseStatusMatch} and ${agedPastThreshold})`;

  /**
   * AMENDMENT 22'S OWN POPULATION, carried on the row: past the age threshold, at
   * a status the configured auto-close set does NOT contain. Exactly the lines the
   * widening added to the age arm's reach, and nothing else.
   *
   * DELIBERATELY INDEPENDENT OF THE FLAG, which is what makes it useful. With the
   * widening ON these rows are in `v_autoclosed_commitments` and the count says
   * how many lines the change closed. With it OFF the very same rows are in
   * `v_stale_commitments` — they are dated and past the window — and the count
   * says how many it WOULD close. So an operator can deploy with the flag off,
   * read the number off /summary, and turn the rule on against a figure rather
   * than a hope. `totals.autoclosed_spb_partial_held` measures its own setting's
   * population the same way, for the same reason.
   *
   * It can never appear on `v_live_commitments`: past the auto-close threshold
   * implies past the liveness window, since boot refuses to let that ordering
   * invert without saying so.
   */
  const agedWidened = `(${agedPastThreshold} and not ${autocloseStatusMatch})`;

  /**
   * ST-R22 rule 2 — an SO line carrying an SPB has already left the warehouse
   * (product-owner ruling, 2026-09-14). SPB = *Surat Pengantar Barang*, the
   * goods-out document; `tbl_1203.summary_spb` carries it.
   *
   * WHAT IS DIFFERENT ABOUT THIS RULE, and it is the whole of its risk: the aged
   * rule above only ever touched lines that had ALREADY failed the liveness
   * window, so its ATP delta was provably zero. This one can touch a LIVE,
   * RESERVING line — a recent or undated line with an SPB is reserving right now
   * (AMENDMENT 1) — and closing such a line RAISES ATP by its balance.
   *
   * That is a correction, not a release, and here is why. PRD §5A establishes
   * that Live FG `qty` is GROSS: it is reduced only when goods physically ship
   * (`qty_booking` is unused, 0/1,464 rows). So if an SPB exists, on-hand has
   * already dropped for those goods. A balance still standing against them is a
   * PHANTOM THAT DOUBLE-COUNTS — the same unit subtracted twice, once by leaving
   * the warehouse and again by still reading as "committed". Removing it restores
   * truth; it does not over-promise.
   *
   * THAT ARGUMENT HOLDS ONLY FOR A FULLY SHIPPED LINE. A partially shipped one
   * has an SPB *and* a genuine remainder still owed: the goods that left are
   * already out of on-hand, but the rest are not, and the remaining balance is
   * real demand, not a phantom. Auto-closing it releases stock a customer is
   * actually waiting for — the exact failure this module exists to prevent. Hence
   * `STOCK_AUTOCLOSE_SPB_REQUIRE_FULL`, default ON: the safe reading, with
   * `totals.autoclosed_spb_partial_held` on /summary measuring precisely what it
   * holds back so the owner can relax it against numbers rather than a guess.
   *
   * BLANK IS NOT AN SPB. An empty string means "no document", and this ERP also
   * writes a `'-'` placeholder, so the test is "something is left after trimming
   * spaces and dashes" rather than `is not null`. Getting this wrong would
   * auto-close every line in the mirror that has the column populated at all.
   *
   * A row that has never been re-synced since the column shipped carries NULL and
   * is therefore not a candidate — the rule acts on evidence it has actually read.
   */
  const hasSpb = `(nullif(btrim(coalesce(l.summary_spb, ''), ' -'), '') is not null)`;
  /**
   * ST-R22's cross-check, which the PRD proposed and nobody built. NULL-proofed
   * both ways: an unknown `qty_order` cannot PROVE full shipment, so the coalesce
   * resolves it to false and the line stays with a human. Failing closed here
   * keeps a missing column from releasing stock.
   */
  const fullyShipped = `coalesce(coalesce(l.qty_delivered, 0) >= l.qty_order, false)`;
  const autoclosedSpb = `(${spbEnabled} and ${hasSpb}${
    spbRequireFull ? ` and ${fullyShipped}` : ""
  })`;

  /**
   * The ONE auto-close predicate (§7.3's discipline applied to the machine rules
   * as well as the liveness one). A line qualifies by EITHER rule, and there is
   * no second mechanism anywhere: both rules enter the views through this
   * expression, both are lifted by the same ST-R21 `reinstated` override, and
   * both leave live and stale through the same `not (...)` arms, so §7.6's
   * three-way partition is unchanged by adding a disjunct.
   *
   * NULL-proofed on purpose: `status_order` may be NULL, and `NULL = any(...)`
   * is NULL, not false. An un-coalesced NULL here would propagate through the
   * `not (...)` arm below and drop the line out of EVERY view — a silent
   * inflation of ATP and a breach of §7.6. Each disjunct is therefore a
   * two-valued boolean before the `or`, so the three sets stay a true partition.
   *
   * ST-R21 reversibility rides on the last clause: a machine decision must be
   * undoable exactly like a human one, so a `reinstated` override lifts the
   * auto-close — either rule's — and hands the line straight back to the liveness
   * rule. One override, one undo, for both rules.
   */
  const autoclosed = `((${autoclosedAged}) or (${autoclosedSpb}))
      and coalesce(o.state, '') <> 'reinstated'`;

  /**
   * WHICH rule closed it, carried on the row rather than reconstructed by a
   * reader. Deterministic and stable when BOTH fire: the aged rule is named
   * first, so a line that already qualified under AMENDMENT 20 keeps stating the
   * same grounds after this rule ships. A row's audit narration must not change
   * because an unrelated rule was added beside it.
   */
  const autocloseBasis = `case
           when not (${autoclosed}) then null
           when (${autoclosedAged}) then 'estimate_delivery'
           else 'summary_spb'
         end::text`;

  // The ordering that keeps auto-close a zero-ATP operation. Below the liveness
  // window it would start closing lines that are still LIVE, i.e. releasing
  // reservations a customer is owed. Config can do it; config should not.
  if (autocloseDays <= windowDays) {
    console.warn(
      `[migrateErpStock] STOCK_AUTOCLOSE_AFTER_DAYS (${autocloseDays}) is not above ` +
        `STOCK_STALE_WINDOW_DAYS (${windowDays}). Auto-close is only ATP-neutral while it ` +
        "is the slower of the two: at this setting it can close LIVE commitments and RAISE " +
        "ATP, releasing stock that is already promised to a customer.",
    );
  }

  // AMENDMENT 22's announcement. Not an ordering problem and not a safety alarm —
  // the ATP delta is provably zero — but the SAME CLASS OF FACT as the warning
  // below it: a config value that changes WHICH POPULATION the machine decides
  // for. That must never be something an operator discovers by noticing their
  // queue got shorter overnight, so it says so at boot and names the counter that
  // measures it.
  if (cfg.autocloseAgeAnyStatus) {
    console.warn(
      "[migrateErpStock] STOCK_AUTOCLOSE_AGE_ANY_STATUS is ON. The age arm of the auto-close rule " +
        `now IGNORES status_order: any approved line whose estimate_delivery is more than ${autocloseDays} ` +
        "days past is auto-closed, not just the ones whose status is " +
        `${safeAutocloseStatuses(cfg.autocloseStatuses).join(" / ") || "(none configured)"}. ` +
        "This RELEASES NO STOCK — that " +
        `threshold sits above the ${windowDays}-day liveness window, so every line it can reach was ` +
        "already outside open_commitment — but it does move lines out of the human review queue. Read " +
        "totals.autoclosed_aged_widened on /api/stock/summary for exactly how many; it counts the same " +
        "population whether this is on or off, so it is also the preview. Undated lines are NOT affected: " +
        "no line is ever auto-closed for its AGE without a real estimate_delivery.",
    );
  }

  // ST-R22 rule 2's equivalent alarm. There is no ordering to protect here —
  // the SPB rule is ATP-moving BY DESIGN — so what must not happen silently is
  // the cross-check being switched off, because that is the one setting under
  // which the machine closes balances a customer is still owed.
  if (cfg.autocloseOnSpb && !spbRequireFull) {
    console.warn(
      "[migrateErpStock] STOCK_AUTOCLOSE_SPB_REQUIRE_FULL is OFF. The SPB auto-close will now " +
        "close PARTIALLY shipped lines: those carry a goods-out document AND a genuine " +
        "remainder still owed, so closing them RELEASES stock a customer is waiting for. " +
        "With it ON the rule only removes phantom balances against goods that have already " +
        "left (PRD §5A: Live FG qty is gross). Check totals.autoclosed_spb_partial_held on " +
        "/api/stock/summary for the population this setting hands to the machine.",
    );
  }

  // ST-R17's ETA arm, named once so the `autoclose_reserving` column below can
  // ask "was this line reserving when the machine closed it?" without re-spelling
  // the liveness rule (§7.3). One spelling, two readers.
  const liveEta =
    `(l.estimate_delivery >= current_date - ${windowDays} or l.estimate_delivery is null)`;

  // The shared FROM/JOIN spine. A line that is confirm-closed leaves all sets.
  // `undated` (AMENDMENT 1) lets the PPIC queue separate two populations whose
  // close consequences are opposite: closing a stale line moves ATP by zero,
  // closing an undated one raises it by the whole balance (AMENDMENT 6).
  // AMENDMENT 12 — `po_date` rides along on every commitment shape. An undated
  // line has no ETA to age from, so the order date is the only way to show how
  // old it is, on exactly the population that reserves stock. It lives on the
  // header, so the views are the only place it can be picked up once.
  const spine = (etaPredicate: string, autoclosePredicate: string) => `
    select l.*, h.customer_name_text, h.sales_name_text, h.so_number, h.po_date,
           (l.estimate_delivery is null) as undated,
           (${autoclosed}) as autoclosed,
           -- WHY this line qualified, carried on the row rather than inferred by
           -- a reader: 'estimate_delivery' for the aged-DO rule, 'summary_spb'
           -- for the goods-out rule. It is a column so that a reader never has
           -- to re-derive which machine rule fired, and so a future rule cannot
           -- leave the UI narrating the wrong one.
           ${autocloseBasis} as autoclose_basis,
           -- Was this line RESERVING at the moment the machine closed it? True
           -- only on the auto-closed set, and only for a line the liveness rule
           -- would otherwise have kept live — so Σ qty_balance over the rows with
           -- this flag IS the ATP the rule released, measured rather than argued.
           -- Structurally always false for the aged-DO rule (its threshold sits
           -- above the liveness window), which is that rule's zero-delta claim
           -- restated as data.
           ((${autoclosed}) and ${liveEta}) as autoclose_reserving,
           -- AMENDMENT 22's population, exposed so /summary can state the size of
           -- the widening — in either setting of the flag — without re-spelling
           -- the age rule or the status set (§7.3).
           ${agedWidened} as autoclose_aged_widened,
           -- The SPB rule's two atoms, exposed so that /summary can count what the
           -- REQUIRE_FULL cross-check is holding back without re-spelling the rule.
           ${hasSpb} as has_spb,
           (${fullyShipped}) as fully_shipped
    from erp_so_line l
    left join erp_so_header h on h.id = l.so_id
    left join stock_commitment_overrides o on o.so_line_id = l.id
    where l.approval = any (${approved})
      and l.qty_balance > 0
      and coalesce(l.status_order, '') <> all (${cancelled})
      and ${etaPredicate}
      and ${autoclosePredicate}
      and coalesce(o.state, '') <> 'closed'
  `;

  // ST-R17: live => reserves stock. Stale => same line, ETA outside the window;
  // excluded from ATP, surfaced in the review queue (ST-R18) instead.
  //
  // AMENDMENT 1 — the `is null` arm is load-bearing, not defensive. `NULL >= x`
  // and `NULL < x` are both NULL, so without it an approved line with no ETA
  // matches NEITHER view: it reserves nothing, appears in no queue, and inflates
  // ATP by its whole balance. That is the silent-drop failure ST-R18 exists to
  // prevent and a breach of invariant §7.6. An undated line is real demand that
  // is merely unscheduled — an absent date is not evidence of abandonment the
  // way a 2020 ETA is — so it reserves, and `undated` flags it for PPIC review.
  //
  // ST-R22 adds a THIRD set rather than a deletion. An auto-closed line leaves
  // live and stale — it stops asking a human for a decision — but it must not
  // vanish (§7.6), and a MACHINE decision deserves more visibility than a human
  // one, not less: nobody typed it, so nobody remembers making it. Hence its own
  // view, its own `/stale-commitments?segment=autoclosed`, and the same
  // reinstate path a confirm-close has (ST-R21).
  //
  // The three predicates below still partition the universe: the ETA arms cover
  // every line between them (`>=`, `<`, `is null`), and `autoclosed` then splits
  // each arm in two with `not (…)` / `(…)`. The auto-closed view takes no ETA
  // arm of its own precisely so it is the union of both — otherwise a config
  // with a short threshold would leave a line in no set at all.
  //
  // TWO machine rules now feed that third set (aged DO, and the SPB rule), and
  // they feed it through ONE predicate rather than two mechanisms. Nothing below
  // changes when a rule is added: the views, the reinstate path, the segment and
  // the partition all key off `autoclosed`, and only `autoclose_basis` says which
  // rule spoke. A second `or` disjunct is the whole extension surface.
  const views: ReadonlyArray<readonly [string, string]> = [
    ["v_live_commitments", spine(liveEta, `not (${autoclosed})`)],
    ["v_stale_commitments", spine(
      `l.estimate_delivery < current_date - ${windowDays}`,
      `not (${autoclosed})`,
    )],
    ["v_autoclosed_commitments", spine("true", `(${autoclosed})`)],
  ];

  return views;
}


/**
 * Create-or-replace each view. Split out from the builder so a caller can apply
 * an alternative rule set to a transaction (and roll it back) without duplicating
 * the 42P16 handling below.
 */
export async function applyCommitmentViews(
  db: Sql,
  views: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  for (const [name, body] of views) {
    try {
      await db.unsafe(`create or replace view ${name} as ${body}`);
    } catch (replaceErr) {
      // ONLY 42P16 ("cannot change name/type/number of columns of a view") is
      // contemplated here: the body selects l.*, so an added mirror column — or
      // AMENDMENT 12's po_date — makes the replace fail. Views hold no data, so
      // dropping and recreating is the right resolution for that one error.
      //
      // A bare catch was wrong, and dangerously so: a lock timeout or a
      // permissions fault took the same branch, dropped a working view, and if
      // the recreate then failed too the app booted with NO v_live_commitments
      // while the log said the migration was fine — zero commitments, ATP equal
      // to on-hand, the whole inventory promiseable. Anything that is not 42P16
      // is re-thrown to the block's own handler, which logs it and leaves the
      // existing view in place.
      const code = (replaceErr as { code?: string } | null)?.code;
      if (code !== "42P16") throw replaceErr;
      console.warn(
        `[migrateErpStock] ${name}: column list changed (42P16) — dropping and recreating the view`,
      );
      await db.unsafe(`drop view if exists ${name} cascade`);
      await db.unsafe(`create view ${name} as ${body}`);
    }
  }
}

export async function runErpStockMigrations(db: Sql = getSql()!): Promise<void> {
  /**
   * Set by a one-time structural change that invalidates what is already
   * mirrored — a dropped table, or the SKU key composition changing. Every
   * mirrored row's `sku_key` is computed at WRITE time, so a key change only
   * reaches rows that are re-fetched: without resetting the cursor, rows older
   * than it keep their retired key forever and never match anything again.
   */
  let needsFullRepull = false;
  // ── erp_sku_key() — the SQL half of the canonical key (ST-R5.1) ─────────────
  // First, because everything that mirrors a row computes a sku_key with it.
  try {
    await db.unsafe(buildSkuKeyFunctionSql());
    for (const sig of RETIRED_SKU_KEY_SIGNATURES) {
      // Not `cascade`: nothing may depend on the retired overload, and if
      // something somehow does, failing loudly here beats dropping it silently.
      await db.unsafe(`drop function if exists erp_sku_key(${sig})`);
    }
    // Cast-safe numeric reader, used to match a colour code ('004') against the
    // colour master's id ('4'). A bare `::numeric` inside an OR would let the
    // planner evaluate the cast on a non-numeric row and raise 22P02.
    await db.unsafe(`
      create or replace function erp_num_or_null(v text) returns numeric
      language sql immutable parallel safe
      as $erp_num_or_null$
        select case when v ~ '^[ \t]*[+-]?[0-9]+(\.[0-9]+)?[ \t]*$' then btrim(v)::numeric end
      $erp_num_or_null$
    `);
  } catch (skuKeyErr) {
    console.error("[migrateErpStock] erp_sku_key step failed (non-fatal):", skuKeyErr);
  }

  // ── erp_live_fg — mirror of tbl_1210_STLiveFGMX; physical on-hand ──────────
  // PRIMARY KEY: `erp_row_id`, holding the ERP's documented `tbl_1210_STLiveFGMX_id`.
  // `sn_fg` is kept as a plain column holding the ERP's actual ROLL SERIAL — the
  // thing PPIC reads off the physical panel and the thing /api/stock/sku/:sku_key
  // shows in `on_hand_rows[].sn_fg`. Keying on the row id is right per the spec;
  // storing the row id in a column called `sn_fg` was not, and would have shown
  // an operator a row id where they expect a serial.
  //
  // The identity columns are the VERIFIED ones, and they are the SO side's
  // columns too, under the mirror's spelling:
  //   brand → brand · warna → warna · th (alu skin) → th_alu_skin ·
  //   th_panel (total panel) → total_thickness_acp · p → p · l → l
  // `kode_barang` is kept here for DISPLAY only — the SO table has no such
  // column, so it can never be part of the join key (erp/sku.ts).
  try {
    // A database created before the 2026-09-11 remap has this table keyed on
    // `sn_fg` with a row id stored in it. It cannot be migrated in place: the
    // next sync would upsert the same physical roll under its REAL row id and
    // the old row would linger, double-counting that stock — the over-promising
    // direction. The mirror is a disposable copy of the ERP, so the correct fix
    // is to drop it and re-pull (the cursor is reset below).
    const [legacyFg] = await db<{ n: string }[]>`
      select count(*)::text as n from information_schema.tables t
       where t.table_name = 'erp_live_fg' and t.table_schema = current_schema()
         and not exists (
           select 1 from information_schema.columns c
            where c.table_name = 'erp_live_fg' and c.table_schema = current_schema()
              and c.column_name = 'erp_row_id'
         )
    `;
    if (Number(legacyFg?.n ?? 0) > 0) {
      console.warn(
        "[migrateErpStock] erp_live_fg predates the 2026-09-11 remap (keyed on sn_fg, which held a " +
          "row id) — dropping and re-pulling it. Upserting the new primary key onto the old rows " +
          "would leave both copies of every roll in the mirror and double-count on-hand.",
      );
      await db`drop table if exists erp_live_fg cascade`;
      needsFullRepull = true;
    }

    await db`
      create table if not exists erp_live_fg (
        erp_row_id     text primary key,             -- tbl_1210_STLiveFGMX_id
        sn_fg          text,                         -- the ERP's roll serial, for humans
        kode_barang    text,                          -- display only; NOT in the key
        brand          text,
        brand_text     text,                          -- resolved name when the ERP sends one
        warna          text,                          -- id into tbl_1228_DBRMWarnaID
        warna_text     text,
        th             numeric,                       -- aluminium skin (tbl_1210.th)
        th_panel       numeric,                       -- total panel (tbl_1210.t)
        p              numeric,
        l              numeric,
        qty            numeric not null default 0,   -- canonical unit: lembar (ST-R5.4)
        qty_m2         numeric,                      -- display only
        buffer_qty     numeric,                      -- does NOT reduce ATP in v1 (OQ-5)
        buffer_status  text,
        lokasi         text,                         -- carried, not a dimension in v1 (OQ-2)
        sku_key        text not null,                -- computed via erp_sku_key(...)
        erp_updated_at timestamptz,
        synced_at      timestamptz not null default now()
      )
    `;
    // The 2026-09-11 remap on a database created between it and now.
    await db`alter table erp_live_fg add column if not exists brand      text`;
    await db`alter table erp_live_fg add column if not exists brand_text text`;
    await db`alter table erp_live_fg add column if not exists warna_text text`;
    await db`alter table erp_live_fg add column if not exists th_panel   numeric`;
    await db`alter table erp_live_fg add column if not exists sn_fg      text`;
    await db`create index if not exists erp_live_fg_sku_idx on erp_live_fg (sku_key)`;
    await db`create index if not exists erp_live_fg_sn_idx  on erp_live_fg (sn_fg)`;
  } catch (liveFgErr) {
    console.error("[migrateErpStock] erp_live_fg step failed (non-fatal):", liveFgErr);
  }

  // ── erp_so_line — mirror of tbl_1203_SOSalesOrderDetailNID; demand ─────────
  // qty_balance is what is still owed; the liveness predicate (ST-R17) filters
  // these rows into v_live_commitments / v_stale_commitments below.
  //
  // 2026-09-11: the verified column list for this table has NO `kode_barang` and
  // NO `th`. It carries `brand`, `warna`, `th_alu_skin` and `total_thickness_acp`,
  // which the adapter writes into the mirror's `brand` / `warna` / `th` /
  // `th_panel` — the same four names the FG side uses, which is the entire point.
  try {
    await db`
      create table if not exists erp_so_line (
        id                text primary key,          -- ERP line PK (tbl_1203_..._id)
        so_id             text,                      -- FK -> erp_so_header.id
        brand             text,
        brand_text        text,
        warna             text,                      -- id into tbl_1228_DBRMWarnaID
        warna_text        text,
        th                numeric,                   -- aluminium skin (tbl_1203.th_alu_skin)
        th_panel          numeric,                   -- total panel (tbl_1203.total_thickness_acp)
        p                 numeric,
        l                 numeric,
        qty_order         numeric,
        qty_delivered     numeric,
        qty_balance       numeric not null default 0,
        status_order      text,
        approval          text,
        auto_approval     text,
        estimate_delivery date,
        summary_spb       text,                      -- goods-out doc (ST-R22 rule 2)
        summary_do        text,                      -- delivery-order doc; context only
        sn_fg             text,                      -- observed NULL in practice (ST-R5.1)
        sku_key           text not null,
        erp_updated_at    timestamptz,
        synced_at         timestamptz not null default now()
      )
    `;
    await db`alter table erp_so_line add column if not exists brand      text`;
    await db`alter table erp_so_line add column if not exists brand_text text`;
    await db`alter table erp_so_line add column if not exists warna_text text`;
    await db`alter table erp_so_line add column if not exists th_panel   numeric`;
    // ST-R22 rule 2 (2026-09-14). `summary_spb` is the goods-out document — the
    // whole basis of the SPB auto-close — and `summary_do` rides along beside it
    // as review-screen context so the pair needs one migration, not two.
    //
    // ADDITIVE AND NULLABLE ON PURPOSE: an existing mirror gets the columns here
    // without a re-pull, and every row already mirrored carries NULL in them until
    // it is next fetched. NULL is not an SPB, so the rule is a NO-OP over stale
    // rows — it starts acting on a line only once that line has been re-synced.
    // Nothing is auto-closed on the strength of a column we have not read yet.
    await db`alter table erp_so_line add column if not exists summary_spb text`;
    await db`alter table erp_so_line add column if not exists summary_do  text`;
    // The SPB predicate scans this column on every view read; partial, because the
    // qualifying rows are the minority and a NULL-heavy column indexes badly whole.
    await db`
      create index if not exists erp_so_line_spb_idx on erp_so_line (sku_key)
      where summary_spb is not null
    `;
    // `kode_barang` was v1's first key segment and does not exist upstream at
    // all. Dropping it is what stops a future query quietly joining on a column
    // that is NULL for every row. The commitment views select `l.*`, so they
    // depend on it and must go first — they are recreated at the end of this
    // same run. Guarded on the column actually being present so the drop/recreate
    // window happens exactly once, on the migration that removes it, and never
    // on an ordinary boot.
    const [legacy] = await db<{ n: string }[]>`
      select count(*)::text as n from information_schema.columns
       where table_name = 'erp_so_line' and column_name = 'kode_barang'
         and table_schema = current_schema()
    `;
    if (Number(legacy?.n ?? 0) > 0) {
      needsFullRepull = true; // the key composition changed with it
      console.warn(
        "[migrateErpStock] dropping erp_so_line.kode_barang — tbl_1203 has no such column " +
          "(verified 2026-09-11); the SKU key now uses brand/warna/th/th_panel/p/l. " +
          "The commitment views are dropped with it and recreated later in this run.",
      );
      await db`drop view if exists v_live_commitments cascade`;
      await db`drop view if exists v_stale_commitments cascade`;
      await db`alter table erp_so_line drop column if exists kode_barang`;
    }
    await db`create index if not exists erp_so_line_sku_idx  on erp_so_line (sku_key)`;
    await db`create index if not exists erp_so_line_live_idx on erp_so_line (approval, qty_balance, estimate_delivery)`;
    await db`create index if not exists erp_so_line_so_idx   on erp_so_line (so_id)`;
  } catch (soLineErr) {
    console.error("[migrateErpStock] erp_so_line step failed (non-fatal):", soLineErr);
  }

  // ── erp_so_header — mirror of tbl_1202_SOSalesOrderNID; who/when ───────────
  try {
    await db`
      create table if not exists erp_so_header (
        id                 text primary key,
        so_number          text,
        customer_name_text text,
        sales_name_text    text,
        po_date            date,
        status_order       text,
        erp_updated_at     timestamptz,
        synced_at          timestamptz not null default now()
      )
    `;
  } catch (soHeaderErr) {
    console.error("[migrateErpStock] erp_so_header step failed (non-fatal):", soHeaderErr);
  }

  // ── erp_warna — mirror of tbl_1228_DBRMWarnaID; the colour master ──────────
  // `warna` on both mirrored tables is an ID, not a name: warna = 4 is
  // "BLACK GALAXY" (273 rows, verified 2026-09-11). Matching by id is correct
  // and unchanged — this table exists only so a human reads a colour instead of
  // a number. The code a mirrored row carries is matched against `code` (the
  // master's own `warna_code`, when it has one), then against `id`, then
  // numerically via `code_num` so a mirrored '004' still finds a master '4'.
  // All three are written by the sync adapter, never derived in SQL, so there is
  // one normalization rule and it lives in TypeScript.
  try {
    await db`
      create table if not exists erp_warna (
        id             text primary key,             -- tbl_1228_DBRMWarnaID_id
        code           text,                         -- the colour code a mirrored row carries
        code_num       numeric,                      -- that code as a number, when it is one
        rm_warna       text,                         -- the display name, e.g. 'BLACK GALAXY'
        erp_updated_at timestamptz,
        synced_at      timestamptz not null default now()
      )
    `;
    await db`alter table erp_warna add column if not exists code text`;
    await db`create index if not exists erp_warna_code_idx     on erp_warna (code_num)`;
    await db`create index if not exists erp_warna_code_txt_idx on erp_warna (code)`;
  } catch (warnaErr) {
    console.error("[migrateErpStock] erp_warna step failed (non-fatal):", warnaErr);
  }

  // ── stock_adjustments — ST-R12 / ST-R20 physical opname corrections ────────
  // Signed and additive. NEVER an update of erp_live_fg: the mirror stays a
  // faithful copy of the ERP and the correction is a separate, audited term in
  // the ATP formula. qty_delta = 0 is rejected at the route (a no-op with a
  // reason attached is noise, not an audit trail).
  try {
    await db`
      create table if not exists stock_adjustments (
        id         bigserial primary key,
        sku_key    text not null,
        qty_delta  numeric not null,          -- signed; 0 rejected
        reason     text not null,             -- required (ST-R12)
        actor      text not null,
        created_at timestamptz not null default now()
      )
    `;
    await db`create index if not exists stock_adjustments_sku_idx on stock_adjustments (sku_key)`;
  } catch (adjustmentsErr) {
    console.error("[migrateErpStock] stock_adjustments step failed (non-fatal):", adjustmentsErr);
  }

  // ── stock_commitment_overrides — ST-R18 / ST-R21 confirm-close, reversible ──
  // One row per SO line, keyed by the ERP line id. state='closed' drops the line
  // out of BOTH views; 'reinstated' puts it back. The row is kept either way so
  // the decision has an actor and a timestamp.
  try {
    await db`
      create table if not exists stock_commitment_overrides (
        so_line_id text primary key,
        state      text not null,             -- 'closed' | 'reinstated'
        reason     text,
        actor      text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;
  } catch (overridesErr) {
    console.error("[migrateErpStock] stock_commitment_overrides step failed (non-fatal):", overridesErr);
  }

  // ── erp_sync_state — the updated_at cursor per mirrored table (ST-R6) ──────
  // The cursor advances only after a page batch commits; on failure last_error
  // is recorded and the cursor stays put so the old mirror remains readable
  // (ST-R7). `running` is the overlap guard — a stale one is reclaimed by the
  // worker, which is why last_ok_at is kept alongside it.
  try {
    await db`
      create table if not exists erp_sync_state (
        table_name    text primary key,       -- 'live_fg' | 'so_line' | 'so_header' | 'warna'
        cursor_value  timestamptz,
        last_ok_at    timestamptz,
        last_error    text,
        last_error_kind text,                  -- 'auth' | 'network' | 'shape' | ... (FIX D)
        last_error_at timestamptz,
        rows_synced   bigint not null default 0,
        running       boolean not null default false
      )
    `;
    await db`alter table erp_sync_state add column if not exists last_error_kind text`;
    for (const t of ["live_fg", "so_line", "so_header", "warna"]) {
      await db`
        insert into erp_sync_state (table_name) values (${t})
        on conflict (table_name) do nothing
      `;
    }
    // The one-time re-pull, requested by a structural change above. Cursors
    // only ever move forward, so this is the only way a row written under the
    // retired SKU key is ever recomputed.
    if (needsFullRepull) {
      console.warn(
        "[migrateErpStock] resetting every ERP sync cursor — the mirror predates the 2026-09-11 " +
          "remap, so its stored sku_key values were computed with the retired composition and " +
          "would never match again. The next sync re-pulls each table in full (every write is an " +
          "idempotent upsert, so this is safe).",
      );
      await db`update erp_sync_state set cursor_value = null`;
    }
  } catch (syncStateErr) {
    console.error("[migrateErpStock] erp_sync_state step failed (non-fatal):", syncStateErr);
  }

  // ── The views — where the liveness rule lives, exactly once (§2.3, §7.3) ───
  // Recreated on every boot because <window_days> and the status sets are config,
  // not literals, and a view cannot read process env. Every value is validated
  // before it is spliced; nothing else in this file is spliced at all.
  try {
    await applyCommitmentViews(db, buildCommitmentViewSql(commitmentRuleConfig()));
  } catch (viewsErr) {
    console.error("[migrateErpStock] commitment views step failed (non-fatal):", viewsErr);
  }

  // ── ST-R7b sanity check — the part that turns a silent catastrophe into a log ─
  // Runs last, on every boot, and never blocks it (§7.7).
  await checkCommitmentGate(db);
}

// ── The commitment-gate sanity check (ST-R7b) ────────────────────────────────

/** Enough distinct values to diagnose a casing/enum mismatch, few enough to read. */
const MAX_OBSERVED_APPROVALS = 10;

export interface CommitmentGateReport {
  /** False when the query could not run at all (no mirror tables yet, DB down). */
  checked: boolean;
  soLines: number;
  liveCommitments: number;
  /** Mirror has approved-shaped demand but the view is empty ⇒ the gate misses. */
  tripped: boolean;
  /** Distinct `approval` values actually present in the mirror, capped. */
  observedApprovals: string[];
  configuredApprovals: readonly string[];
}

/**
 * WARN-ONLY. Never throws, never blocks boot (invariant §7.7).
 *
 * The failure this exists for: `STOCK_APPROVED_STATUSES` does not match what the
 * ERP actually emits. Nobody in this repo has seen a real Selaras response
 * (HANDOVER §2), so the shipped default `Approved` is a guess. If the live value
 * is `APPROVED` or `Approve` or `1`, `v_live_commitments` returns zero rows,
 * `open_commitment` is zero for every SKU, `ATP = on_hand`, and every screen
 * reads *healthier* than the truth — the one failure mode nobody reports.
 *
 * So: mirror non-empty + live view empty ⇒ one loud line naming the configured
 * values, the values actually in the mirror, and the env var that fixes it.
 *
 * Note it cannot fire on the *cancelled* set, which fails the other way (a
 * cancelled line keeps reserving ⇒ ATP understated ⇒ somebody complains).
 */
export async function checkCommitmentGate(
  db: Sql = getSql()!,
  log: { warn(msg: string): void } = { warn: (m) => console.warn(m) },
): Promise<CommitmentGateReport> {
  const configuredApprovals = safeApprovedStatuses(config.stock.approvedStatuses);
  const empty: CommitmentGateReport = {
    checked: false,
    soLines: 0,
    liveCommitments: 0,
    tripped: false,
    observedApprovals: [],
    configuredApprovals,
  };

  try {
    // Two cheap existence probes, not two full counts: `limit 1` inside the
    // subquery means neither touches more than one row on a healthy mirror.
    const [probe] = await db<{ has_lines: boolean; has_live: boolean }[]>`
      select exists (select 1 from erp_so_line limit 1)                as has_lines,
             exists (select 1 from v_live_commitments limit 1)         as has_live
    `;
    if (!probe) return empty;
    if (!probe.has_lines || probe.has_live) {
      return { ...empty, checked: true, soLines: probe.has_lines ? 1 : 0, liveCommitments: probe.has_live ? 1 : 0 };
    }

    // Only now — in the bad state, once — pay for the real numbers.
    const [counts] = await db<{ so_lines: string; open_lines: string }[]>`
      select count(*)::text                                       as so_lines,
             count(*) filter (where qty_balance > 0)::text         as open_lines
      from erp_so_line
    `;
    const observed = await db<{ approval: string | null; n: string }[]>`
      select approval, count(*)::text as n
      from erp_so_line
      where qty_balance > 0
      group by approval
      order by count(*) desc
      limit ${MAX_OBSERVED_APPROVALS}
    `;
    const observedApprovals = observed.map((r) => `${r.approval === null ? "<null>" : r.approval} (${r.n})`);
    const soLines = Number(counts?.so_lines ?? 0);
    const openLines = Number(counts?.open_lines ?? 0);

    // The one provably-correct empty: every mirrored line is fully delivered, so
    // `qty_balance > 0` holds nowhere and an empty live view is the right answer
    // regardless of the approval gate. Warning here would fire on every boot
    // forever and train people to ignore the line — which is precisely how the
    // real alert gets missed. Stay quiet; nothing is being over-promised.
    if (openLines === 0) {
      return { ...empty, checked: true, soLines, observedApprovals, liveCommitments: 0 };
    }

    log.warn(
      `[stock] COMMITMENT GATE MATCHES NOTHING — erp_so_line holds ${soLines} mirrored line(s) ` +
        `(${openLines} with qty_balance > 0) but v_live_commitments is EMPTY. Every SKU's ` +
        `open_commitment is therefore 0 and ATP equals on-hand: the whole inventory currently reads ` +
        `as promiseable. Configured approved statuses: [${configuredApprovals.join(", ")}]. ` +
        `Distinct \`approval\` values actually in the mirror: ` +
        `[${observedApprovals.length > 0 ? observedApprovals.join(", ") : "none"}]. ` +
        `FIX: set STOCK_APPROVED_STATUSES to the value(s) the ERP really emits (CSV) and restart — ` +
        `the views are rebuilt from it on every boot. ST-R7b / OQ-1.`,
    );

    return {
      checked: true,
      soLines,
      liveCommitments: 0,
      tripped: true,
      observedApprovals,
      configuredApprovals,
    };
  } catch (err) {
    // A missing view or an unreachable DB is not this function's problem to
    // solve, and it must never be the reason the app fails to boot (§7.7).
    console.error("[migrateErpStock] commitment-gate sanity check skipped (non-fatal):", err);
    return empty;
  }
}

// ── ST-R5.2 safety net: does the SKU key actually match anything? ────────────
//
// The 2026-09-11 key composition is verified against the ERP's documented
// COLUMNS. It has never been run against real ROWS — ST-R5.2 (fill/overlap
// validation) needs live data and could not be performed here. So the mirror
// measures the thing the validation would have measured, on every sync.
//
// The failure mode is the same one `checkCommitmentGate()` exists for, arriving
// through a different door: if demand and supply key differently, every
// commitment lands in the exceptions tray, `open_commitment` is 0 for every SKU,
// ATP equals on-hand, and the entire inventory reads as promiseable on a page
// that looks perfectly healthy. Nobody reports good news, so it has to shout.
//
// A few unmatched keys are NORMAL — genuine demand for something we hold no
// stock of is exactly what ST-R5.3's exceptions tray is for. A MAJORITY
// unmatched is not normal; it is what a broken key composition looks like.

/** Enough example keys to compare the two sides by eye, few enough to read. */
const MAX_KEY_SAMPLES = 3;

export interface SkuKeyMatchReport {
  /** False when the query could not run at all (no mirror tables yet, DB down). */
  checked: boolean;
  liveLines: number;
  unmatchedLines: number;
  liveKeys: number;
  unmatchedKeys: number;
  /** unmatchedLines / liveLines, or 0 when there is no live demand at all. */
  ratio: number;
  /** True ⇒ the alert fired: live demand exists and most of it matches no stock. */
  tripped: boolean;
  /** Example sku_keys from the demand side and from the stock side. */
  soSamples: string[];
  fgSamples: string[];
  threshold: number;
}

/**
 * WARN-ONLY. Never throws, never blocks a sync or a boot (invariant §7.7).
 *
 * `log.error` rather than `warn`: a 100% unmatched rate means ATP silently
 * equals on-hand across the catalogue, which is the single most expensive thing
 * this module can get wrong.
 */
export async function checkSkuKeyMatch(
  db: Sql = getSql()!,
  log: { error(msg: string): void } = { error: (m) => console.error(m) },
  threshold: number = config.stock.unmatchedAlertRatio,
): Promise<SkuKeyMatchReport> {
  const empty: SkuKeyMatchReport = {
    checked: false,
    liveLines: 0,
    unmatchedLines: 0,
    liveKeys: 0,
    unmatchedKeys: 0,
    ratio: 0,
    tripped: false,
    soSamples: [],
    fgSamples: [],
    threshold,
  };

  try {
    const [counts] = await db<
      { live_lines: string; unmatched_lines: string; live_keys: string; unmatched_keys: string }[]
    >`
      with live as (
        select v.sku_key,
               not exists (select 1 from erp_live_fg f where f.sku_key = v.sku_key) as unmatched
        from v_live_commitments v
      )
      select count(*)::text                                              as live_lines,
             count(*) filter (where unmatched)::text                     as unmatched_lines,
             count(distinct sku_key)::text                               as live_keys,
             count(distinct sku_key) filter (where unmatched)::text      as unmatched_keys
      from live
    `;
    const liveLines = Number(counts?.live_lines ?? 0);
    const unmatchedLines = Number(counts?.unmatched_lines ?? 0);
    const liveKeys = Number(counts?.live_keys ?? 0);
    const unmatchedKeys = Number(counts?.unmatched_keys ?? 0);
    const ratio = liveLines > 0 ? unmatchedLines / liveLines : 0;

    // No live demand at all ⇒ nothing to match and nothing to say. Warning here
    // would fire on every empty deployment forever, which is how a real alert
    // gets trained into background noise.
    if (liveLines === 0 || ratio <= threshold) {
      return { ...empty, checked: true, liveLines, unmatchedLines, liveKeys, unmatchedKeys, ratio };
    }

    const soRows = await db<{ sku_key: string }[]>`
      select distinct v.sku_key
        from v_live_commitments v
       where not exists (select 1 from erp_live_fg f where f.sku_key = v.sku_key)
       order by 1
       limit ${MAX_KEY_SAMPLES}
    `;
    const fgRows = await db<{ sku_key: string }[]>`
      select distinct sku_key from erp_live_fg order by 1 limit ${MAX_KEY_SAMPLES}
    `;
    const soSamples = soRows.map((r) => r.sku_key);
    const fgSamples = fgRows.map((r) => r.sku_key);
    const pct = Math.round(ratio * 1000) / 10;

    log.error(
      `[stock] SKU KEY MATCHES ALMOST NOTHING — ${unmatchedLines} of ${liveLines} live commitment ` +
        `line(s) (${pct}%, ${unmatchedKeys} of ${liveKeys} distinct sku_key(s)) match NO row in ` +
        `erp_live_fg. Those commitments reserve nothing, so ATP equals on-hand for their SKUs and ` +
        `that stock reads as fully promiseable. Demand-side keys e.g. ` +
        `[${soSamples.join(" , ") || "none"}]; stock-side keys e.g. [${fgSamples.join(" , ") || "none"}]. ` +
        `Compare them segment by segment: the knob is STOCK_SKU_KEY_SEGMENTS ` +
        `(current composition ${SKU_SEGMENTS.join("|")}), and the per-side column mapping is ` +
        `SKU_SEGMENT_SOURCES in erp/sku.ts. Alert threshold ${threshold} ` +
        `(STOCK_UNMATCHED_ALERT_RATIO). ST-R5.2 / ST-R5.3.`,
    );

    return {
      checked: true,
      liveLines,
      unmatchedLines,
      liveKeys,
      unmatchedKeys,
      ratio,
      tripped: true,
      soSamples,
      fgSamples,
      threshold,
    };
  } catch (err) {
    console.error("[migrateErpStock] sku-key match check skipped (non-fatal):", err);
    return empty;
  }
}

// Allow `tsx src/db/migrateErpStock.ts` as a one-off.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("migrateErpStock.ts")) {
  const db = getSql();
  if (!db) {
    console.error("DATABASE_URL not set — nothing to migrate.");
    process.exit(1);
  }
  runErpStockMigrations(db)
    .then(() => {
      console.log("✓ erp stock migrations applied");
      return db.end();
    })
    .catch((err) => {
      console.error("erp stock migration failed:", err);
      process.exit(1);
    });
}
