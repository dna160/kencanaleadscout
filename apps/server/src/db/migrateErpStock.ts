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
 * No table here has an `atp` column and none ever will (§7.1). The liveness
 * predicate (ST-R17) is spelled exactly once, in v_live_commitments (§7.3), and
 * the canonical SKU key exactly twice — erp/sku.ts and erp_sku_key() below (§7.4).
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

/** Fixed parameter name per segment. The function always takes all five. */
const SKU_SEGMENT_ARGS: Record<SkuSegmentName, string> = {
  kode_barang: "p_kode_barang",
  warna: "p_warna",
  th: "p_th",
  p: "p_p",
  l: "p_l",
};

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
 * The parameter list is fixed at all five columns even when the configured
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
      p_kode_barang text,
      p_warna       text,
      p_th          numeric,
      p_p           numeric,
      p_l           numeric
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

/** `array['Cancelled','Void','Batal']`, or a typed empty array when the set is empty. */
function statusArraySql(statuses: readonly string[]): string {
  if (statuses.length === 0) return "array[]::text[]";
  return `array[${statuses.map((s) => `'${s}'`).join(", ")}]`;
}

export async function runErpStockMigrations(db: Sql = getSql()!): Promise<void> {
  // ── erp_sku_key() — the SQL half of the canonical key (ST-R5.1) ─────────────
  // First, because everything that mirrors a row computes a sku_key with it.
  try {
    await db.unsafe(buildSkuKeyFunctionSql());
  } catch (skuKeyErr) {
    console.error("[migrateErpStock] erp_sku_key step failed (non-fatal):", skuKeyErr);
  }

  // ── erp_live_fg — mirror of tbl_1210_STLiveFGMX; physical on-hand ──────────
  // sn_fg is the ERP serial and the natural PK. sku_key is the product identity
  // the SO side joins on (SO rows carry sn_fg = NULL) — see erp/sku.ts.
  try {
    await db`
      create table if not exists erp_live_fg (
        sn_fg          text primary key,
        kode_barang    text,
        warna          text,
        th             numeric,
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
    await db`create index if not exists erp_live_fg_sku_idx on erp_live_fg (sku_key)`;
  } catch (liveFgErr) {
    console.error("[migrateErpStock] erp_live_fg step failed (non-fatal):", liveFgErr);
  }

  // ── erp_so_line — mirror of tbl_1203_SOSalesOrderDetailNID; demand ─────────
  // qty_balance is what is still owed; the liveness predicate (ST-R17) filters
  // these rows into v_live_commitments / v_stale_commitments below.
  try {
    await db`
      create table if not exists erp_so_line (
        id                text primary key,          -- ERP line PK
        so_id             text,                      -- FK -> erp_so_header.id
        kode_barang       text,
        warna             text,
        th                numeric,
        p                 numeric,
        l                 numeric,
        qty_order         numeric,
        qty_delivered     numeric,
        qty_balance       numeric not null default 0,
        status_order      text,
        approval          text,
        auto_approval     text,
        estimate_delivery date,
        sn_fg             text,                      -- observed NULL in practice (ST-R5.1)
        sku_key           text not null,
        erp_updated_at    timestamptz,
        synced_at         timestamptz not null default now()
      )
    `;
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
        table_name    text primary key,       -- 'live_fg' | 'so_line' | 'so_header'
        cursor_value  timestamptz,
        last_ok_at    timestamptz,
        last_error    text,
        last_error_at timestamptz,
        rows_synced   bigint not null default 0,
        running       boolean not null default false
      )
    `;
    for (const t of ["live_fg", "so_line", "so_header"]) {
      await db`
        insert into erp_sync_state (table_name) values (${t})
        on conflict (table_name) do nothing
      `;
    }
  } catch (syncStateErr) {
    console.error("[migrateErpStock] erp_sync_state step failed (non-fatal):", syncStateErr);
  }

  // ── The views — where the liveness rule lives, exactly once (§2.3, §7.3) ───
  // Recreated on every boot because <window_days> and the cancelled set are
  // config, not literals, and a view cannot read process env. Both values are
  // validated above before they are spliced; nothing else in this file is.
  try {
    const windowDays = safeWindowDays(config.stock.staleWindowDays);
    const cancelled = statusArraySql(safeCancelledStatuses(config.stock.cancelledStatuses));
    // ST-R7b: the commitment gate is config, not a literal (OQ-1). Same validated
    // whitelist path as the cancelled set — nothing unvalidated reaches SQL.
    const approved = statusArraySql(safeApprovedStatuses(config.stock.approvedStatuses));

    // The shared FROM/JOIN spine. A line that is confirm-closed leaves both sets.
    // `undated` (AMENDMENT 1) lets the PPIC queue separate two populations whose
    // close consequences are opposite: closing a stale line moves ATP by zero,
    // closing an undated one raises it by the whole balance (AMENDMENT 6).
    // AMENDMENT 12 — `po_date` rides along on every commitment shape. An undated
    // line has no ETA to age from, so the order date is the only way to show how
    // old it is, on exactly the population that reserves stock. It lives on the
    // header, so the views are the only place it can be picked up once.
    const spine = (etaPredicate: string) => `
      select l.*, h.customer_name_text, h.sales_name_text, h.so_number, h.po_date,
             (l.estimate_delivery is null) as undated
      from erp_so_line l
      left join erp_so_header h on h.id = l.so_id
      left join stock_commitment_overrides o on o.so_line_id = l.id
      where l.approval = any (${approved})
        and l.qty_balance > 0
        and coalesce(l.status_order, '') <> all (${cancelled})
        and ${etaPredicate}
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
    const views: ReadonlyArray<readonly [string, string]> = [
      ["v_live_commitments", spine(
        `(l.estimate_delivery >= current_date - ${windowDays} or l.estimate_delivery is null)`,
      )],
      ["v_stale_commitments", spine(`l.estimate_delivery < current_date - ${windowDays}`)],
    ];

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
