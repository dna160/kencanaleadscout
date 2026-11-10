/**
 * Kabar Pesanan WP-2 — the ORDER LANE (PRD §5.0).
 *
 * A small, fast sync of the order-to-cash tables so an order movement reaches
 * LeadScout within about a minute, while the stock sync keeps its 180 s cadence:
 *
 *   every tick (ERP_FAST_POLL_MS, 60 s):  so_header (1202), request_produksi
 *                                          (1236), do_header (1082), do_line (1205)
 *   every Nth tick:                        sales (1130, the rep master)
 *
 * Each table is read with `<field>__gte=<cursor − lookback>` ordered by that
 * field, so an idle tick costs one small request per table. 1236 is read on
 * BOTH `updated_at` and `created_at` (PRD WP-2: "created_at safety"): a new
 * request whose `updated_at` is blank would otherwise never be seen.
 *
 * WHY NOT INSIDE THE STOCK SYNC. That sync's lock covers exactly its four
 * tables, its freshness alarm pages people about ATP, and its reconciliation
 * sweep purges rows the ERP no longer lists. None of that is right for DOs:
 * a DO-table outage is not a stock outage, and a vanished DO must stay visible
 * (with `deleted_at`) so WP-3 can derive `do.cancelled`. So this lane has its
 * own lease (`erp_order_sync_lease`) and cursors (`erp_order_sync_state`).
 *
 * The SO header is written by BOTH loops through the same `upsertSoHeaders`, so
 * whichever fetched it last, the row is the same. A header the ERP marks
 * deleted is removed, exactly as the stock sync does.
 *
 * Same transport, retry and envelope rules as the stock sync (`fetchRawPage`).
 * After every run, registered listeners (WP-3's event deriver) receive the ids
 * of the rows that were written; the webhook path feeds the same listeners.
 */
import { randomUUID } from "node:crypto";
import { config, hasDatabase, hasErp, hasErpCredentials } from "../config.js";
import { getSql, type Sql } from "../db/client.js";
import {
  adaptSoHeaderRow,
  endpointOf,
  fetchRawPage,
  formatMirroredDatetime,
  ORDER_TABLES,
  primaryKeyField,
  redactSecrets,
  type OrderTable,
  type RawPageOptions,
  type RawPageResult,
  type SoHeaderRow,
} from "./selarasClient.js";
import { ORDER_ADAPTERS, orderPkField, upsertOrderRows, type OrderRowBase } from "./orderTables.js";
import { upsertSoHeaders } from "./syncWorker.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySql = any;

export type LaneTable = "so_header" | OrderTable;
export const LANE_TABLES: readonly LaneTable[] = ["so_header", ...ORDER_TABLES];

type CursorField = "updated_at" | "created_at";

interface LaneSpec {
  table: LaneTable;
  cursors: readonly CursorField[];
  slow: boolean;
}

/** Order matters only for readability of logs: headers before their children. */
export const LANE_SPECS: readonly LaneSpec[] = [
  { table: "so_header", cursors: ["updated_at"], slow: false },
  { table: "request_produksi", cursors: ["updated_at", "created_at"], slow: false },
  { table: "do_header", cursors: ["updated_at"], slow: false },
  { table: "do_line", cursors: ["updated_at"], slow: false },
  { table: "sales", cursors: ["updated_at"], slow: true },
];

/** Ids written per table in one run (or one webhook call). */
export type OrderTouched = Record<LaneTable, string[]>;

export function emptyTouched(): OrderTouched {
  return { so_header: [], do_header: [], do_line: [], request_produksi: [], sales: [] };
}

export function hasTouched(t: OrderTouched): boolean {
  return LANE_TABLES.some((k) => t[k].length > 0);
}

// ── Listeners (WP-3 subscribes here) ─────────────────────────────────────────

/** Where the rows came from: the poll, or a Selaras webhook. */
export type OrderOrigin = "erp-mirror" | "erp-webhook";
export type OrderListener = (touched: OrderTouched, db: Sql, origin: OrderOrigin) => Promise<void>;
const listeners: OrderListener[] = [];

/** Register a consumer of written rows. Returns an unsubscribe function. */
export function onOrderRows(fn: OrderListener): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export async function emitOrderRows(
  touched: OrderTouched,
  db: Sql,
  log: LaneLogger = defaultLogger,
  origin: OrderOrigin = "erp-mirror",
): Promise<void> {
  if (!hasTouched(touched)) return;
  for (const fn of [...listeners]) {
    try {
      await fn(touched, db, origin);
    } catch (err) {
      // A consumer failing must never stop the mirror: the rows are written,
      // and the consumer can re-derive from the mirror on its next call.
      log.error(`[order-lane] listener failed: ${redactSecrets(err)}`);
    }
  }
}

// ── Adapting and writing ─────────────────────────────────────────────────────

type LaneRow = (SoHeaderRow | OrderRowBase) & { id: string; erp_created_at: Date | null; erp_updated_at: Date | null; deleted_at: Date | null };

export function adaptLaneRow(table: LaneTable, raw: unknown): LaneRow | null {
  try {
    return (table === "so_header" ? adaptSoHeaderRow(raw) : ORDER_ADAPTERS[table](raw)) as LaneRow | null;
  } catch {
    return null; // adapters are written not to throw; a row is never worth a run
  }
}

/** The ERP's primary-key column for a lane table (`{table}_id`). */
export function lanePkField(table: LaneTable): string {
  return table === "so_header" ? primaryKeyField("so_header") : orderPkField(table);
}

/**
 * Write adapted rows for one table and return the ids written.
 * SO headers marked deleted upstream are REMOVED (same as the stock sync);
 * order-table rows are kept with `deleted_at` for WP-3.
 */
export async function writeLaneRows(tx: AnySql, table: LaneTable, rows: readonly LaneRow[]): Promise<string[]> {
  if (rows.length === 0) return [];
  if (table === "so_header") {
    const live = rows.filter((r) => !r.deleted_at) as SoHeaderRow[];
    const gone = rows.filter((r) => r.deleted_at).map((r) => r.id);
    if (live.length) await upsertSoHeaders(tx, live);
    if (gone.length) await tx`delete from erp_so_header where id = any(${gone})`;
  } else {
    await upsertOrderRows(tx, table, rows as any);
  }
  return [...new Set(rows.map((r) => r.id))];
}

function cursorOf(row: LaneRow, field: CursorField): Date | null {
  const d = field === "updated_at" ? row.erp_updated_at : row.erp_created_at;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

// ── One run ──────────────────────────────────────────────────────────────────

export interface LaneLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}
const defaultLogger: LaneLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

export interface OrderSyncDeps {
  db: Sql;
  fetchPage: (table: LaneTable, opts: RawPageOptions) => Promise<RawPageResult>;
  now: () => Date;
  log: LaneLogger;
  pageSize: number;
  maxPagesPerTick: number;
  backfillDays: number;
  lookbackMinutes: number;
}

export interface OrderTableResult {
  table: LaneTable;
  field: CursorField;
  rows: number;
  pages: number;
  error: string | null;
}

export interface OrderSyncResult {
  ran: boolean;
  skipped: null | "locked" | "no_database" | "no_erp" | "in_progress";
  results: OrderTableResult[];
  touched: OrderTouched;
}

/** Process-unique lease owner. */
export const ORDER_LANE_OWNER = `${process.pid}:${randomUUID()}`;
const LEASE_SECONDS = 300;

async function acquireLease(db: Sql): Promise<boolean> {
  const got = await db`
    update erp_order_sync_lease
       set owner = ${ORDER_LANE_OWNER}, lease_until = now() + make_interval(secs => ${LEASE_SECONDS})
     where id = 1 and (lease_until is null or lease_until < now() or owner = ${ORDER_LANE_OWNER})
     returning id
  `;
  return got.length === 1;
}

async function releaseLease(db: Sql): Promise<void> {
  await db`update erp_order_sync_lease set lease_until = null where id = 1 and owner = ${ORDER_LANE_OWNER}`;
}

async function syncOne(deps: OrderSyncDeps, spec: LaneSpec, field: CursorField, touched: OrderTouched): Promise<OrderTableResult> {
  const { db, log } = deps;
  const table = spec.table;
  const [state] = await db<{ cursor_value: Date | null }[]>`
    select cursor_value from erp_order_sync_state where table_name = ${table} and cursor_field = ${field}
  `;
  const since = state?.cursor_value ?? new Date(deps.now().getTime() - deps.backfillDays * 86_400_000);
  const param = formatMirroredDatetime(new Date(since.getTime() - deps.lookbackMinutes * 60_000));

  let maxSeen: Date | null = null;
  let rowsWritten = 0;
  let pages = 0;
  let error: string | null = null;
  let errorKind: string | null = null;

  for (let page = 1; page <= deps.maxPagesPerTick; page++) {
    const res = await deps.fetchPage(table, {
      params: { [`${field}__gte`]: param, order_by: field, order_dir: "asc" },
      page,
      limit: deps.pageSize,
    });
    if (!res.ok) {
      error = res.error;
      errorKind = res.kind;
      break;
    }
    pages += 1;
    const adapted: LaneRow[] = [];
    for (const raw of res.rows) {
      const r = adaptLaneRow(table, raw);
      if (r) adapted.push(r);
    }
    if (adapted.length) {
      const ids = await db.begin((tx) => writeLaneRows(tx, table, adapted));
      touched[table].push(...ids);
      rowsWritten += adapted.length;
      for (const r of adapted) {
        const c = cursorOf(r, field);
        if (c && (!maxSeen || c > maxSeen)) maxSeen = c;
      }
    }
    if (res.rows.length < deps.pageSize) break;
    if (res.totalPages !== null && page >= res.totalPages) break;
    if (page === deps.maxPagesPerTick) {
      log.warn(
        `[order-lane] ${endpointOf(table)} (${field}): hit ERP_ORDER_MAX_PAGES_PER_TICK=${deps.maxPagesPerTick}; ` +
          "the cursor advances to the last row read and the next tick continues from there.",
      );
    }
  }

  // The cursor only moves forward, and only to a value we have actually read.
  // Pages are ordered ascending by the cursor field, so every row before
  // `maxSeen` is already in the mirror even when a later page failed.
  const next = maxSeen && (!state?.cursor_value || maxSeen > state.cursor_value) ? maxSeen : state?.cursor_value ?? since;
  await db`
    insert into erp_order_sync_state as s
      (table_name, cursor_field, cursor_value, last_ok_at, last_error, last_error_kind, last_error_at, rows_synced)
    values (${table}, ${field}, ${next},
            ${error ? null : deps.now()}, ${error}, ${errorKind}, ${error ? deps.now() : null}, ${rowsWritten})
    on conflict (table_name, cursor_field) do update set
      cursor_value    = excluded.cursor_value,
      last_ok_at      = coalesce(excluded.last_ok_at, s.last_ok_at),
      last_error      = excluded.last_error,
      last_error_kind = excluded.last_error_kind,
      last_error_at   = coalesce(excluded.last_error_at, s.last_error_at),
      rows_synced     = s.rows_synced + excluded.rows_synced
  `;
  if (error) log.warn(`[order-lane] ${endpointOf(table)} (${field}) failed: ${redactSecrets(error)}`);
  return { table, field, rows: rowsWritten, pages, error };
}

function resolveDeps(over: Partial<OrderSyncDeps>): OrderSyncDeps | null {
  const db = over.db ?? getSql();
  if (!db) return null;
  return {
    db,
    fetchPage: over.fetchPage ?? ((t, o) => fetchRawPage(t, o)),
    now: over.now ?? (() => new Date()),
    log: over.log ?? defaultLogger,
    pageSize: over.pageSize ?? config.orders.pageSize,
    maxPagesPerTick: over.maxPagesPerTick ?? config.orders.maxPagesPerTick,
    backfillDays: over.backfillDays ?? config.orders.backfillDays,
    lookbackMinutes: over.lookbackMinutes ?? config.stock.syncLookbackMinutes,
  };
}

/**
 * One pass of the lane. `includeSlow` adds the rep master. Never throws: a
 * failing table is recorded in `erp_order_sync_state` and the others still run.
 */
export async function runOrderSyncOnce(
  opts: { includeSlow?: boolean } & Partial<OrderSyncDeps> = {},
): Promise<OrderSyncResult> {
  const touched = emptyTouched();
  const deps = resolveDeps(opts);
  if (!deps) return { ran: false, skipped: "no_database", results: [], touched };
  if (!(await acquireLease(deps.db))) return { ran: false, skipped: "locked", results: [], touched };
  const results: OrderTableResult[] = [];
  try {
    for (const spec of LANE_SPECS) {
      if (spec.slow && !opts.includeSlow) continue;
      for (const field of spec.cursors) {
        try {
          results.push(await syncOne(deps, spec, field, touched));
        } catch (err) {
          const msg = redactSecrets(err);
          deps.log.error(`[order-lane] ${spec.table} (${field}) crashed: ${msg}`);
          results.push({ table: spec.table, field, rows: 0, pages: 0, error: msg });
        }
      }
    }
  } finally {
    await releaseLease(deps.db).catch(() => undefined);
  }
  for (const k of LANE_TABLES) touched[k] = [...new Set(touched[k])];
  await emitOrderRows(touched, deps.db, deps.log);
  return { ran: true, skipped: null, results, touched };
}

// ── One row, on demand (the webhook path) ────────────────────────────────────

export interface RefreshResult {
  table: LaneTable;
  id: string;
  found: boolean;
  /** True when the row was absent upstream and marked deleted / removed here. */
  markedDeleted: boolean;
  touched: OrderTouched;
}

/**
 * Re-read ONE row by its ERP primary key and write it through the same path the
 * poll uses. When the ERP no longer returns it and the caller says it was
 * deleted, the mirror records that (`deleted_at` on order tables; removal for
 * an SO header, as the stock sync does).
 */
export async function refreshOrderRow(
  table: LaneTable,
  id: string,
  opts: { deleted?: boolean } & Partial<OrderSyncDeps> = {},
): Promise<RefreshResult> {
  const deps = resolveDeps(opts);
  if (!deps) throw new Error("database unavailable");
  const touched = emptyTouched();
  const res = await deps.fetchPage(table, { params: { [lanePkField(table)]: id }, page: 1, limit: 5 });
  if (!res.ok) throw new Error(`ERP read failed: ${res.error}`);
  const rows = res.rows
    .map((raw) => adaptLaneRow(table, raw))
    .filter((r): r is LaneRow => r !== null && r.id === id);

  let markedDeleted = false;
  if (rows.length) {
    touched[table] = await deps.db.begin((tx) => writeLaneRows(tx, table, rows));
  } else if (opts.deleted) {
    if (table === "so_header") {
      await deps.db`delete from erp_so_header where id = ${id}`;
    } else {
      const name = { do_header: "erp_do_header", do_line: "erp_do_line", request_produksi: "erp_request_produksi", sales: "erp_sales" }[table];
      await deps.db`
        update ${deps.db(name)} set deleted_at = coalesce(deleted_at, now()), synced_at = now() where id = ${id}
      `;
    }
    touched[table] = [id];
    markedDeleted = true;
  }
  await emitOrderRows(touched, deps.db, deps.log, "erp-webhook");
  return { table, id, found: rows.length > 0, markedDeleted, touched };
}

// ── Status (for /notify and the WP-4 staleness pause) ────────────────────────

export interface OrderLaneStatusRow {
  table_name: string;
  cursor_field: string;
  cursor_value: Date | null;
  last_ok_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  rows_synced: string;
}

export async function orderLaneStatus(db: Sql): Promise<OrderLaneStatusRow[]> {
  return db<OrderLaneStatusRow[]>`
    select table_name, cursor_field, cursor_value, last_ok_at, last_error, last_error_at, rows_synced::text
      from erp_order_sync_state order by table_name, cursor_field
  `;
}

// ── Timer ────────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let firstRun: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<unknown> | null = null;
let ticks = 0;

export function isOrderLaneEnabled(): boolean {
  return hasDatabase && hasErp && hasErpCredentials && config.orders.fastPollMs > 0;
}

export function startOrderSync(): void {
  if (timer || firstRun) return;
  if (!isOrderLaneEnabled()) {
    console.log(
      "[order-lane] not started (needs DATABASE_URL, Selaras credentials and ERP_FAST_POLL_MS > 0).",
    );
    return;
  }
  const tick = () => {
    if (inFlight) return; // a slow ERP never stacks runs
    const includeSlow = ticks % Math.max(1, config.orders.slowEveryTicks) === 0;
    ticks += 1;
    inFlight = runOrderSyncOnce({ includeSlow })
      .catch((err) => console.error(`[order-lane] run failed: ${redactSecrets(err)}`))
      .finally(() => {
        inFlight = null;
      });
  };
  // Let boot (migrations, the first stock sync) settle before the first read.
  firstRun = setTimeout(() => {
    firstRun = null;
    tick();
    timer = setInterval(tick, config.orders.fastPollMs);
    timer.unref?.();
  }, 15_000);
  firstRun.unref?.();
  console.log(`[order-lane] started: every ${config.orders.fastPollMs} ms.`);
}

export async function stopOrderSync(): Promise<void> {
  if (firstRun) clearTimeout(firstRun);
  if (timer) clearInterval(timer);
  firstRun = null;
  timer = null;
  if (inFlight) await inFlight.catch(() => undefined);
}

/** Test hook. */
export function resetOrderLaneForTests(): void {
  listeners.length = 0;
  ticks = 0;
}
