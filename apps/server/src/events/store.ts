/**
 * Kabar Pesanan WP-3 — the I/O half of the event deriver.
 *
 *   deriveForTouched()  the order lane / webhook hands over the ids it wrote;
 *                       load those rows, derive, insert.
 *   sweepEvents()       catch-up: every mirror row whose `synced_at` moved since
 *                       the last sweep, from EITHER sync loop. Makes the log
 *                       independent of any one listener having run.
 *   sweepLate()         the time-based fact: live SO lines whose ETA has passed.
 *
 * Inserts are `on conflict (event_key) do nothing`: replays, overlaps between
 * the three paths, and a second replica all collapse to one row per fact.
 *
 * Rows created before the horizon (EVENTS_HORIZON_DAYS) produce no events, so
 * a re-pull of historic SOs is not mistaken for news.
 */
import { config } from "../config.js";
import type { Sql } from "../db/client.js";
import type { OrderTouched } from "../erp/orderSync.js";
import {
  deriveEvents,
  type DeriveInput,
  type DoFacts,
  type EventDraft,
  type EventSource,
  type HeaderFacts,
  type LateFacts,
  type RequestFacts,
} from "./derive.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySql = any;

export interface StoreOptions {
  horizonDays: number;
  cancelledStatuses: readonly string[];
}

export function defaultStoreOptions(): StoreOptions {
  return { horizonDays: config.events.horizonDays, cancelledStatuses: config.stock.cancelledStatuses };
}

export interface InsertedEvent {
  id: string;
  event_key: string;
  event_type: string;
  so_no: string | null;
}

/** Insert drafts; returns only the facts that were NEW. */
export async function insertEvents(db: AnySql, drafts: readonly EventDraft[], source: EventSource): Promise<InsertedEvent[]> {
  if (drafts.length === 0) return [];
  const rows = drafts.map((d) => ({
    event_key: d.event_key,
    event_type: d.event_type,
    so_no: d.so_no,
    subject_ref: d.subject_ref,
    occurred_at: d.occurred_at,
    payload: db.json(d.payload),
    source,
  }));
  return db<InsertedEvent[]>`
    insert into order_events ${db(rows, "event_key", "event_type", "so_no", "subject_ref", "occurred_at", "payload", "source")}
    on conflict (event_key) do nothing
    returning id::text, event_key, event_type, so_no
  `;
}

// ── Loading facts from the mirror ────────────────────────────────────────────

const HEADER_COLS = `
  id, po_no, to_char(po_date, 'YYYY-MM-DD') as po_date, status_order, customer_name_id, customer_name_text,
  customer_final_id, sales_name_id, sales_name_text, top_limit, erp_created_at`;
const REQUEST_COLS = `
  id, so_no, so_ms, wo_no, no_request, to_char(tanggal_request, 'YYYY-MM-DD') as tanggal_request,
  erp_created_at, deleted_at`;
const DO_COLS = `
  id, so_no, no_sj, to_char(sj_date, 'YYYY-MM-DD') as sj_date, do_created_at, cara_kirim, cancel_order,
  erp_created_at, erp_updated_at, deleted_at`;

/**
 * Rows created inside the horizon. A row with no creation date at all is kept:
 * dropping it would lose a real order, and its event key still dedupes.
 */
const HEADER_FRESH = `(coalesce(erp_created_at, po_date::timestamptz) is null
                      or coalesce(erp_created_at, po_date::timestamptz) >= now() - make_interval(days => $HORIZON))`;
const REQUEST_FRESH = `(coalesce(erp_created_at, tanggal_request::timestamptz) is null
                       or coalesce(erp_created_at, tanggal_request::timestamptz) >= now() - make_interval(days => $HORIZON))`;
const DO_FRESH = `(coalesce(do_created_at, erp_created_at, sj_date::timestamptz) is null
                  or coalesce(do_created_at, erp_created_at, sj_date::timestamptz) >= now() - make_interval(days => $HORIZON))`;

function fresh(predicate: string, horizonDays: number): string {
  // Validated integer, so splicing is safe (the same rule migrateErpStock uses).
  const n = Number.isInteger(horizonDays) && horizonDays > 0 ? horizonDays : 60;
  return predicate.replaceAll("$HORIZON", String(n));
}

async function loadByIds(db: AnySql, touched: OrderTouched, opts: StoreOptions): Promise<DeriveInput> {
  const input: DeriveInput = {};
  if (touched.so_header.length) {
    input.headers = await db.unsafe(
      `select ${HEADER_COLS} from erp_so_header where id = any($1) and ${fresh(HEADER_FRESH, opts.horizonDays)}`,
      [touched.so_header],
    ) as HeaderFacts[];
  }
  if (touched.request_produksi.length) {
    input.requests = await db.unsafe(
      `select ${REQUEST_COLS} from erp_request_produksi where id = any($1) and ${fresh(REQUEST_FRESH, opts.horizonDays)}`,
      [touched.request_produksi],
    ) as RequestFacts[];
  }
  if (touched.do_header.length) {
    input.dos = await db.unsafe(
      `select ${DO_COLS} from erp_do_header where id = any($1) and ${fresh(DO_FRESH, opts.horizonDays)}`,
      [touched.do_header],
    ) as DoFacts[];
  }
  return input;
}

/** Called by the order lane and the webhook with the ids they just wrote. */
export async function deriveForTouched(
  db: AnySql,
  touched: OrderTouched,
  source: EventSource = "erp-mirror",
  opts: StoreOptions = defaultStoreOptions(),
): Promise<InsertedEvent[]> {
  const input = await loadByIds(db, touched, opts);
  return insertEvents(db, deriveEvents(input, opts), source);
}

// ── The catch-up sweep ───────────────────────────────────────────────────────

/** Re-read a margin before the watermark: a transaction that committed late is not missed. */
const SWEEP_OVERLAP_MINUTES = 5;

export interface SweepResult {
  scanned: number;
  inserted: InsertedEvent[];
  sweptUntil: Date;
}

export async function sweepEvents(db: AnySql, opts: StoreOptions = defaultStoreOptions()): Promise<SweepResult> {
  const [state] = await db<{ swept_until: Date | null; now: Date }[]>`
    select swept_until, now() as now from order_event_state where id = 1
  `;
  const startedAt: Date = state?.now ?? new Date();
  // First sweep: everything inside the horizon (the freshness filter bounds it).
  const since: Date = state?.swept_until
    ? new Date(state.swept_until.getTime() - SWEEP_OVERLAP_MINUTES * 60_000)
    : new Date(0);

  const headers = (await db.unsafe(
    `select ${HEADER_COLS} from erp_so_header where synced_at >= $1 and ${fresh(HEADER_FRESH, opts.horizonDays)}`,
    [since],
  )) as HeaderFacts[];
  const requests = (await db.unsafe(
    `select ${REQUEST_COLS} from erp_request_produksi where synced_at >= $1 and ${fresh(REQUEST_FRESH, opts.horizonDays)}`,
    [since],
  )) as RequestFacts[];
  const dos = (await db.unsafe(
    `select ${DO_COLS} from erp_do_header where synced_at >= $1 and ${fresh(DO_FRESH, opts.horizonDays)}`,
    [since],
  )) as DoFacts[];

  const inserted = await insertEvents(db, deriveEvents({ headers, requests, dos }, opts), "erp-mirror");
  // A deleted SO header is removed from the mirror, so it can't be swept; that
  // is fine — so.created is never retracted, and WP-4 rechecks before sending.
  await db`update order_event_state set swept_until = ${startedAt} where id = 1`;
  return { scanned: headers.length + requests.length + dos.length, inserted, sweptUntil: startedAt };
}

// ── so.late ──────────────────────────────────────────────────────────────────

/**
 * SOs with at least one LIVE commitment line (v_live_commitments: approved,
 * balance owed, not cancelled, ETA inside the liveness window, not auto-closed)
 * whose ETA is already in the past. Undated lines are not late — they have no
 * date to be late against.
 */
export async function loadLate(db: AnySql): Promise<LateFacts[]> {
  const rows = await db<{ po_no: string; earliest_eta: string; lines: number; balance: string }[]>`
    select po_no,
           to_char(min(estimate_delivery), 'YYYY-MM-DD') as earliest_eta,
           count(*)::int as lines,
           sum(qty_balance)::text as balance
      from v_live_commitments
     where po_no is not null and estimate_delivery < current_date
     group by po_no
  `;
  return rows.map((r: { po_no: string; earliest_eta: string; lines: number; balance: string }) => ({ ...r, balance: Number(r.balance) }));
}

export async function sweepLate(db: AnySql, opts: StoreOptions = defaultStoreOptions()): Promise<InsertedEvent[]> {
  const late = await loadLate(db);
  const inserted = await insertEvents(db, deriveEvents({ late }, opts), "erp-mirror");
  await db`update order_event_state set late_swept_at = now() where id = 1`;
  return inserted;
}

export async function lateSweepDue(db: Sql, everyMinutes: number): Promise<boolean> {
  const [r] = await db<{ due: boolean }[]>`
    select (late_swept_at is null or late_swept_at < now() - make_interval(mins => ${everyMinutes})) as due
      from order_event_state where id = 1
  `;
  return Boolean(r?.due);
}
