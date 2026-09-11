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
import {
  redactSecrets,
  selarasClient,
  SYNC_TABLES,
  type SelarasClient,
  type SelarasTable,
  type LiveFgRow,
  type SoHeaderRow,
  type SoLineRow,
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
   * Numeric strings refused as ambiguous under `SELARAS_NUMBER_FORMAT=auto`
   * (A22) — "1.234" is 1234 in id notation and 1.234 in en notation, so it is
   * refused rather than guessed. Surfaced here so the manual-kick route can show
   * it without a schema change.
   */
  ambiguousNumbers: number;
  error?: string;
  cursorBefore: Date | null;
  cursorAfter: Date | null;
}

export interface SyncRunResult {
  started: boolean;
  /** Why nothing ran: another run holds the guard, or the ERP/DB is not configured. */
  skipped?: "in_flight" | "disabled" | "locked";
  tables: SyncTableResult[];
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
      "kode_barang",
      "warna",
      "th",
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
      kode_barang       = excluded.kode_barang,
      warna             = excluded.warna,
      th                = excluded.th,
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
  const batch = dedupeByKey(rows, (r) => r.sn_fg);
  if (batch.length === 0) return 0;
  await tx`
    insert into erp_live_fg ${tx(
      batch,
      "sn_fg",
      "kode_barang",
      "warna",
      "th",
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
    on conflict (sn_fg) do update set
      kode_barang    = excluded.kode_barang,
      warna          = excluded.warna,
      th             = excluded.th,
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

type AnyMirrorRow = SoHeaderRow | SoLineRow | LiveFgRow;

async function upsertPage(tx: AnySql, table: SelarasTable, rows: readonly AnyMirrorRow[]): Promise<number> {
  switch (table) {
    case "so_header":
      return upsertSoHeaders(tx, rows as readonly SoHeaderRow[]);
    case "so_line":
      return upsertSoLines(tx, rows as readonly SoLineRow[]);
    case "live_fg":
      return upsertLiveFg(tx, rows as readonly LiveFgRow[]);
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
       where table_name in ('so_header', 'so_line', 'live_fg')
         and (
           running = false
           or coalesce(greatest(last_ok_at, last_error_at), to_timestamp(0))
              < now() - (${staleMs}::bigint * interval '1 millisecond')
         )
    )
    update erp_sync_state s
       set running = true
      from candidate c
     where s.table_name = c.table_name
       and (select count(*) from candidate) = 3
    returning s.table_name
  `;
  return claimed.length === 3;
}

async function releaseLock(db: Sql): Promise<void> {
  await db`
    update erp_sync_state set running = false
     where table_name in ('so_header', 'so_line', 'live_fg')
  `;
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
  pageMaxUpdatedAt: Date | null,
): Promise<number> {
  return db.begin(async (tx) => {
    const written = await upsertPage(tx, table, rows);
    await tx`
      update erp_sync_state
         set cursor_value  = greatest(cursor_value, ${pageMaxUpdatedAt}::timestamptz),
             rows_synced   = rows_synced + ${written},
             last_ok_at    = now(),
             last_error    = null,
             last_error_at = null
       where table_name = ${table}
    `;
    return written;
  }) as Promise<number>;
}

/** A table pass that found nothing new is still a successful sync (ST-R7). */
async function markTableOk(db: Sql, table: SelarasTable): Promise<void> {
  await db`
    update erp_sync_state
       set last_ok_at = now(), last_error = null, last_error_at = null
     where table_name = ${table}
  `;
}

/** Failure path: record it, LEAVE THE CURSOR ALONE, keep the old mirror readable. */
async function markTableError(db: Sql, table: SelarasTable, error: string): Promise<void> {
  await db`
    update erp_sync_state
       set last_error = ${redactSecrets(error).slice(0, 500)}, last_error_at = now()
     where table_name = ${table}
  `;
}

// ── One table, one run ───────────────────────────────────────────────────────

function maxUpdatedAt(rows: readonly AnyMirrorRow[]): Date | null {
  let max: Date | null = null;
  for (const row of rows) {
    const t = row.erp_updated_at;
    if (t && (max === null || t.getTime() > max.getTime())) max = t;
  }
  return max;
}

function pageSignature(table: SelarasTable, rows: readonly AnyMirrorRow[]): string {
  const ids = rows.map((r) => ("id" in r ? r.id : r.sn_fg));
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
    ambiguousNumbers: 0,
    cursorBefore,
    cursorAfter: cursorBefore,
  };
  // Accumulated across every page of this table, then logged ONCE at the end of
  // the pass (A22). One grep-able line per run is the entire point: it turns
  // "ATP is mysteriously 1000× off" into a thirty-second diagnosis.
  const ambiguousSamples: string[] = [];

  let previousSignature = "";
  for (let page = 1; page <= MAX_PAGES_PER_TABLE; page += 1) {
    const res = await client.fetchPage(table, { since: cursorBefore, page, limit: pageSize });
    if (!res.ok) {
      // Cursor untouched. The mirror keeps whatever it already had (ST-R7).
      result.ok = false;
      result.error = res.error;
      await markTableError(db, table, res.error);
      log.error(`${table}: page ${page} failed — ${res.error}; cursor left at ${cursorBefore?.toISOString() ?? "null"}`);
      reportAmbiguity(table, result, ambiguousSamples, log);
      return result;
    }

    const { rows, rawCount, dropped, ambiguousNumbers, totalPages } = res.page;
    result.dropped += dropped;
    result.ambiguousNumbers += ambiguousNumbers.count;
    for (const sample of ambiguousNumbers.samples) {
      if (ambiguousSamples.length < 3 && !ambiguousSamples.includes(sample)) ambiguousSamples.push(sample);
    }
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
          `looks ignored (assumption A2). Stopping this table; rows already committed are intact.`,
      );
      break;
    }
    previousSignature = signature;

    const pageMax = maxUpdatedAt(rows);
    const written = await commitPage(db, table, rows, pageMax);
    result.pages += 1;
    result.rows += written;
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
  reportAmbiguity(table, result, ambiguousSamples, log);
  return result;
}

/**
 * The A22 line. Emitted once per table per run, only when something was actually
 * refused, and carrying the raw TOKENS only — never a whole row, which could
 * hold customer data. Names the config key so the fix is obvious from the log.
 */
function reportAmbiguity(
  table: SelarasTable,
  result: SyncTableResult,
  samples: readonly string[],
  log: SyncLogger,
): void {
  if (result.ambiguousNumbers === 0) return;
  const examples = samples.length > 0 ? ` e.g. ${samples.map((s) => `"${s}"`).join(", ")}` : "";
  log.warn(
    `${table}: refused ${result.ambiguousNumbers} ambiguous numeric string(s)${examples} — ` +
      `"1.234" is 1234 in id notation and 1.234 in en notation, so it was read as NULL/0 rather ` +
      `than guessed (A22). Set SELARAS_NUMBER_FORMAT=id or =en once a real response body is known.`,
  );
}

// ── Public surface ───────────────────────────────────────────────────────────

export interface ErpSyncDeps {
  db: Sql;
  client: SelarasClient;
  pageSize: number;
  intervalMs: number;
  log: SyncLogger;
}

/**
 * In-process overlap guard. The DB `running` flag guards across processes; this
 * one guards the common case (the interval tick firing while the manual-kick
 * route is mid-run) without a round trip, and makes `runErpSyncOnce()` return
 * immediately as §4.2 requires of `POST /api/stock/sync`.
 */
let inFlight: Promise<SyncRunResult> | null = null;

/** True while a sync run is in progress — for the manual-kick route's response. */
export function isErpSyncRunning(): boolean {
  return inFlight !== null;
}

function idleResult(skipped: SyncRunResult["skipped"]): SyncRunResult {
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
  if (inFlight) return idleResult("in_flight");

  const db = overrides.db ?? getSql();
  const erpEnabled = overrides.client !== undefined || hasErp;
  if (!db || !erpEnabled) return idleResult("disabled");

  const deps: ErpSyncDeps = {
    db,
    client: overrides.client ?? selarasClient,
    pageSize: overrides.pageSize ?? config.stock.syncPageSize,
    intervalMs: overrides.intervalMs ?? config.stock.syncIntervalMs,
    log: overrides.log ?? defaultSyncLogger,
  };

  const run = executeRun(deps).finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

async function executeRun(deps: ErpSyncDeps): Promise<SyncRunResult> {
  const { db, client, pageSize, intervalMs, log } = deps;
  const startedAt = Date.now();
  const tables: SyncTableResult[] = [];

  let locked = false;
  try {
    locked = await acquireLock(db, intervalMs);
  } catch (err) {
    log.error(`could not read the run guard — ${redactSecrets(err)}`);
    return idleResult("locked");
  }
  if (!locked) {
    log.info("another sync run holds the guard — skipping this tick");
    return idleResult("locked");
  }

  try {
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
          ambiguousNumbers: 0,
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
  if (failed.length === 0) {
    log.info(`run ok — ${rows} rows across ${tables.length} tables in ${durationMs}ms`);
  } else {
    log.warn(`run finished with errors on ${failed.join(", ")} — ${rows} rows in ${durationMs}ms`);
  }
  return { started: true, tables, durationMs };
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
}
