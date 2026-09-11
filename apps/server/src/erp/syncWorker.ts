/**
 * Stock 2.0 — Selaras → LeadScout mirror sync worker (CONTRACTS §5, ST-R6/R7).
 *
 * WHAT THIS IS: a periodic, **idempotent** copier. It pages the three ERP tables
 * in the order `so_header` → `so_line` → `live_fg` (lines reference headers) and
 * upserts every row by its ERP primary key. That is the whole design.
 *
 * WHAT THIS IS NOT, and must never become: a delta applier. There is no
 * `qty = qty - n` anywhere in this file and there never will be. Running one
 * sync window once or ten times yields byte-identical mirror rows and identical
 * ATP, which is the acceptance criterion (§5) and the reason PRD §3 exists — the
 * 1.0 module double-subtracted because it mutated stock incrementally. If you
 * find yourself reaching for an incremental write here, stop: the fix is a
 * different upsert, not a delta.
 *
 * CURSOR DISCIPLINE (ST-R7): `erp_sync_state.cursor_value` advances ONLY inside
 * the same transaction that commits a page's rows. A failed page records
 * `last_error` / `last_error_at`, leaves the cursor exactly where it was, and
 * leaves the previously mirrored rows readable — a broken ERP degrades freshness,
 * never correctness.
 *
 * SURVIVABILITY: the interval callback cannot throw. Every path is wrapped, and
 * `selarasClient.fetchPage()` resolves rather than rejects, so an ERP outage
 * costs a log line and a stale banner, not the process.
 *
 * CRASH SAFETY: the `running` flag is the overlap guard, and a `running` row
 * whose last activity is older than 3× the sync interval is treated as abandoned
 * and reclaimed. Without that, one SIGKILL mid-run would disable sync forever.
 *
 * SECRETS: every string this file emits goes through `redactSecrets()` (invariant
 * §7.9). The ERP token is never read here at all — it lives in the client.
 */
import postgres from "postgres";
import { config, hasDatabase, hasErp } from "../config.js";
import { getSql, type Sql } from "../db/client.js";
import { checkCommitmentGate, checkSkuKeyMatch } from "../db/migrateErpStock.js";
import {
  cursorParam,
  describeColumnDiagnostic,
  redactSecrets,
  selarasClient,
  SELARAS_KEY_FIELDS,
  SYNC_TABLES,
  type SelarasClient,
  type SelarasTable,
  type LiveFgRow,
  type SoHeaderRow,
  type SelarasFailureKind,
  type SoLineRow,
  type WarnaRow,
} from "./selarasClient.js";

type AnySql = Sql | postgres.TransactionSql<{}>;

/**
 * Safety rail against an ERP that ignores `page` (or reports a wrong
 * `total_pages`): at the default page size this is 1,000,000 rows per table per
 * run, far beyond any plausible window, so hitting it means the pagination
 * contract (A2) is wrong — which the log says out loud.
 */
const MAX_PAGES_PER_TABLE = 1_000;

/** A `running` row idle for this many intervals is a crashed run, not a live one. */
const STALE_LOCK_INTERVALS = 3;

// ── Logging ──────────────────────────────────────────────────────────────────

export interface SyncLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Redaction is applied HERE, centrally, rather than trusted to each call site —
 * one forgotten interpolation at a call site would otherwise be a token leak.
 */
export const defaultSyncLogger: SyncLogger = {
  info: (m) => console.info(`[erp-sync] ${redactSecrets(m)}`),
  warn: (m) => console.warn(`[erp-sync] ${redactSecrets(m)}`),
  error: (m) => console.error(`[erp-sync] ${redactSecrets(m)}`),
};

// ── Result shapes ────────────────────────────────────────────────────────────

export interface SyncTableResult {
  table: SelarasTable;
  ok: boolean;
  pages: number;
  /** Rows upserted (an upsert of an unchanged row still counts — it is a write). */
  rows: number;
  /** Rows the ERP sent that no adapter could key. Dropped, never fatal. */
  dropped: number;
  /**
   * Rows the ERP marked `deleted_at` and that were therefore removed from the
   * mirror (or never written). FIX 6: this is the routine deletion path; the
   * hourly reconciliation sweep is only the backstop for hard deletes.
   */
  deleted: number;
  /**
   * Numeric strings refused as ambiguous under `SELARAS_NUMBER_FORMAT=auto`
   * (A22) — "1.234" is 1234 in id notation and 1.234 in en notation, so it is
   * refused rather than guessed. Surfaced here so the manual-kick route can show
   * it without a schema change.
   */
  ambiguousNumbers: number;
  /**
   * Numerics refused for being NaN / ±Infinity (X11). Postgres accepts both in a
   * `numeric` column, and one stored in `th`/`p`/`l` would desynchronise the TS
   * and SQL sku_key implementations silently. None is ever written.
   */
  nonFiniteNumbers: number;
  /**
   * Date/timestamp values that were present and unreadable — MySQL's
   * `0000-00-00` zero date, above all. Each one is NULL in the mirror and never
   * fatal: handing an Invalid Date (or a string that becomes one) to postgres.js
   * throws `RangeError: Invalid time value` inside the page transaction, which
   * used to abort the whole so_header pass and pin its cursor permanently.
   */
  badDates: number;
  error?: string;
  cursorBefore: Date | null;
  cursorAfter: Date | null;
}

export interface SyncRunResult {
  started: boolean;
  /**
   * Why nothing ran: another run holds the guard, the ERP/DB is not configured,
   * or — full re-sync only — the cursor reset itself failed, in which case NO
   * table was pulled and nothing was cleared (see `executeRun`).
   */
  skipped?: "in_flight" | "disabled" | "locked" | "cursor_reset_failed";
  /** True when this pass cleared the stored cursors first and re-pulled everything. */
  full: boolean;
  /** Cursors actually cleared (0 on an incremental run, and on a first-ever full one). */
  cursorsCleared: number;
  /** The cheap in-place repair, always attempted first on a full re-sync. */
  recompute?: SkuKeyRecomputeResult;
  tables: SyncTableResult[];
  durationMs: number;
}

/** Why a table's reconciliation removed nothing. Every value is a REFUSAL to purge. */
export type ReconcileAbortReason =
  | "fetch_failed" // the ERP never gave us a complete key set
  | "empty_key_set" // it answered, with nothing — a truncating bug, not an empty ERP
  | "ratio_guard" // it answered with implausibly few keys vs what we hold
  | "page_cap"; // pagination looks broken, so the key set is incomplete

export interface ReconcileTableResult {
  table: SelarasTable;
  ok: boolean;
  /** Rows in the mirror before the sweep. */
  mirrored: number;
  /** Distinct primary keys the ERP reported as currently existing. */
  erpKeys: number;
  /** Mirror rows deleted because the ERP no longer lists their key. */
  removed: number;
  pages: number;
  /** Present only when the sweep declined to purge. `removed` is then always 0. */
  aborted?: ReconcileAbortReason;
  error?: string;
  /** False ⇒ the ERP ignored `fields=`; full rows were pulled. Correct, just costly. */
  projected: boolean;
}

export interface ReconcileRunResult {
  started: boolean;
  skipped?: "in_flight" | "disabled" | "locked";
  tables: ReconcileTableResult[];
  durationMs: number;
}

// ── Per-table write paths (the only writers of erp_*; invariant §7.2) ────────

/**
 * A page can legitimately contain the same primary key twice (an ERP that pages
 * a live table while it is being written). `on conflict do update` refuses to
 * touch the same row twice in one statement, so the batch is deduped first,
 * last-wins — which matches the ascending `updated_at` ordering we request.
 */
function dedupeByKey<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(key(row), row);
  return [...byKey.values()];
}

/**
 * `synced_at` is refreshed on every upsert on purpose: it records when this row
 * was last CONFIRMED against the ERP, which is what the freshness surfaces need.
 * It is sync bookkeeping, not mirrored content — the idempotency guarantee is
 * over the mirrored business columns and over ATP, neither of which reads it.
 */
async function upsertSoHeaders(tx: AnySql, rows: readonly SoHeaderRow[]): Promise<number> {
  const batch = dedupeByKey(rows, (r) => r.id);
  if (batch.length === 0) return 0;
  await tx`
    insert into erp_so_header ${tx(
      batch,
      "id",
      "so_number",
      "customer_name_text",
      "sales_name_text",
      "po_date",
      "status_order",
      "erp_updated_at",
    )}
    on conflict (id) do update set
      so_number          = excluded.so_number,
      customer_name_text = excluded.customer_name_text,
      sales_name_text    = excluded.sales_name_text,
      po_date            = excluded.po_date,
      status_order       = excluded.status_order,
      erp_updated_at     = excluded.erp_updated_at,
      synced_at          = now()
  `;
  return batch.length;
}

async function upsertSoLines(tx: AnySql, rows: readonly SoLineRow[]): Promise<number> {
  const batch = dedupeByKey(rows, (r) => r.id);
  if (batch.length === 0) return 0;
  // sku_key is computed in TypeScript by canonicalSkuKey() (in the adapter) and
  // written as a plain column — A14: NOT a generated column, because
  // `create or replace function` does not recheck generated-column dependents,
  // so a body change would silently desynchronise stored keys.
  await tx`
    insert into erp_so_line ${tx(
      batch,
      "id",
      "so_id",
      "brand",
      "brand_text",
      "warna",
      "warna_text",
      "th",
      "th_panel",
      "p",
      "l",
      "qty_order",
      "qty_delivered",
      "qty_balance",
      "status_order",
      "approval",
      "auto_approval",
      "estimate_delivery",
      "sn_fg",
      "sku_key",
      "erp_updated_at",
    )}
    on conflict (id) do update set
      so_id             = excluded.so_id,
      brand             = excluded.brand,
      brand_text        = excluded.brand_text,
      warna             = excluded.warna,
      warna_text        = excluded.warna_text,
      th                = excluded.th,
      th_panel          = excluded.th_panel,
      p                 = excluded.p,
      l                 = excluded.l,
      qty_order         = excluded.qty_order,
      qty_delivered     = excluded.qty_delivered,
      qty_balance       = excluded.qty_balance,
      status_order      = excluded.status_order,
      approval          = excluded.approval,
      auto_approval     = excluded.auto_approval,
      estimate_delivery = excluded.estimate_delivery,
      sn_fg             = excluded.sn_fg,
      sku_key           = excluded.sku_key,
      erp_updated_at    = excluded.erp_updated_at,
      synced_at         = now()
  `;
  return batch.length;
}

async function upsertLiveFg(tx: AnySql, rows: readonly LiveFgRow[]): Promise<number> {
  const batch = dedupeByKey(rows, (r) => r.erp_row_id);
  if (batch.length === 0) return 0;
  await tx`
    insert into erp_live_fg ${tx(
      batch,
      "erp_row_id",
      "sn_fg",
      "kode_barang",
      "brand",
      "brand_text",
      "warna",
      "warna_text",
      "th",
      "th_panel",
      "p",
      "l",
      "qty",
      "qty_m2",
      "buffer_qty",
      "buffer_status",
      "lokasi",
      "sku_key",
      "erp_updated_at",
    )}
    on conflict (erp_row_id) do update set
      sn_fg          = excluded.sn_fg,
      kode_barang    = excluded.kode_barang,
      brand          = excluded.brand,
      brand_text     = excluded.brand_text,
      warna          = excluded.warna,
      warna_text     = excluded.warna_text,
      th             = excluded.th,
      th_panel       = excluded.th_panel,
      p              = excluded.p,
      l              = excluded.l,
      qty            = excluded.qty,
      qty_m2         = excluded.qty_m2,
      buffer_qty     = excluded.buffer_qty,
      buffer_status  = excluded.buffer_status,
      lokasi         = excluded.lokasi,
      sku_key        = excluded.sku_key,
      erp_updated_at = excluded.erp_updated_at,
      synced_at      = now()
  `;
  return batch.length;
}

/**
 * The colour master (FIX 7). Tiny, and mirrored exactly like the others so it
 * shares the cursor, the lock, the failure handling and the idempotency
 * guarantee rather than growing a second, subtly different sync path.
 */
async function upsertWarna(tx: AnySql, rows: readonly WarnaRow[]): Promise<number> {
  const batch = dedupeByKey(rows, (r) => r.id);
  if (batch.length === 0) return 0;
  await tx`
    insert into erp_warna ${tx(batch, "id", "code", "code_num", "rm_warna", "erp_updated_at")}
    on conflict (id) do update set
      code           = excluded.code,
      code_num       = excluded.code_num,
      rm_warna       = excluded.rm_warna,
      erp_updated_at = excluded.erp_updated_at,
      synced_at      = now()
  `;
  return batch.length;
}

type AnyMirrorRow = SoHeaderRow | SoLineRow | LiveFgRow | WarnaRow;

/** The mirror's primary key for a row, whichever table it came from. */
function rowKey(row: AnyMirrorRow): string {
  return "id" in row ? row.id : row.erp_row_id;
}

async function upsertPage(tx: AnySql, table: SelarasTable, rows: readonly AnyMirrorRow[]): Promise<number> {
  switch (table) {
    case "warna":
      return upsertWarna(tx, rows as readonly WarnaRow[]);
    case "so_header":
      return upsertSoHeaders(tx, rows as readonly SoHeaderRow[]);
    case "so_line":
      return upsertSoLines(tx, rows as readonly SoLineRow[]);
    case "live_fg":
      return upsertLiveFg(tx, rows as readonly LiveFgRow[]);
  }
}

/**
 * SOFT DELETES (FIX 6). Every ERP table carries `deleted_at`; a non-null value
 * means the row is gone upstream. Deleting it here, in the same transaction as
 * the page's upserts, is a far better deletion signal than the hourly
 * reconciliation sweep: it is immediate, it is exact, and it costs one statement
 * on a page that usually has nothing to delete.
 *
 * The sweep STAYS as the backstop — a row hard-deleted upstream still never
 * appears on any page, and this path can only see what the cursor hands it.
 *
 * Three literal statements rather than one interpolated one, for the same reason
 * `purgeAbsent()` is written that way: the table and column names are then not
 * merely whitelisted, they are unreachable from any input.
 */
async function deleteRows(tx: AnySql, table: SelarasTable, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const keys = [...new Set(ids)];
  switch (table) {
    case "warna": {
      const r = await tx`delete from erp_warna where id = any(${keys})`;
      return r.count ?? 0;
    }
    case "so_header": {
      const r = await tx`delete from erp_so_header where id = any(${keys})`;
      return r.count ?? 0;
    }
    case "so_line": {
      const r = await tx`delete from erp_so_line where id = any(${keys})`;
      return r.count ?? 0;
    }
    case "live_fg": {
      const r = await tx`delete from erp_live_fg where erp_row_id = any(${keys})`;
      return r.count ?? 0;
    }
  }
}

// ── erp_sync_state bookkeeping ───────────────────────────────────────────────

interface SyncStateRow {
  table_name: string;
  cursor_value: Date | null;
  running: boolean;
}

async function readCursor(db: Sql, table: SelarasTable): Promise<Date | null> {
  const rows = await db<SyncStateRow[]>`
    select table_name, cursor_value, running from erp_sync_state where table_name = ${table}
  `;
  return rows[0]?.cursor_value ?? null;
}

/**
 * Acquire the run guard over all three rows atomically, or acquire nothing.
 *
 * A row counts as available when it is not running, OR when it is running but
 * has recorded no activity (`last_ok_at` / `last_error_at`) for 3× the interval —
 * a crashed run. Every committed page stamps `last_ok_at` and every failure
 * stamps `last_error_at`, so a genuinely live run always refreshes one of them
 * well inside the window; only an abandoned lock goes quiet.
 *
 * The schema (WP-1, frozen) has no `running_since` column, hence the activity
 * timestamps standing in for one — see the report's challenge note.
 */
async function acquireLock(db: Sql, intervalMs: number): Promise<boolean> {
  const staleMs = Math.max(1, Math.floor(intervalMs * STALE_LOCK_INTERVALS));
  const claimed = await db<{ table_name: string }[]>`
    with candidate as (
      select table_name
        from erp_sync_state
       where table_name = any(${[...SYNC_TABLES]})
         and (
           running = false
           or coalesce(greatest(last_ok_at, last_error_at), to_timestamp(0))
              < now() - (${staleMs}::bigint * interval '1 millisecond')
         )
         -- FOR UPDATE serialises two concurrent claimants on these three rows:
         -- the second blocks here until the first commits, and then re-reads.
         -- Without it both sessions evaluate the CTE on their own snapshot, both
         -- see running = false, and both "acquire" the lock — which is exactly
         -- what two connections reproduced. The UPDATE below additionally
         -- re-tests the predicate in its OWN quals, because the EvalPlanQual
         -- recheck under read-committed only re-applies the UPDATE's quals, not
         -- the CTE's, so the CTE alone can never be the guard.
         -- The order by pins one lock order across sessions, so two claimants
         -- queue rather than deadlock on each other's first row.
       order by table_name
         for update
    )
    update erp_sync_state s
       set running = true
      from candidate c
     where s.table_name = c.table_name
       and (select count(*) from candidate) = ${SYNC_TABLES.length}
       and (
         s.running = false
         or coalesce(greatest(s.last_ok_at, s.last_error_at), to_timestamp(0))
            < now() - (${staleMs}::bigint * interval '1 millisecond')
       )
    returning s.table_name
  `;
  return claimed.length === SYNC_TABLES.length;
}

async function releaseLock(db: Sql): Promise<void> {
  await db`
    update erp_sync_state set running = false
     where table_name = any(${[...SYNC_TABLES]})
  `;
}

/**
 * Clear every stored cursor, so the next pass asks the ERP for the whole table
 * rather than for the window since the last high-water mark. THE ONLY repair for
 * a row that was mirrored WRONG and has since fallen behind the cursor.
 *
 * WHY THIS HAS TO EXIST. Parsing and key composition are applied at WRITE time:
 * `sku_key`, `p`, `l`, `th` and the rest are computed by the adapter and stored
 * as plain columns (A14). A cursor only ever moves forward, so a change to how a
 * value is read — `SELARAS_NUMBER_FORMAT` going from `auto` to `id`, a new key
 * composition, a fixed adapter — reaches exactly the rows that are re-fetched
 * AFTER it and no others. Rows behind the cursor keep whatever the old rules
 * produced, forever, and no amount of incremental syncing will ever revisit them.
 * Production hit this: rows mirrored under `auto` had "2.440" refused as
 * structurally ambiguous, so `p`/`l` were written NULL and their stored key ends
 * `|-|-`. The config is right now; the rows are still wrong.
 *
 * ONE STATEMENT, therefore one transaction, therefore all-or-nothing: there is no
 * state in which half the tables are due a full pull and half are not. It is
 * called ONLY from inside the guarded run, after the lock is held, immediately
 * before the pull that consumes it — a cleared cursor set that nothing follows
 * would turn the NEXT scheduled tick into a surprise 137k-row re-pull.
 *
 * Re-pulling is SAFE, only slow: every write is an upsert by primary key, so a
 * row that is re-fetched and re-written unchanged is byte-identical (§5).
 */
async function clearCursors(db: Sql): Promise<number> {
  const cleared = await db<{ table_name: string }[]>`
    update erp_sync_state
       set cursor_value = null
     where table_name = any(${[...SYNC_TABLES]})
       and cursor_value is not null
    returning table_name
  `;
  return cleared.length;
}

// ── Repair step 1: recompute the stored sku_key in place (NO ERP traffic) ────
//
// THE TWO STALE-KEY SITUATIONS, AND WHICH REPAIR EACH ONE NEEDS. Both look
// identical from the unmatched alarm — "97.4% of live demand matches no stock" —
// and they have completely different costs, so telling them apart matters.
//
//   (a) THE COLUMNS ARE INTACT, THE KEY IS STALE.
//       `brand`/`warna`/`th`/`th_panel`/`p`/`l` in the mirror are right; only the
//       COMPOSITION of the key changed (a segment added, dropped or reordered, or
//       the normalisation rules edited). The key is a pure function of those six
//       columns, and `erp_sku_key()` is the SQL twin of the TypeScript that wrote
//       it (ST-R5.1, byte-identical by test), so the correct key can be derived
//       from what is already stored. This step does exactly that: two UPDATEs,
//       no ERP request, seconds rather than minutes. THIS IS THE CHEAP REPAIR
//       AND IT SHOULD ALWAYS BE TRIED FIRST.
//
//   (b) THE COLUMNS THEMSELVES ARE WRONG.
//       The row was mirrored under parsing rules that produced the wrong VALUE —
//       `SELARAS_NUMBER_FORMAT=auto` refusing "2.440" as structurally ambiguous
//       and writing `p`/`l` as NULL is the production case. Recomputing from the
//       stored columns here reproduces the same broken key, because the inputs
//       are the broken thing. Recompute reports 0 rows changed and the numbers
//       do not move. The ONLY repair is to ask the ERP for those rows again,
//       which means clearing the cursors — see `clearCursors()`.
//
// A run of this step that changes 0 rows is therefore not a no-op result: it is
// the diagnosis. It says "the stored keys already agree with the stored columns",
// which rules out (a) and leaves (b).
//
// Two literal statements rather than one interpolated one, the same posture as
// `purgeAbsent()` and `deleteRows()`: the table and column names are then not
// merely whitelisted, they are unreachable from any input.

/** The two mirrored tables that carry a stored `sku_key`. warna and so_header do not. */
export const SKU_KEYED_TABLES = ["so_line", "live_fg"] as const;

export type SkuKeyedTable = (typeof SKU_KEYED_TABLES)[number];

export interface SkuKeyRecomputeTableResult {
  table: SkuKeyedTable;
  ok: boolean;
  /** Rows whose stored key disagreed with `erp_sku_key()` over their own columns. */
  updated: number;
  error?: string;
}

export interface SkuKeyRecomputeResult {
  started: boolean;
  skipped?: "in_flight" | "disabled" | "locked";
  ok: boolean;
  tables: SkuKeyRecomputeTableResult[];
  /** Total rows rekeyed across both tables. 0 means situation (b), not "nothing wrong". */
  updated: number;
  durationMs: number;
}

/**
 * `is distinct from` rather than `<>`: a NULL on either side must count as a
 * disagreement, not evaporate into NULL and quietly skip the row. `sku_key` is
 * NOT NULL in the schema and `erp_sku_key()` is total (every segment coalesces to
 * '-'), so neither side should ever be NULL — which is precisely why the
 * comparison must not depend on that being true.
 *
 * `synced_at` is deliberately NOT touched. It records when a row was last
 * CONFIRMED AGAINST THE ERP, and this step never speaks to the ERP.
 */
async function recomputeTable(db: Sql, table: SkuKeyedTable): Promise<number> {
  switch (table) {
    case "so_line": {
      const r = await db`
        update erp_so_line
           set sku_key = erp_sku_key(brand, warna, th, th_panel, p, l)
         where sku_key is distinct from erp_sku_key(brand, warna, th, th_panel, p, l)
      `;
      return r.count ?? 0;
    }
    case "live_fg": {
      const r = await db`
        update erp_live_fg
           set sku_key = erp_sku_key(brand, warna, th, th_panel, p, l)
         where sku_key is distinct from erp_sku_key(brand, warna, th, th_panel, p, l)
      `;
      return r.count ?? 0;
    }
  }
}

/**
 * The step itself, assuming the run guard is ALREADY HELD. Never throws: a
 * repair that cannot run must not take the pull down with it, because the pull
 * is the repair for the other situation.
 */
async function recomputeSkuKeyStep(db: Sql, log: SyncLogger): Promise<SkuKeyRecomputeResult> {
  const startedAt = Date.now();
  const tables: SkuKeyRecomputeTableResult[] = [];
  for (const table of SKU_KEYED_TABLES) {
    try {
      const updated = await recomputeTable(db, table);
      tables.push({ table, ok: true, updated });
    } catch (err) {
      const message = redactSecrets(err);
      tables.push({ table, ok: false, updated: 0, error: message });
      log.error(
        `sku-key recompute ${table}: failed, no row rekeyed — ${message}. The mirror is unchanged ` +
          `(one UPDATE, one transaction), so nothing is half-repaired.`,
      );
    }
  }

  const updated = tables.reduce((n, t) => n + t.updated, 0);
  const ok = tables.every((t) => t.ok);
  const durationMs = Date.now() - startedAt;
  const per = tables.map((t) => `${t.table} ${t.ok ? `${t.updated}` : "FAILED"}`).join(", ");
  if (updated > 0) {
    log.warn(
      `sku-key recompute: rekeyed ${updated} row(s) in place (${per}) in ${durationMs}ms — their stored ` +
        `columns were intact and only the key composition was stale, so no ERP traffic was needed. ` +
        `This is the CHEAP repair; ATP should move on the next read.`,
    );
  } else if (ok) {
    log.info(
      `sku-key recompute: 0 row(s) changed (${per}) in ${durationMs}ms — every stored key already agrees ` +
        `with erp_sku_key() over that row's OWN columns. So the keys are not stale: the COLUMNS are ` +
        `wrong (values refused or misparsed at write time), and only re-fetching those rows from the ` +
        `ERP can fix them.`,
    );
  }
  return { started: true, ok, tables, updated, durationMs };
}

/**
 * Commit one page: the upserts AND the cursor advance, in one transaction. This
 * pairing is the whole of ST-R7 — if the transaction rolls back, neither the
 * rows nor the cursor moved, and the next run replays exactly this page.
 *
 * `greatest(cursor_value, ...)` keeps the cursor monotonic: Postgres' greatest()
 * ignores NULLs, so a first-ever page and an out-of-order page both behave.
 */
async function commitPage(
  db: Sql,
  table: SelarasTable,
  rows: readonly AnyMirrorRow[],
  deletedIds: readonly string[],
  pageMaxUpdatedAt: Date | null,
): Promise<{ written: number; removed: number }> {
  // Belt and braces over `maxUpdatedAt()`: nothing but a real instant is ever
  // interpolated into the cursor update, because an Invalid Date here throws
  // during Bind and rolls back rows that were otherwise perfectly good.
  const nextCursor = isUsableInstant(pageMaxUpdatedAt) ? pageMaxUpdatedAt : null;
  return db.begin(async (tx) => {
    const written = await upsertPage(tx, table, rows);
    // Same transaction as the upserts and the cursor advance: a page either
    // lands whole — additions, deletions and cursor — or not at all (ST-R7).
    const removed = await deleteRows(tx, table, deletedIds);
    await tx`
      update erp_sync_state
         set cursor_value  = greatest(cursor_value, ${nextCursor}::timestamptz),
             rows_synced     = rows_synced + ${written},
             last_ok_at      = now(),
             last_error      = null,
             last_error_kind = null,
             last_error_at   = null
       where table_name = ${table}
    `;
    return { written, removed };
  }) as Promise<{ written: number; removed: number }>;
}

/** A table pass that found nothing new is still a successful sync (ST-R7). */
async function markTableOk(db: Sql, table: SelarasTable): Promise<void> {
  await db`
    update erp_sync_state
       set last_ok_at = now(), last_error = null, last_error_kind = null, last_error_at = null
     where table_name = ${table}
  `;
}

/** Failure path: record it, LEAVE THE CURSOR ALONE, keep the old mirror readable. */
async function markTableError(
  db: Sql,
  table: SelarasTable,
  error: string,
  kind: SelarasFailureKind = "other",
): Promise<void> {
  // FIX D: the KIND is stored beside the message, not inferred from it later.
  // The stock pages have to tell "wait, the ERP is down" from "call IT, the
  // credentials were rejected", and grepping a prose string for /HTTP 401/
  // survives exactly until somebody rewords it.
  await db`
    update erp_sync_state
       set last_error      = ${redactSecrets(error).slice(0, 500)},
           last_error_kind = ${kind},
           last_error_at   = now()
     where table_name = ${table}
  `;
}

// ── One table, one run ───────────────────────────────────────────────────────

/** A Date that is safe to send to Postgres — i.e. one `.toISOString()` survives. */
function isUsableInstant(d: Date | null | undefined): d is Date {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

/**
 * The next cursor, computed ONLY from rows whose `updated_at` is a valid date.
 *
 * Two refusals, both deliberate:
 *   · an Invalid Date never reaches `greatest(...)`, because postgres.js would
 *     serialize it with `.toISOString()` and throw `RangeError: Invalid time
 *     value` — the failure that used to abort the entire so_header pass;
 *   · a page with NO valid timestamp returns null, so the cursor is LEFT WHERE
 *     IT IS and the next run retries that window. Substituting `now()` or the
 *     epoch would be worse than not moving: a cursor only ever moves forward, so
 *     a fabricated instant silently skips every row behind it, permanently.
 */
function maxUpdatedAt(rows: readonly AnyMirrorRow[]): Date | null {
  let max: Date | null = null;
  for (const row of rows) {
    const t = row.erp_updated_at;
    if (!isUsableInstant(t)) continue;
    if (max === null || t.getTime() > max.getTime()) max = t;
  }
  return max;
}

function pageSignature(table: SelarasTable, rows: readonly AnyMirrorRow[]): string {
  const ids = rows.map(rowKey);
  return `${table}:${ids.length}:${ids.join(",")}`;
}

async function syncTable(
  db: Sql,
  client: SelarasClient,
  table: SelarasTable,
  pageSize: number,
  log: SyncLogger,
): Promise<SyncTableResult> {
  const cursorBefore = await readCursor(db, table);
  const result: SyncTableResult = {
    table,
    ok: true,
    pages: 0,
    rows: 0,
    dropped: 0,
    deleted: 0,
    ambiguousNumbers: 0,
    nonFiniteNumbers: 0,
    badDates: 0,
    cursorBefore,
    cursorAfter: cursorBefore,
  };
  // Accumulated across every page of this table, then logged ONCE at the end of
  // the pass (A22). One grep-able line per run is the entire point: it turns
  // "ATP is mysteriously 1000× off" into a thirty-second diagnosis.
  const ambiguousSamples: string[] = [];
  const nonFiniteSamples: string[] = [];
  const badDateSamples: string[] = [];

  // FIX A — the exact `updated_at__gte` the first page carries, logged verbatim.
  // The documented grammar is `YYYY-MM-DD HH:mm:ss` in WIB and the client sends
  // exactly that, minus STOCK_SYNC_LOOKBACK_MINUTES. Whether the ERP reads it the
  // way we mean is the one thing only real traffic can answer, and this line is
  // what makes it answerable from the logs instead of by inference.
  log.info(
    `${table}: pulling with updated_at__gte=${cursorParam(cursorBefore) ?? "(none — full pull)"}` +
      ` (stored cursor ${cursorBefore?.toISOString() ?? "null"}, lookback ` +
      `${config.stock.syncLookbackMinutes} min)`,
  );

  // ST-R5.3 — the column diagnostic is latched for the whole table pass, the
  // same posture as the refusal tallies above: once per table per run, never per
  // page and certainly never per row. The client only attaches it to page 1, so
  // this is belt and braces — and it is what keeps the guarantee true if the
  // client ever starts attaching one to a later page.
  let diagnosed = false;

  let previousSignature = "";
  for (let page = 1; page <= MAX_PAGES_PER_TABLE; page += 1) {
    const res = await client.fetchPage(table, { since: cursorBefore, page, limit: pageSize });
    if (!res.ok) {
      // Cursor untouched. The mirror keeps whatever it already had (ST-R7).
      result.ok = false;
      result.error = res.error;
      await markTableError(db, table, res.error, res.kind);
      log.error(`${table}: page ${page} failed — ${res.error}; cursor left at ${cursorBefore?.toISOString() ?? "null"}`);
      reportRefusals(table, result, ambiguousSamples, nonFiniteSamples, badDateSamples, log);
      return result;
    }

    const { rows, rawCount, dropped, ambiguousNumbers, nonFiniteNumbers, badDates, totalPages } = res.page;
    // Observation only: it names the raw wire keys of one row and the six
    // identity segments, and it can neither change what is mirrored nor throw.
    if (!diagnosed && res.page.columnDiagnostic !== null) {
      diagnosed = true;
      log.info(describeColumnDiagnostic(res.page.columnDiagnostic));
    }
    result.dropped += dropped;
    result.ambiguousNumbers += ambiguousNumbers.count;
    result.nonFiniteNumbers += nonFiniteNumbers.count;
    result.badDates += badDates.count;
    collectSamples(ambiguousSamples, ambiguousNumbers.samples);
    collectSamples(nonFiniteSamples, nonFiniteNumbers.samples);
    collectSamples(badDateSamples, badDates.samples);
    if (dropped > 0) {
      log.warn(`${table}: dropped ${dropped} of ${rawCount} rows on page ${page} (no usable primary key)`);
    }
    if (rawCount === 0) break;

    // An ERP that ignores `page` returns page 1 forever. Detect it rather than
    // spin: the rows are already committed and idempotent, so stopping is safe.
    // `rows.length > 0` guards a false positive: two consecutive pages that are
    // entirely malformed both signature as empty without the ERP misbehaving.
    const signature = pageSignature(table, rows);
    if (rows.length > 0 && signature === previousSignature) {
      log.warn(
        `${table}: page ${page} repeated page ${page - 1} verbatim — the 'page' query param ` +
          `looks ignored. Stopping this table; rows already committed are intact.`,
      );
      break;
    }
    previousSignature = signature;

    // FIX 6 — partition the page. A row the ERP has soft-deleted is not mirrored
    // and is removed if we already hold it; its `updated_at` still counts toward
    // the cursor, because it IS a change we have now consumed.
    const pageMax = maxUpdatedAt(rows);
    const live = rows.filter((r) => r.deleted_at === null);
    const deletedIds = rows.filter((r) => r.deleted_at !== null).map(rowKey);
    const { written, removed } = await commitPage(db, table, live, deletedIds, pageMax);
    result.pages += 1;
    result.rows += written;
    result.deleted += removed;
    if (deletedIds.length > 0) {
      log.info(
        `${table}: ${deletedIds.length} row(s) on page ${page} carry deleted_at — ` +
          `${removed} removed from the mirror, none written`,
      );
    }
    if (pageMax && (result.cursorAfter === null || pageMax.getTime() > result.cursorAfter.getTime())) {
      result.cursorAfter = pageMax;
    }

    if (totalPages !== null && page >= totalPages) break;
    if (rawCount < pageSize) break;
    if (page === MAX_PAGES_PER_TABLE) {
      log.warn(`${table}: hit the ${MAX_PAGES_PER_TABLE}-page safety cap — pagination (A2) is probably wrong`);
    }
  }

  if (result.pages === 0) await markTableOk(db, table);
  reportRefusals(table, result, ambiguousSamples, nonFiniteSamples, badDateSamples, log);
  return result;
}

const MAX_SAMPLES = 3;

function collectSamples(into: string[], from: readonly string[]): void {
  for (const s of from) {
    if (into.length < MAX_SAMPLES && !into.includes(s)) into.push(s);
  }
}

function examples(samples: readonly string[]): string {
  return samples.length > 0 ? ` e.g. ${samples.map((s) => `"${s}"`).join(", ")}` : "";
}

/**
 * Both refusal lines. Emitted once per table per run, only when something was
 * actually refused, and carrying the raw TOKENS only — never a whole row, which
 * could hold customer data. Each names what to do about it, because a log line
 * nobody can act on is noise.
 */
function reportRefusals(
  table: SelarasTable,
  result: SyncTableResult,
  ambiguous: readonly string[],
  nonFinite: readonly string[],
  badDates: readonly string[],
  log: SyncLogger,
): void {
  if (result.ambiguousNumbers > 0) {
    log.warn(
      `${table}: refused ${result.ambiguousNumbers} ambiguous numeric string(s)${examples(ambiguous)} — ` +
        `"1.234" is 1234 in id notation and 1.234 in en notation, so it was read as NULL/0 rather ` +
        `than guessed (A22). Set SELARAS_NUMBER_FORMAT=id or =en once a real response body is known.`,
    );
  }
  if (result.nonFiniteNumbers > 0) {
    log.warn(
      `${table}: refused ${result.nonFiniteNumbers} non-finite numeric(s)${examples(nonFinite)} — ` +
        `NaN/Infinity are legal in a Postgres numeric column but would desynchronise the TS and SQL ` +
        `sku_key implementations for that SKU (X11), so none was written. Investigate upstream: an ` +
        `ERP that emits NaN in th/p/l has a computation fault.`,
    );
  }
  if (result.badDates > 0) {
    log.warn(
      `${table}: refused ${result.badDates} unreadable date value(s)${examples(badDates)} — ` +
        `written as NULL, never guessed at. "0000-00-00" is MySQL's zero date for an unset ` +
        `column and is Invalid Date in JS; handing one to postgres.js throws ` +
        `"RangeError: Invalid time value" inside the page transaction and aborts the whole ` +
        `table pass, which is how this table's cursor got stuck. Fix the rows upstream if the ` +
        `dates matter; the sync itself no longer cares.`,
    );
  }
}

// ── Reconciliation: the only way this mirror can ever observe a DELETE ───────
//
// WHY THIS EXISTS. The incremental pull is `updated_at__gte` + upsert-by-PK. A
// row that is DELETED upstream has no `updated_at` to report and appears on no
// page, so an incremental cursor pull **structurally cannot see it** — the row
// sits in our mirror forever. PRD §10 names the edge case ("SO line
// cancelled/deleted → drops out of commitment automatically") and the cursor
// design alone cannot deliver it. `tbl_1359_SOSalesOrderDetailNDeletedID` is
// named in ST-R7b but we have never seen it, and no tombstone feed is available
// here (HANDOVER §2), so the honest fix for a source with no deletion feed is a
// slower **full-key sweep**: ask for the current key set, delete what is absent.
//
// The two consequences of not having it are not symmetric:
//   · a deleted SO line reserves forever   ⇒ ATP understated (someone complains);
//   · a deleted Live FG row (if the ERP DELETES a shipped row rather than zeroing
//     `qty`) keeps its quantity on hand forever ⇒ we OVER-PROMISE physical stock,
//     which is the exact failure this module exists to prevent. PRD §5A reasons
//     about on-hand and qty_balance being disjoint but never asks whether a
//     shipped row is updated or deleted. Nobody here knows. The sweep is correct
//     under either answer, which is why it is built rather than assumed away.
//
// SAFETY IS THE POINT. A sweep that purges is a sweep that can empty the mirror
// if the ERP misbehaves, so every path below is biased to REFUSE: an incomplete
// key set, an empty one, or one implausibly smaller than what we already hold
// aborts the table and leaves it exactly as it was. It runs on its own hourly
// cadence, under the same `running` guard as the sync, and never overlaps one.

/** Mirror table + primary key per logical table. Literal, whitelisted, never built from input. */
const MIRROR_TABLES: Record<SelarasTable, { table: string; pk: string }> = {
  warna: { table: "erp_warna", pk: "id" },
  so_header: { table: "erp_so_header", pk: "id" },
  so_line: { table: "erp_so_line", pk: "id" },
  live_fg: { table: "erp_live_fg", pk: "erp_row_id" },
};

/** Keys per INSERT while filling the scratch table. Big enough to be few round trips. */
const RECONCILE_KEY_CHUNK = 5_000;

async function mirrorCount(db: Sql, table: SelarasTable): Promise<number> {
  switch (table) {
    case "warna": {
      const r = await db<{ n: string }[]>`select count(*)::text as n from erp_warna`;
      return Number(r[0]?.n ?? 0);
    }
    case "so_header": {
      const r = await db<{ n: string }[]>`select count(*)::text as n from erp_so_header`;
      return Number(r[0]?.n ?? 0);
    }
    case "so_line": {
      const r = await db<{ n: string }[]>`select count(*)::text as n from erp_so_line`;
      return Number(r[0]?.n ?? 0);
    }
    case "live_fg": {
      const r = await db<{ n: string }[]>`select count(*)::text as n from erp_live_fg`;
      return Number(r[0]?.n ?? 0);
    }
  }
}

/**
 * Delete every mirror row whose primary key is absent from the scratch key set.
 * Three literal statements rather than one interpolated one: the table and column
 * names are then not merely whitelisted, they are unreachable from any input.
 */
async function purgeAbsent(tx: AnySql, table: SelarasTable): Promise<number> {
  switch (table) {
    case "warna": {
      const r = await tx`
        delete from erp_warna t
         where not exists (select 1 from _erp_recon_keys k where k.k = t.id)
      `;
      return r.count ?? 0;
    }
    case "so_header": {
      const r = await tx`
        delete from erp_so_header t
         where not exists (select 1 from _erp_recon_keys k where k.k = t.id)
      `;
      return r.count ?? 0;
    }
    case "so_line": {
      const r = await tx`
        delete from erp_so_line t
         where not exists (select 1 from _erp_recon_keys k where k.k = t.id)
      `;
      return r.count ?? 0;
    }
    case "live_fg": {
      const r = await tx`
        delete from erp_live_fg t
         where not exists (select 1 from _erp_recon_keys k where k.k = t.erp_row_id)
      `;
      return r.count ?? 0;
    }
  }
}

/** Bookkeeping for a sweep that actually removed rows (§4.2 reuses these columns). */
async function markReconcileRemoved(db: Sql, table: SelarasTable, removed: number): Promise<void> {
  // `rows_synced` is the mirror-write counter and a purge is a mirror write, so
  // removals accumulate there — no migration, and the number stays meaningful.
  //
  // `last_ok_at` is deliberately NOT touched. It is the freshness clock the stale
  // alert and the page banner read; a successful sweep stamping it would mask a
  // dead incremental sync for as long as the sweep kept working, which is the one
  // thing ST-R7 exists to catch.
  await db`
    update erp_sync_state
       set rows_synced = rows_synced + ${removed}
     where table_name = ${table}
  `;
}

async function fetchErpKeySet(
  client: SelarasClient,
  table: SelarasTable,
  pageSize: number,
  log: SyncLogger,
): Promise<
  | { ok: true; keys: Set<string>; pages: number; dropped: number; projected: boolean; capped: boolean }
  | { ok: false; error: string; kind: SelarasFailureKind }
> {
  const keys = new Set<string>();
  let pages = 0;
  let dropped = 0;
  let projected = true;
  let sawAnyRow = false;
  let previousSignature = "";

  for (let page = 1; page <= MAX_PAGES_PER_TABLE; page += 1) {
    const res = await client.fetchKeyPage(table, { page, limit: pageSize });
    if (!res.ok) return { ok: false, error: res.error, kind: res.kind };

    const { keys: pageKeys, rawCount, dropped: pageDropped, totalPages, projected: pageProjected } = res.page;
    dropped += pageDropped;
    if (rawCount > 0) {
      sawAnyRow = true;
      if (!pageProjected) projected = false;
    }
    if (rawCount === 0) break;

    // Same defence as the incremental pull: an ERP that ignores `page` returns
    // page 1 forever. Here it is worse than a wasted loop — a key set that keeps
    // repeating page 1 is INCOMPLETE, and purging against it would delete most
    // of the mirror. So this is a hard abort, not a break.
    const signature = `${pageKeys.length}:${pageKeys.join(",")}`;
    if (pageKeys.length > 0 && signature === previousSignature) {
      return {
        ok: false,
        kind: "erp_error",
        error:
          `page ${page} repeated page ${page - 1} verbatim — the 'page' query param looks ignored, ` +
          `so the key set is incomplete and nothing may be purged from it`,
      };
    }
    previousSignature = signature;

    for (const k of pageKeys) keys.add(k);
    pages += 1;

    if (totalPages !== null && page >= totalPages) break;
    if (rawCount < pageSize) break;
    if (page === MAX_PAGES_PER_TABLE) {
      return {
        ok: false,
        kind: "erp_error",
        error: `hit the ${MAX_PAGES_PER_TABLE}-page cap before the key set ended — it is incomplete, so nothing may be purged`,
      };
    }
  }

  if (dropped > 0) {
    log.warn(
      `reconcile ${table}: ${dropped} ERP row(s) carried no readable '${SELARAS_KEY_FIELDS[table]}' and were ` +
        `ignored. They cannot be matched against the mirror, so nothing is purged on their account.`,
    );
  }
  return { ok: true, keys, pages, dropped, projected: sawAnyRow ? projected : true, capped: false };
}

async function reconcileTable(
  db: Sql,
  client: SelarasClient,
  table: SelarasTable,
  pageSize: number,
  minRatio: number,
  log: SyncLogger,
): Promise<ReconcileTableResult> {
  const mirrored = await mirrorCount(db, table);
  const base: ReconcileTableResult = {
    table,
    ok: true,
    mirrored,
    erpKeys: 0,
    removed: 0,
    pages: 0,
    projected: true,
  };

  const fetched = await fetchErpKeySet(client, table, pageSize, log);
  if (!fetched.ok) {
    await markReconcileError(db, table, `reconcile aborted — ${fetched.error}`, fetched.kind);
    log.error(
      `reconcile ${table}: ABORTED, mirror untouched (${mirrored} row(s) kept) — ${fetched.error}`,
    );
    return { ...base, ok: false, aborted: "fetch_failed", error: fetched.error };
  }

  const erpKeys = fetched.keys.size;
  const result: ReconcileTableResult = { ...base, erpKeys, pages: fetched.pages, projected: fetched.projected };

  if (!fetched.projected) {
    // Item 5 of the brief: where the ERP gives us no key-only listing, say so
    // rather than pretending we asked cheaply.
    log.warn(
      `reconcile ${table}: the ERP ignored 'fields=${SELARAS_KEY_FIELDS[table]}' and returned whole rows — ` +
        `there is no key-only listing endpoint we know of (assumption A31), so the sweep pays full page cost. ` +
        `Correctness is unaffected; only the hourly cadence keeps it cheap.`,
    );
  }

  if (mirrored === 0) {
    log.info(`reconcile ${table}: mirror empty, ${erpKeys} ERP key(s) seen — nothing to purge`);
    return result;
  }

  // ── The two refusals. Both leave the mirror EXACTLY as it was. ──────────────
  if (erpKeys === 0) {
    const why =
      `the ERP reported ZERO keys while the mirror holds ${mirrored} row(s). A source that has genuinely ` +
      `emptied and a source with a truncating bug look identical from here, so the mirror is kept`;
    await markReconcileError(db, table, `reconcile aborted — ${why}`);
    log.error(`reconcile ${table}: ABORTED — ${why}.`);
    return { ...result, ok: false, aborted: "empty_key_set", error: why };
  }

  const floor = mirrored * minRatio;
  if (erpKeys < floor) {
    const why =
      `the ERP reported ${erpKeys} key(s) against ${mirrored} mirrored row(s) — below the ` +
      `STOCK_RECONCILE_MIN_RATIO floor of ${minRatio} (${Math.ceil(floor)} key(s)). Purging would remove ` +
      `${mirrored - erpKeys} row(s) on the word of a page set that looks truncated`;
    await markReconcileError(db, table, `reconcile aborted — ${why}`);
    log.error(`reconcile ${table}: ABORTED — ${why}. Raise the ratio deliberately if the drop is real.`);
    return { ...result, ok: false, aborted: "ratio_guard", error: why };
  }

  // ── The purge. One transaction: scratch keys in, absent rows out. ───────────
  const allKeys = [...fetched.keys];
  const removed = (await db.begin(async (tx) => {
    // `on commit drop` ties the scratch table's life to this transaction, so a
    // crash mid-sweep cannot leave one behind to poison the next run.
    await tx`create temp table _erp_recon_keys (k text primary key) on commit drop`;
    for (let i = 0; i < allKeys.length; i += RECONCILE_KEY_CHUNK) {
      const chunk = allKeys.slice(i, i + RECONCILE_KEY_CHUNK).map((k) => ({ k }));
      await tx`insert into _erp_recon_keys ${tx(chunk, "k")} on conflict (k) do nothing`;
    }
    return purgeAbsent(tx, table);
  })) as number;

  if (removed > 0) await markReconcileRemoved(db, table, removed);
  log.info(
    `reconcile ${table}: ${erpKeys} ERP key(s) vs ${mirrored} mirrored — removed ${removed} row(s) the ERP ` +
      `no longer lists${fetched.projected ? "" : " (full rows pulled; no key projection)"}`,
  );
  return { ...result, removed };
}

/** Failure path for the sweep. Prefixed so sync-status never mistakes it for a pull error. */
async function markReconcileError(
  db: Sql,
  table: SelarasTable,
  error: string,
  kind: SelarasFailureKind = "other",
): Promise<void> {
  // The kind is written here too, so a sweep failure cannot leave a stale `auth`
  // kind standing and keep the page telling people to call IT (FIX D).
  await db`
    update erp_sync_state
       set last_error      = ${redactSecrets(error).slice(0, 500)},
           last_error_kind = ${kind},
           last_error_at   = now()
     where table_name = ${table}
  `;
}

// ── ST-R7 stale alert ────────────────────────────────────────────────────────
//
// `freshness.stale` already existed in a JSON body and as an amber banner —
// visible only to somebody who already has /stock open. ST-R7 asked for an
// ALERT: "alerts if a sync hasn't succeeded in N intervals". A sync that dies at
// 18:00 on a Friday is otherwise discovered by whoever opens the page on Monday.
//
// Emitted ONCE per transition into the stale state and once again on recovery.
// Not every tick: an alert that repeats every three minutes is an alert people
// filter out, which is the same as not having one.

let staleAlertActive = false;

/** Test seam: forget whether the stale alert is currently latched. */
export function resetStaleAlert(): void {
  staleAlertActive = false;
}

interface FreshnessRow {
  table_name: string;
  last_ok_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
}

function describeTable(r: FreshnessRow): string {
  const ok = r.last_ok_at ? r.last_ok_at.toISOString() : "never";
  const err = r.last_error ? ` last_error="${r.last_error}"` : "";
  const errAt = r.last_error_at ? ` at ${r.last_error_at.toISOString()}` : "";
  return `${r.table_name}: last success ${ok};${err || " no error recorded"}${err ? errAt : ""}`;
}

/**
 * Compare the newest success across the mirrored tables against
 * `interval × STOCK_SYNC_STALE_ALERT_INTERVALS` and fire (or clear) the alert.
 * Never throws — it is called from the run's tail and a dead DB must not turn a
 * degraded sync into a dead process.
 */
export async function evaluateStaleAlert(db: Sql, intervalMs: number, log: SyncLogger): Promise<boolean> {
  const thresholdMs = Math.max(1, intervalMs) * Math.max(1, config.stock.syncStaleAlertIntervals);
  const rows = await db<FreshnessRow[]>`
    select table_name, last_ok_at, last_error, last_error_at
    from erp_sync_state
    where table_name = any(${[...SYNC_TABLES]})
    order by table_name
  `;

  let newest: number | null = null;
  for (const r of rows) {
    const t = r.last_ok_at ? r.last_ok_at.getTime() : null;
    if (t !== null && Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  const stale = newest === null || Date.now() - newest > thresholdMs;

  if (stale && !staleAlertActive) {
    staleAlertActive = true;
    const minutes = Math.round(thresholdMs / 60_000);
    log.error(
      `ALERT ST-R7: the ERP sync has not succeeded for any table in ${config.stock.syncStaleAlertIntervals} ` +
        `interval(s) (~${minutes} min). Newest success across all tables: ` +
        `${newest === null ? "NEVER" : new Date(newest).toISOString()}. Per table — ` +
        `${rows.map(describeTable).join(" | ")}. Stock figures are being served from a mirror that is no ` +
        `longer refreshing; ATP will drift from the ERP until this is fixed.`,
    );
  } else if (!stale && staleAlertActive) {
    staleAlertActive = false;
    log.info(
      `RECOVERED ST-R7: the ERP sync is succeeding again — newest success ` +
        `${newest === null ? "unknown" : new Date(newest).toISOString()}. Per table — ` +
        `${rows.map(describeTable).join(" | ")}.`,
    );
  }
  return stale;
}

// ── ST-R7b commitment-gate check, on the first sync that mirrors demand ──────
//
// The boot check in migrateErpStock runs before any sync has populated the
// mirror, so on a fresh deployment it can only ever see an empty table. This is
// the call that actually catches a mis-set STOCK_APPROVED_STATUSES: the first
// run that writes SO lines. Latched the same way as the stale alert so a
// permanently mis-set gate does not warn every three minutes.

let commitmentGateWarned = false;

/** Test seam: forget whether the commitment-gate warning has already fired. */
export function resetCommitmentGateWarning(): void {
  commitmentGateWarned = false;
}

async function checkCommitmentGateAfterSync(db: Sql, log: SyncLogger): Promise<void> {
  // Still EVALUATED every run (that is how recovery is noticed), but only
  // allowed to speak the first time — hence the silent logger once latched.
  const sink = commitmentGateWarned ? { warn: () => {} } : { warn: (m: string) => log.warn(m) };
  const report = await checkCommitmentGate(db, sink);
  if (report.tripped) commitmentGateWarned = true;
  else if (commitmentGateWarned) {
    commitmentGateWarned = false;
    log.info(
      `RECOVERED ST-R7b: the commitment gate matches again — configured approved statuses ` +
        `[${report.configuredApprovals.join(", ")}] now select live commitments.`,
    );
  }
}

// ── ST-R5.2 SKU-key match check, on every run that mirrors demand ────────────
//
// The sibling of the commitment-gate check above, for the other silent way ATP
// can collapse to on-hand: a key composition that does not match. The v2 key
// (2026-09-11) is verified against the ERP's documented COLUMNS but has never
// been run against real ROWS, so the run measures the overlap itself and shouts
// when most of the live demand matches no stock at all.
//
// Latched exactly like the stale alert: once on the way in, once on recovery.
// An alert that repeats every three minutes is an alert people filter out.

let skuKeyAlertActive = false;

/** Test seam: forget whether the sku-key match alert has already fired. */
export function resetSkuKeyAlert(): void {
  skuKeyAlertActive = false;
}

async function checkSkuKeyMatchAfterSync(db: Sql, log: SyncLogger): Promise<void> {
  // Still EVALUATED every run (that is how recovery is noticed), but only
  // allowed to speak the first time.
  const sink = skuKeyAlertActive ? { error: () => {} } : { error: (m: string) => log.error(m) };
  const report = await checkSkuKeyMatch(db, sink);
  if (report.tripped) skuKeyAlertActive = true;
  else if (skuKeyAlertActive) {
    skuKeyAlertActive = false;
    log.info(
      `RECOVERED ST-R5.2: live commitments are matching stock again — ` +
        `${report.unmatchedLines} of ${report.liveLines} line(s) unmatched, under the ` +
        `${report.threshold} alert threshold.`,
    );
  }
}

// ── Public surface ───────────────────────────────────────────────────────────

export interface ErpSyncDeps {
  db: Sql;
  client: SelarasClient;
  pageSize: number;
  intervalMs: number;
  log: SyncLogger;
  /**
   * FULL RE-SYNC. Clears every stored cursor — inside the guarded run, after the
   * lock is held — and then pulls each table from the beginning. Absent or false
   * is the ordinary incremental pass, byte for byte as before.
   *
   * Not a knob to leave on: it re-fetches every mirrored row (~137k SO lines at
   * the time of writing). It exists because parsing and key composition are
   * applied at WRITE time, so a fix to either reaches only rows that are pulled
   * again — see `clearCursors()` for the full argument.
   */
  full?: boolean;
  /** Who asked for it. Audit only; logged verbatim on a full re-sync. */
  actor?: string | null;
}

/**
 * In-process overlap guard. The DB `running` flag guards across processes; this
 * one guards the common case (the interval tick firing while the manual-kick
 * route is mid-run) without a round trip, and makes `runErpSyncOnce()` return
 * immediately as §4.2 requires of `POST /api/stock/sync`.
 *
 * The RECONCILIATION sweep shares this exact variable, and the DB lock below,
 * on purpose: a purge deciding "this key is absent" while a pull is mid-flight
 * writing that same key is the one interleaving that could delete a live row.
 * The two jobs are therefore mutually exclusive, not merely self-exclusive.
 */
let inFlight: Promise<unknown> | null = null;

/** True while a sync OR a reconciliation run is in progress (they share the guard). */
export function isErpSyncRunning(): boolean {
  return inFlight !== null;
}

function idleResult(skipped: SyncRunResult["skipped"], full = false): SyncRunResult {
  return { started: false, skipped, full, cursorsCleared: 0, tables: [], durationMs: 0 };
}

function idleReconcileResult(skipped: ReconcileRunResult["skipped"]): ReconcileRunResult {
  return { started: false, skipped, tables: [], durationMs: 0 };
}

/**
 * Run one full sync pass. NEVER REJECTS.
 *
 * Returns immediately with `skipped: 'in_flight'` when a run is already going —
 * this is what makes `POST /api/stock/sync` idempotent and non-blocking (§4.2).
 *
 * `overrides` exists for tests (fixture client, injected db/logger); production
 * callers pass nothing.
 */
export async function runErpSyncOnce(overrides: Partial<ErpSyncDeps> = {}): Promise<SyncRunResult> {
  const full = overrides.full === true;
  // The in-process half of the guard, and the reason a full re-sync can never be
  // started twice: the second caller is refused here without touching the DB, so
  // no cursor is cleared on its behalf.
  if (inFlight) return idleResult("in_flight", full);

  const db = overrides.db ?? getSql();
  const erpEnabled = overrides.client !== undefined || hasErp;
  if (!db || !erpEnabled) return idleResult("disabled", full);

  const deps: ErpSyncDeps = {
    db,
    client: overrides.client ?? selarasClient,
    pageSize: overrides.pageSize ?? config.stock.syncPageSize,
    intervalMs: overrides.intervalMs ?? config.stock.syncIntervalMs,
    log: overrides.log ?? defaultSyncLogger,
    full,
    actor: overrides.actor ?? null,
  };

  const run = executeRun(deps).finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

/**
 * Run the sku_key recompute ON ITS OWN — repair (a) above, without the re-pull.
 *
 * This is the entry point a FUTURE key-composition change should use. The key is
 * a pure function of six mirrored columns, so when only the composition changed
 * the correct key is derivable from what is already stored and there is no reason
 * to ask the ERP for 137k rows again. Two UPDATEs, seconds, no network.
 *
 * It does NOT require the ERP to be configured — it never talks to it — which is
 * also what makes it the right thing to reach for while the ERP is down.
 *
 * It DOES take the same guard as the pull and the sweep: this writes `sku_key`,
 * and so does the pull's upsert. Running both at once on the same row would be a
 * race between two writers that happen to agree today and need not tomorrow.
 *
 * NEVER REJECTS.
 */
export async function recomputeSkuKeys(
  overrides: Partial<Pick<ErpSyncDeps, "db" | "intervalMs" | "log">> = {},
): Promise<SkuKeyRecomputeResult> {
  const idle = (skipped: SkuKeyRecomputeResult["skipped"]): SkuKeyRecomputeResult => ({
    started: false,
    skipped,
    ok: false,
    tables: [],
    updated: 0,
    durationMs: 0,
  });

  if (inFlight) return idle("in_flight");

  const db = overrides.db ?? getSql();
  if (!db) return idle("disabled");

  const log = overrides.log ?? defaultSyncLogger;
  const intervalMs = overrides.intervalMs ?? config.stock.syncIntervalMs;

  const run = (async (): Promise<SkuKeyRecomputeResult> => {
    let locked = false;
    try {
      locked = await acquireLock(db, intervalMs);
    } catch (err) {
      log.error(`sku-key recompute: could not read the run guard — ${redactSecrets(err)}`);
      return idle("locked");
    }
    if (!locked) {
      log.info("sku-key recompute: a sync run holds the guard — nothing was rekeyed");
      return idle("locked");
    }
    try {
      return await recomputeSkuKeyStep(db, log);
    } finally {
      try {
        await releaseLock(db);
      } catch (err) {
        log.error(`sku-key recompute: could not release the run guard — ${redactSecrets(err)}`);
      }
    }
  })().finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

/**
 * Run one full-key reconciliation sweep. NEVER REJECTS, and never purges when
 * anything about the ERP's answer looks wrong (see the block comment above).
 *
 * Shares `inFlight` and the `erp_sync_state.running` lock with `runErpSyncOnce()`,
 * so a sweep can never overlap a pull in either direction.
 */
export async function reconcileErpMirror(overrides: Partial<ErpSyncDeps> = {}): Promise<ReconcileRunResult> {
  if (inFlight) return idleReconcileResult("in_flight");

  const db = overrides.db ?? getSql();
  const erpEnabled = overrides.client !== undefined || hasErp;
  if (!db || !erpEnabled) return idleReconcileResult("disabled");

  const deps: ErpSyncDeps = {
    db,
    client: overrides.client ?? selarasClient,
    pageSize: overrides.pageSize ?? config.stock.syncPageSize,
    intervalMs: overrides.intervalMs ?? config.stock.syncIntervalMs,
    log: overrides.log ?? defaultSyncLogger,
  };

  const run = executeReconcile(deps).finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

async function executeReconcile(deps: ErpSyncDeps): Promise<ReconcileRunResult> {
  const { db, client, pageSize, intervalMs, log } = deps;
  const startedAt = Date.now();
  const tables: ReconcileTableResult[] = [];
  const minRatio = config.stock.reconcileMinRatio;

  let locked = false;
  try {
    locked = await acquireLock(db, intervalMs);
  } catch (err) {
    log.error(`reconcile: could not read the run guard — ${redactSecrets(err)}`);
    return idleReconcileResult("locked");
  }
  if (!locked) {
    log.info("reconcile: a sync run holds the guard — skipping this sweep");
    return idleReconcileResult("locked");
  }

  try {
    for (const table of SYNC_TABLES) {
      try {
        tables.push(await reconcileTable(db, client, table, pageSize, minRatio, log));
      } catch (err) {
        // Anything the sweep itself threw. The purge is one transaction, so it
        // rolled back whole: the mirror is untouched, which is the safe outcome.
        const message = redactSecrets(err);
        tables.push({
          table,
          ok: false,
          mirrored: 0,
          erpKeys: 0,
          removed: 0,
          pages: 0,
          aborted: "fetch_failed",
          error: message,
          projected: true,
        });
        try {
          await markReconcileError(db, table, `reconcile aborted — ${message}`);
        } catch {
          /* the DB is the thing that is broken; nothing more to do here */
        }
        log.error(`reconcile ${table}: aborted, mirror untouched — ${message}`);
      }
    }
  } finally {
    try {
      await releaseLock(db);
    } catch (err) {
      log.error(`reconcile: could not release the run guard — ${redactSecrets(err)}`);
    }
  }

  const durationMs = Date.now() - startedAt;
  const removed = tables.reduce((n, t) => n + t.removed, 0);
  const aborted = tables.filter((t) => !t.ok).map((t) => `${t.table} (${t.aborted ?? "error"})`);
  if (aborted.length === 0) {
    log.info(`reconcile ok — removed ${removed} stale mirror row(s) across ${tables.length} tables in ${durationMs}ms`);
  } else {
    log.warn(
      `reconcile finished with ${aborted.length} table(s) left untouched: ${aborted.join(", ")} — ` +
        `removed ${removed} row(s) elsewhere in ${durationMs}ms`,
    );
  }
  return { started: true, tables, durationMs };
}

async function executeRun(deps: ErpSyncDeps): Promise<SyncRunResult> {
  const { db, client, pageSize, intervalMs, log } = deps;
  const full = deps.full === true;
  const startedAt = Date.now();
  const tables: SyncTableResult[] = [];
  let recompute: SkuKeyRecomputeResult | undefined;
  let cursorsCleared = 0;

  let locked = false;
  try {
    locked = await acquireLock(db, intervalMs);
  } catch (err) {
    log.error(`could not read the run guard — ${redactSecrets(err)}`);
    return idleResult("locked", full);
  }
  if (!locked) {
    // A full re-sync is refused here exactly like a tick is: the SCHEDULED sync
    // and the manual re-pull share one guard, so they can never interleave, and
    // a refused full re-sync has cleared nothing (the clearing is below the lock).
    log.info(
      full
        ? "FULL RE-SYNC refused — another sync run holds the guard. No cursor was cleared; retry once it finishes."
        : "another sync run holds the guard — skipping this tick",
    );
    return idleResult("locked", full);
  }

  try {
    // ── Full re-sync preamble. Everything here is INSIDE the lock and ahead of
    // the pull that consumes it, which is what makes "never reset a cursor
    // unless the run that follows actually starts" true by construction.
    if (full) {
      log.warn(
        `FULL RE-SYNC starting${deps.actor ? ` (requested by ${redactSecrets(deps.actor)})` : ""} — this ` +
          `re-fetches EVERY row of ${SYNC_TABLES.join(", ")} from the ERP, not just the window since the ` +
          `last cursor. Expect it to take minutes and to log one 'pulling with updated_at__gte=(none — ` +
          `full pull)' line per table. Every write is an idempotent upsert by primary key, so the mirror ` +
          `stays readable and correct throughout (§5).`,
      );

      // STEP 1 — the cheap repair, always attempted first. It costs two UPDATEs
      // and no ERP request, and when it is the right tool it makes the re-pull
      // unnecessary. When it changes 0 rows it has still told us something: the
      // stored keys agree with the stored columns, so the columns are the fault.
      recompute = await recomputeSkuKeyStep(db, log);

      // STEP 2 — clear the cursors. One statement, so all-or-nothing: there is
      // no state where some tables are due a full pull and others are not.
      try {
        cursorsCleared = await clearCursors(db);
        log.warn(
          `full re-sync: cleared ${cursorsCleared} stored cursor(s) — each table now pulls from the ` +
            `beginning. Cursors only ever move FORWARD, so this is the only way a row that was mirrored ` +
            `under retired parsing rules is ever re-read.`,
        );
      } catch (err) {
        // Nothing was cleared (one statement, one transaction) and nothing has
        // been pulled. Refuse the run rather than silently downgrading it to an
        // incremental pass that would look, in the logs, like a full one.
        log.error(
          `FULL RE-SYNC ABORTED before any table was pulled — could not clear the stored cursors: ` +
            `${redactSecrets(err)}. No cursor changed and no row was re-fetched; the mirror is exactly ` +
            `as it was. Safe to retry.`,
        );
        return {
          started: false,
          skipped: "cursor_reset_failed",
          full: true,
          cursorsCleared: 0,
          recompute,
          tables: [],
          durationMs: Date.now() - startedAt,
        };
      }
    }

    // Order matters: lines reference headers, and live_fg last so on-hand is the
    // freshest half of the ATP subtraction (§5).
    for (const table of SYNC_TABLES) {
      try {
        tables.push(await syncTable(db, client, table, pageSize, log));
      } catch (err) {
        // Anything the table pass itself threw (a DB blip mid-transaction).
        // The transaction rolled back, so the cursor did not move.
        const message = redactSecrets(err);
        tables.push({
          table,
          ok: false,
          pages: 0,
          rows: 0,
          dropped: 0,
          deleted: 0,
          ambiguousNumbers: 0,
          nonFiniteNumbers: 0,
          badDates: 0,
          error: message,
          cursorBefore: null,
          cursorAfter: null,
        });
        try {
          await markTableError(db, table, message);
        } catch {
          /* the DB is the thing that is broken; nothing more to do here */
        }
        log.error(`${table}: run aborted — ${message}`);
      }
    }
  } finally {
    try {
      await releaseLock(db);
    } catch (err) {
      // A lock we cannot release is reclaimed by the staleness rule on a later
      // tick, which is exactly why that rule exists.
      log.error(`could not release the run guard — ${redactSecrets(err)}`);
    }
  }

  const durationMs = Date.now() - startedAt;
  const rows = tables.reduce((n, t) => n + t.rows, 0);
  const failed = tables.filter((t) => !t.ok).map((t) => t.table);
  const label = full ? "FULL re-sync" : "run";
  if (failed.length === 0) {
    log.info(`${label} ok — ${rows} rows across ${tables.length} tables in ${durationMs}ms`);
  } else {
    // A full re-sync that fails partway is a PARTIALLY re-pulled mirror, which is
    // a perfectly readable one: every page that committed committed whole, and
    // each failed table kept the cursor its last good page left behind, so the
    // next ordinary tick resumes from there rather than starting over.
    log.warn(
      `${label} finished with errors on ${failed.join(", ")} — ${rows} rows in ${durationMs}ms. ` +
        `The mirror is readable: committed pages are intact and each failed table's cursor sits at its ` +
        `last COMMITTED page, so the re-pull resumes there instead of restarting.`,
    );
  }

  // ── The three post-run checks. All WARN-ONLY and all wrapped: a diagnostic
  // that can abort a sync run is worse than no diagnostic (§7.7).
  try {
    await evaluateStaleAlert(db, intervalMs, log);
  } catch (err) {
    log.error(`stale-alert check failed (non-fatal) — ${redactSecrets(err)}`);
  }
  try {
    await checkCommitmentGateAfterSync(db, log);
  } catch (err) {
    log.error(`commitment-gate check failed (non-fatal) — ${redactSecrets(err)}`);
  }
  try {
    await checkSkuKeyMatchAfterSync(db, log);
  } catch (err) {
    log.error(`sku-key match check failed (non-fatal) — ${redactSecrets(err)}`);
  }

  return { started: true, full, cursorsCleared, recompute, tables, durationMs };
}

/**
 * Boot hook. Mirrors `startCadenceEngine()` in `routes/accounts.ts`: run once
 * now, then on an interval, and never let a tick throw.
 *
 * No ERP or no database ⇒ ONE warn and nothing else (§5). The app must boot and
 * serve in both of those states (invariant §7.7); every stock surface renders
 * "ERP tidak terhubung" rather than failing.
 */
export function startErpSync(): void {
  if (!hasErp || !hasDatabase) {
    console.warn(
      `[erp-sync] disabled — ${!hasErp ? "SELARAS_BASE_URL not set" : "DATABASE_URL not set"}; ` +
        "the stock mirror will not refresh and the ERP surfaces will show 'ERP tidak terhubung'.",
    );
    return;
  }

  const intervalMs = config.stock.syncIntervalMs;

  // `void` + the internal try/catch: runErpSyncOnce() already resolves rather
  // than rejecting, but a tick must be incapable of producing an unhandled
  // rejection even if that ever changes (§5: an ERP outage must not kill us).
  const tick = (): void => {
    void runErpSyncOnce().catch((err) => {
      console.error(`[erp-sync] tick error: ${redactSecrets(err)}`);
    });
  };

  tick();
  setInterval(tick, intervalMs);
  console.info(`[erp-sync] started — every ${Math.round(intervalMs / 1000)}s, page size ${config.stock.syncPageSize}`);

  // The reconciliation sweep rides the same boot hook so `index.ts` stays a
  // one-line registration. Its own, much slower cadence — it pulls a FULL key
  // set per table, which has no business happening every three minutes — and
  // deliberately NOT run immediately at boot: the first incremental pull should
  // land before anything is allowed to decide a row is absent.
  const reconcileMs = config.stock.reconcileIntervalMs;
  const reconcileTick = (): void => {
    void reconcileErpMirror().catch((err) => {
      console.error(`[erp-sync] reconcile tick error: ${redactSecrets(err)}`);
    });
  };
  setInterval(reconcileTick, reconcileMs);
  console.info(
    `[erp-sync] mirror reconciliation started — every ${Math.round(reconcileMs / 60_000)} min, ` +
      `abort floor ${config.stock.reconcileMinRatio} of mirrored rows (STOCK_RECONCILE_MIN_RATIO). ` +
      "An incremental updated_at cursor cannot observe a DELETE; this sweep is how one is noticed.",
  );
}
