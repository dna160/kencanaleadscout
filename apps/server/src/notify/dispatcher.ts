/**
 * Kabar Pesanan WP-4 — planner + outbox dispatcher (PRD §5.2, §7, §9, §10.4).
 *
 * PLANNER. Reads `order_events` after `notify_settings.planned_event_id` and
 * writes OUTBOX rows into `notify_ledger` (status `pending`, `due_at` = now +
 * hold). Nothing is rendered or resolved yet. `do.cancelled` cancels a pending
 * step-3 row, or — if the customer was already told — queues a rep notice.
 *
 * DISPATCHER. Claims due rows with `FOR UPDATE SKIP LOCKED` (replica-safe; a
 * crashed claim is reclaimed after its lease, and the gateway dedupes on the
 * idempotency key), then for each row, at SEND time:
 *   1. re-reads the order from the mirror (pre-send recheck);
 *   2. merges step 1 into step 3 when the DO arrived during step 1's hold;
 *   3. applies exclusions, opt-out, the shared-number guard, the daily cap and
 *      the sending window;
 *   4. renders, sends through the configured channel, records the outcome.
 * Every decision leaves the row in a terminal or deferred state with a reason:
 * nothing is dropped silently.
 *
 * MODES (NOTIFY_LIVE): `off` plans nothing. `shadow` sends every message ONLY
 * to the SO's rep, wrapped with what live mode would have done. `on` sends to
 * the customer and CCs the rep. Changing mode starts afresh from that moment:
 * the activation watermark moves to now, earlier events are never planned, and
 * pending rows of the previous mode are cancelled.
 *
 * PAUSES (never drops): a stale ERP mirror, or a gateway that is not connected.
 */
import { config, hasErp } from "../config.js";
import { getSql, type Sql } from "../db/client.js";
import { isOrderLaneEnabled } from "../erp/orderSync.js";
import { redactSecrets } from "../erp/selarasClient.js";
import { getChannel, type Channel, type SendResult } from "./channel.js";
import { loadDo, loadHeader, loadLiveOrder, loadRep, localDisplay } from "./context.js";
import {
  isMilestone,
  renderCustomerMessage,
  renderDoCancelledNotice,
  renderSalesCc,
  renderShadow,
  TEMPLATE_VERSION,
  type Milestone,
} from "./messages.js";
import {
  DO_CANCELLED_NOTICE,
  erpAgeHours,
  EVENT_MILESTONE,
  holdFor,
  isDirectShip,
  isExcludedCustomer,
  maskE164,
  nextSendWindow,
  outboxKey,
  resolveRecipient,
  wibDayStart,
  type LiveMode,
} from "./rules.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySql = Sql | any;

export interface DispatchLogger {
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
}

export interface DispatchDeps {
  db: AnySql;
  channel: Channel;
  mode: LiveMode;
  now: () => Date;
  holds: Record<Milestone, number>;
  dailyCap: number;
  fromHour: number;
  untilHour: number;
  maxEventAgeHours: number;
  excluded: readonly string[];
  sharedNumberCustomers: number;
  batch: number;
  /** Null when sending may proceed; otherwise why it is paused. */
  pauseReason: (db: AnySql, channel: Channel) => Promise<string | null>;
  log: DispatchLogger;
}

const SENT = ["sent", "queued", "stubbed"];
const MAX_ATTEMPTS = 3;

// ── Mode / watermark ─────────────────────────────────────────────────────────

export interface ModeState {
  mode: LiveMode;
  watermark: Date | null;
  plannedEventId: number;
  changed: boolean;
}

/**
 * Record the active mode. On a change: watermark = now, start planning after
 * the newest existing event, and cancel the previous mode's pending rows.
 */
export async function syncMode(db: AnySql, mode: LiveMode, now: Date): Promise<ModeState> {
  return db.begin(async (tx: AnySql) => {
    const [s] = await tx<{ live_mode: string | null; activation_watermark: Date | null; planned_event_id: string }[]>`
      select live_mode, activation_watermark, planned_event_id::text from notify_settings where id = 1 for update
    `;
    if (s && s.live_mode === mode) {
      return { mode, watermark: s.activation_watermark, plannedEventId: Number(s.planned_event_id), changed: false };
    }
    const [{ max } = { max: "0" }] = await tx<{ max: string }[]>`select coalesce(max(id), 0)::text as max from order_events`;
    await tx`
      update notify_settings
         set live_mode = ${mode}, activation_watermark = ${now}, planned_event_id = ${Number(max)}, updated_at = now()
       where id = 1
    `;
    await tx`
      update notify_ledger set status = 'cancelled', cancel_reason = 'mode_changed', leased_until = null
       where mode in ('live', 'shadow') and status in ('pending', 'sending', 'held')
    `;
    return { mode, watermark: now, plannedEventId: Number(max), changed: true };
  });
}

/** Ledger `mode` for a live mode. */
function ledgerMode(mode: LiveMode): "live" | "shadow" {
  return mode === "on" ? "live" : "shadow";
}

// ── Planner ──────────────────────────────────────────────────────────────────

interface EventRow {
  id: string;
  event_type: string;
  so_no: string | null;
  subject_ref: string | null;
  occurred_at: Date | null;
  payload: Record<string, unknown>;
}

interface PlannedRow {
  milestone: string;
  so_no: string | null;
  recipient_role: "customer" | "sales_cc";
  status: string;
  cancel_reason: string | null;
  idempotency_key: string;
  event_id: number;
  subject_ref: string | null;
  due_at: Date;
}

export async function planEvents(deps: DispatchDeps, limit = 500): Promise<number> {
  const { db, mode } = deps;
  if (mode === "off") return 0;
  const now = deps.now();
  const lmode = ledgerMode(mode);
  const [s] = await db<{ planned_event_id: string }[]>`select planned_event_id::text from notify_settings where id = 1`;
  const after = Number(s?.planned_event_id ?? 0);
  const events = await db<EventRow[]>`
    select id::text, event_type, so_no, subject_ref, occurred_at, payload
      from order_events where id > ${after} order by id limit ${limit}
  `;
  if (!events.length) return 0;

  const rows: PlannedRow[] = [];
  for (const e of events) {
    const eid = Number(e.id);
    if (!e.so_no) continue;
    if (e.event_type === "do.cancelled") {
      await planDoCancelled(deps, e, rows);
      continue;
    }
    const milestone = EVENT_MILESTONE[e.event_type];
    if (!milestone) continue; // so.late is internal (M9 delay log), never a customer message
    const subject = milestone === "delivery_scheduled" ? String(e.payload["do_id"] ?? e.subject_ref ?? "") : e.so_no;
    if (!subject) continue;

    const age = erpAgeHours(e.occurred_at, now);
    const stale = age !== null && age > deps.maxEventAgeHours;
    const due = new Date(now.getTime() + holdFor(milestone, deps.holds) * 60_000);
    const base = { milestone, so_no: e.so_no, event_id: eid, subject_ref: milestone === "delivery_scheduled" ? subject : null };
    rows.push({
      ...base,
      recipient_role: "customer",
      status: stale ? "skipped" : "pending",
      cancel_reason: stale ? "stale_event" : null,
      idempotency_key: outboxKey(mode, milestone, subject, "customer"),
      due_at: due,
    });
    if (mode === "on" && !stale) {
      rows.push({
        ...base,
        recipient_role: "sales_cc",
        status: "pending",
        cancel_reason: null,
        idempotency_key: outboxKey(mode, milestone, subject, "sales_cc"),
        // Same due time; inserted after its customer row, and the claim orders
        // by (due_at, id), so the customer row is always processed first.
        due_at: due,
      });
    }
  }

  if (rows.length) {
    await db`
      insert into notify_ledger ${db(
        rows.map((r) => ({ ...r, mode: lmode, channel: deps.channel.mode, context_source: "erp" })),
        "mode", "milestone", "so_no", "recipient_role", "status", "cancel_reason", "idempotency_key",
        "event_id", "subject_ref", "due_at", "channel", "context_source",
      )}
      on conflict (idempotency_key) do nothing
    `;
  }
  const last = Number(events[events.length - 1]!.id);
  await db`update notify_settings set planned_event_id = greatest(planned_event_id, ${last}) where id = 1`;
  return rows.length;
}

async function planDoCancelled(deps: DispatchDeps, e: EventRow, rows: PlannedRow[]): Promise<void> {
  const { db, mode } = deps;
  const doId = String(e.payload["do_id"] ?? "");
  if (!doId) return;
  const lmode = ledgerMode(mode);
  await db`
    update notify_ledger set status = 'cancelled', cancel_reason = 'do_cancelled', leased_until = null
     where mode = ${lmode} and milestone = 'delivery_scheduled' and subject_ref = ${doId}
       and status in ('pending', 'held')
  `;
  const [told] = await db<{ n: number }[]>`
    select count(*)::int as n from notify_ledger
     where mode = ${lmode} and milestone = 'delivery_scheduled' and subject_ref = ${doId}
       and recipient_role = 'customer' and status = any(${SENT})
  `;
  if ((told?.n ?? 0) > 0) {
    rows.push({
      milestone: DO_CANCELLED_NOTICE,
      so_no: e.so_no,
      recipient_role: "sales_cc",
      status: "pending",
      cancel_reason: null,
      idempotency_key: outboxKey(mode, DO_CANCELLED_NOTICE, doId, "sales_cc"),
      event_id: Number(e.id),
      subject_ref: doId,
      due_at: deps.now(),
    });
  }
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

interface LedgerRow {
  id: string;
  mode: string;
  milestone: string;
  so_no: string;
  recipient_role: "customer" | "sales_cc";
  to_number: string | null;
  body: string | null;
  status: string;
  cancel_reason: string | null;
  idempotency_key: string;
  subject_ref: string | null;
  attempts: number;
  meta: Record<string, unknown>;
}

export interface DispatchResult {
  paused: string | null;
  planned: number;
  processed: number;
}

async function claim(deps: DispatchDeps): Promise<LedgerRow[]> {
  const now = deps.now();
  const lease = new Date(now.getTime() + 120_000);
  return deps.db<LedgerRow[]>`
    update notify_ledger set status = 'sending', leased_until = ${lease}, attempts = attempts + 1
     where id in (
       select id from notify_ledger
        where mode = ${ledgerMode(deps.mode)}
          and ((status = 'pending' and due_at <= ${now}) or (status = 'sending' and leased_until < ${now}))
        order by due_at, id
        limit ${deps.batch}
        for update skip locked
     )
    returning id::text, mode, milestone, so_no, recipient_role, to_number, body, status, cancel_reason,
              idempotency_key, subject_ref, attempts, meta
  `;
}

async function finish(
  deps: DispatchDeps,
  row: LedgerRow,
  fields: { status: string; cancel_reason?: string | null; to_number?: string | null; body?: string | null; error?: string | null; due_at?: Date | null; meta?: Record<string, unknown>; send?: SendResult; from?: string | null },
): Promise<void> {
  const sent = fields.send && SENT.includes(fields.send.status);
  await deps.db`
    update notify_ledger set
      status              = ${fields.status},
      cancel_reason       = ${fields.cancel_reason ?? null},
      to_number           = coalesce(${fields.to_number ?? null}, to_number),
      body                = coalesce(${fields.body ?? null}, body),
      from_number         = coalesce(${fields.from ?? null}, from_number),
      channel             = ${deps.channel.mode},
      error               = ${fields.error ?? fields.send?.error ?? null},
      provider_message_id = coalesce(${fields.send?.providerMessageId ?? null}, provider_message_id),
      template_version    = ${TEMPLATE_VERSION},
      sent_at             = ${sent ? deps.now() : null},
      due_at              = coalesce(${fields.due_at ?? null}, due_at),
      meta                = ${deps.db.json({ ...row.meta, ...(fields.meta ?? {}) })},
      leased_until        = null
     where id = ${row.id}
  `;
}

/** Wait until later without spending an attempt. */
async function defer(deps: DispatchDeps, row: LedgerRow, until: Date, why: string): Promise<void> {
  await deps.db`
    update notify_ledger set status = 'pending', due_at = ${until}, leased_until = null,
           attempts = greatest(attempts - 1, 0),
           meta = ${deps.db.json({ ...row.meta, deferred: why })}
     where id = ${row.id}
  `;
}

async function systemNumber(db: AnySql): Promise<string | null> {
  const [r] = await db<{ system_number: string | null }[]>`select system_number from notify_settings where id = 1`;
  return r?.system_number ?? null;
}

async function send(deps: DispatchDeps, row: LedgerRow, to: string, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  const result = await deps.channel.send({ to, text, idempotencyKey: row.idempotency_key });
  const from = await systemNumber(deps.db);
  if (result.status === "failed" && row.attempts < MAX_ATTEMPTS) {
    // Transient by default: retry with backoff, keeping the rendered text.
    await finish(deps, row, {
      status: "pending",
      to_number: to,
      body: text,
      error: result.error,
      due_at: new Date(deps.now().getTime() + row.attempts * 5 * 60_000),
      meta: extra,
      from,
    });
    return;
  }
  await finish(deps, row, { status: result.status, to_number: to, body: text, send: result, meta: extra, from });
}

/** Number of different customers whose SOs (last 90 days) carry this phone. */
async function customersOnNumber(db: AnySql, e164: string): Promise<number> {
  const tail = e164.replace(/\D/g, "").slice(-9);
  const [r] = await db<{ n: number }[]>`
    select count(distinct customer_name_id)::int as n from erp_so_header
     where coalesce(erp_created_at, po_date::timestamptz) >= now() - interval '90 days'
       and regexp_replace(coalesce(kontak_penerima, ''), '\\D', '', 'g') like ${`%${tail}%`}
  `;
  return r?.n ?? 0;
}

async function sentTodayTo(deps: DispatchDeps, e164: string): Promise<number> {
  const [r] = await deps.db<{ n: number }[]>`
    select count(*)::int as n from notify_ledger
     where mode = 'live' and recipient_role = 'customer' and to_number = ${e164}
       and milestone in ('so_received', 'production_started', 'delivery_scheduled')
       and sent_at >= ${wibDayStart(deps.now())}
  `;
  return r?.n ?? 0;
}

async function processCustomer(deps: DispatchDeps, row: LedgerRow): Promise<void> {
  const { db, mode } = deps;
  const m = row.milestone as Milestone;
  const isDelivery = m === "delivery_scheduled";
  const order = await loadLiveOrder(db, row.so_no, isDelivery ? row.subject_ref : null);
  if (!order) return finish(deps, row, { status: "cancelled", cancel_reason: "so_missing" });
  const { header, ctx, rep, doRow } = order;

  // 1. Pre-send recheck.
  if (config.stock.cancelledStatuses.some((c) => c.toLowerCase() === (header.status_order ?? "").toLowerCase())) {
    return finish(deps, row, { status: "cancelled", cancel_reason: "so_cancelled" });
  }
  if (m === "production_started" && !ctx.production) {
    return finish(deps, row, { status: "cancelled", cancel_reason: "no_production_request" });
  }
  if (isDelivery && (!doRow || doRow.deleted || (doRow.cancel_order ?? "").toLowerCase() === "yes" || !ctx.delivery)) {
    return finish(deps, row, { status: "cancelled", cancel_reason: "do_cancelled" });
  }

  // 2. Merge step 1 into step 3 (whichever is processed first).
  const lmode = ledgerMode(mode);
  let mergedReceived = row.meta["mergedReceived"] === true;
  if (m === "so_received") {
    const [mv3] = await db<{ id: string }[]>`
      select id::text from notify_ledger
       where mode = ${lmode} and so_no = ${row.so_no} and milestone = 'delivery_scheduled'
         and recipient_role = 'customer' and status = 'pending'
       order by id limit 1
    `;
    if (mv3) {
      await db`
        update notify_ledger set meta = meta || '{"mergedReceived": true}'::jsonb where id = ${mv3.id}
      `;
      await db`
        update notify_ledger set status = 'cancelled', cancel_reason = 'merged', leased_until = null
         where mode = ${lmode} and so_no = ${row.so_no} and milestone = 'so_received' and status = 'pending'
      `;
      return finish(deps, row, { status: "cancelled", cancel_reason: "merged", meta: { mergedInto: mv3.id } });
    }
  } else if (isDelivery) {
    const merged = await db`
      update notify_ledger set status = 'cancelled', cancel_reason = 'merged', leased_until = null,
             meta = meta || ${db.json({ mergedInto: row.id })}
       where mode = ${lmode} and so_no = ${row.so_no} and milestone = 'so_received'
         and status in ('pending', 'sending') and id <> ${row.id}
      returning id
    `;
    if (merged.length) mergedReceived = true;
  }

  // 3. Exclusions — silent in both modes (these customers are never messaged).
  if (isExcludedCustomer(header.customer_name_text, deps.excluded)) {
    return finish(deps, row, { status: "cancelled", cancel_reason: "excluded_customer" });
  }
  if (isDirectShip(header.customer_name_id, header.customer_final_id)) {
    return finish(deps, row, { status: "cancelled", cancel_reason: "direct_ship" });
  }
  const [ov] = header.customer_name_id
    ? await db<{ phone_e164: string | null; muted: boolean }[]>`
        select phone_e164, muted from notify_customer_overrides where customer_name_id = ${header.customer_name_id}`
    : [];
  if (ov?.muted) return finish(deps, row, { status: "cancelled", cancel_reason: "muted" });

  // 4. Recipient and per-number guards.
  const recipient = resolveRecipient(ov?.phone_e164 ?? null, header.kontak_penerima);
  const phone = recipient.phone;
  let verdict: { ok: boolean; reason: string | null; text: string };
  if (!phone) {
    verdict = { ok: false, reason: "unreachable", text: "Di mode live: TIDAK terkirim — SO tidak punya nomor WhatsApp pelanggan (kontak_penerima)." };
  } else {
    const [c] = await db<{ consent_state: string; first_contacted_at: Date | null }[]>`
      select consent_state, first_contacted_at from notify_contacts where phone_e164 = ${phone}`;
    const shared = (await customersOnNumber(db, phone)) >= deps.sharedNumberCustomers;
    if (c?.consent_state === "opted_out") {
      verdict = { ok: false, reason: "opted_out", text: `Di mode live: TIDAK terkirim — ${maskE164(phone)} sudah berhenti berlangganan (STOP).` };
    } else if (shared) {
      verdict = { ok: false, reason: "shared_number", text: `Di mode live: DITAHAN untuk ditinjau — ${maskE164(phone)} dipakai di SO ≥${deps.sharedNumberCustomers} pelanggan berbeda.` };
    } else {
      verdict = { ok: true, reason: null, text: `Di mode live: terkirim ke ${maskE164(phone)}${recipient.source === "override" ? " (nomor pengganti)" : ""}.` };
    }
  }
  const [contact] = phone
    ? await db<{ first_contacted_at: Date | null }[]>`select first_contacted_at from notify_contacts where phone_e164 = ${phone}`
    : [];
  const text = renderCustomerMessage(m, ctx, { mergedReceived, introduce: Boolean(phone) && !contact?.first_contacted_at });
  const meta = { mergedReceived, recipientSource: recipient.source, verdict: verdict.reason ?? "ok" };

  // 5. Sending window (also protects reps' evenings in shadow mode).
  const wait = nextSendWindow(deps.now(), deps.fromHour, deps.untilHour);
  if (wait) return defer(deps, row, wait, "quiet_hours");

  if (mode === "shadow") {
    if (!rep.phone) return finish(deps, row, { status: "unreachable", cancel_reason: "rep_no_phone", body: text, meta });
    return send(deps, row, rep.phone, renderShadow(m, row.so_no, verdict.text, text), meta);
  }

  // mode === "on"
  if (!phone) return finish(deps, row, { status: "unreachable", cancel_reason: "unreachable", body: text, meta });
  if (verdict.reason === "opted_out") return finish(deps, row, { status: "cancelled", cancel_reason: "opted_out", to_number: phone, body: text, meta });
  if (verdict.reason === "shared_number") return finish(deps, row, { status: "held", cancel_reason: "shared_number", to_number: phone, body: text, meta });
  if ((await sentTodayTo(deps, phone)) >= deps.dailyCap) {
    const tomorrow = new Date(wibDayStart(deps.now()).getTime() + 86_400_000 + deps.fromHour * 3_600_000);
    return defer(deps, row, tomorrow, "daily_cap");
  }
  await send(deps, row, phone, text, meta);
  await db`
    insert into notify_contacts (phone_e164, consent_source, first_contacted_at)
    values (${phone}, 'implied:kontak_penerima', ${deps.now()})
    on conflict (phone_e164) do update set first_contacted_at = coalesce(notify_contacts.first_contacted_at, excluded.first_contacted_at)
  `;
}

async function processCc(deps: DispatchDeps, row: LedgerRow): Promise<void> {
  const { db } = deps;
  const m = row.milestone as Milestone;
  const siblingKey = row.idempotency_key.replace(/:sales_cc$/, ":customer");
  const [sib] = await db<{ status: string; cancel_reason: string | null; to_number: string | null; body: string | null; due_at: Date | null }[]>`
    select status, cancel_reason, to_number, body, due_at from notify_ledger where idempotency_key = ${siblingKey}`;
  if (!sib || sib.status === "pending" || sib.status === "sending") {
    // Follow the customer row (it may be waiting for tomorrow's window or cap).
    const soon = deps.now().getTime() + 30_000;
    const at = Math.max(soon, (sib?.due_at?.getTime() ?? 0) + 1_000);
    return defer(deps, row, new Date(at), "awaiting_customer_row");
  }
  if (sib.status === "cancelled" || sib.status === "skipped") {
    return finish(deps, row, { status: "cancelled", cancel_reason: sib.cancel_reason ?? sib.status });
  }
  if (sib.status === "held") return finish(deps, row, { status: "held", cancel_reason: sib.cancel_reason });

  const header = await loadHeader(db, row.so_no);
  if (!header) return finish(deps, row, { status: "cancelled", cancel_reason: "so_missing" });
  const rep = await loadRep(db, header);
  if (!rep.phone) return finish(deps, row, { status: "cancelled", cancel_reason: "rep_no_phone" });
  if (!rep.ccEnabled) return finish(deps, row, { status: "cancelled", cancel_reason: "cc_disabled" });
  const wait = nextSendWindow(deps.now(), deps.fromHour, deps.untilHour);
  if (wait) return defer(deps, row, wait, "quiet_hours");

  const warning =
    sib.status === "unreachable"
      ? "Pelanggan TIDAK menerima pesan ini: SO tidak punya nomor WhatsApp (kontak_penerima). Mohon lengkapi di Selaras."
      : sib.status === "failed"
        ? "Pesan GAGAL terkirim ke pelanggan."
        : undefined;
  const ctx = { soNo: row.so_no, customerName: header.customer_name_text ?? "Pelanggan" };
  const text = renderSalesCc(m, ctx as never, sib.to_number ? localDisplay(sib.to_number) : "tanpa nomor", sib.body ?? "", warning);
  await send(deps, row, rep.phone, text);
}

async function processNotice(deps: DispatchDeps, row: LedgerRow): Promise<void> {
  const header = await loadHeader(deps.db, row.so_no);
  if (!header) return finish(deps, row, { status: "cancelled", cancel_reason: "so_missing" });
  const rep = await loadRep(deps.db, header);
  if (!rep.phone) return finish(deps, row, { status: "cancelled", cancel_reason: "rep_no_phone" });
  const d = row.subject_ref ? await loadDo(deps.db, row.subject_ref) : null;
  const text = renderDoCancelledNotice(row.so_no, d?.no_sj ?? row.subject_ref ?? "?", header.customer_name_text ?? "Pelanggan", deps.mode === "shadow");
  await send(deps, row, rep.phone, text);
}

async function processRow(deps: DispatchDeps, row: LedgerRow): Promise<void> {
  try {
    // An earlier row in this same batch may have settled this one (a step-3
    // message merging step 1 cancels it). Only a row still ours is processed.
    const [cur] = await deps.db<{ status: string }[]>`select status from notify_ledger where id = ${row.id}`;
    if (cur?.status !== "sending") return;
    if (row.milestone === DO_CANCELLED_NOTICE) return await processNotice(deps, row);
    if (!isMilestone(row.milestone)) return await finish(deps, row, { status: "cancelled", cancel_reason: "unknown_milestone" });
    if (row.recipient_role === "sales_cc") return await processCc(deps, row);
    return await processCustomer(deps, row);
  } catch (err) {
    const msg = redactSecrets(err);
    deps.log.error(`[notify] row ${row.id} (${row.milestone} ${row.so_no}) failed: ${msg}`);
    const final = row.attempts >= MAX_ATTEMPTS;
    await finish(deps, row, {
      status: final ? "failed" : "pending",
      error: msg,
      due_at: final ? null : new Date(deps.now().getTime() + row.attempts * 5 * 60_000),
    }).catch(() => undefined);
  }
}

/** One tick: plan new events, then (unless paused) dispatch due rows. */
export async function dispatchOnce(deps: DispatchDeps): Promise<DispatchResult> {
  if (deps.mode === "off") return { paused: "off", planned: 0, processed: 0 };
  await syncMode(deps.db, deps.mode, deps.now());
  const planned = await planEvents(deps);
  const paused = await deps.pauseReason(deps.db, deps.channel);
  if (paused) return { paused, planned, processed: 0 };
  const rows = await claim(deps);
  for (const row of rows) await processRow(deps, row);
  return { paused: null, planned, processed: rows.length };
}

// ── Pause rules (PRD §5.2, §10.4) ────────────────────────────────────────────

/**
 * Stale mirror ⇒ pause: a message must never be built from data older than a
 * few sync intervals. Disconnected gateway ⇒ pause: nothing is dropped, rows
 * wait. The stub channel never pauses.
 */
export async function defaultPauseReason(db: AnySql, channel: Channel): Promise<string | null> {
  if (!hasErp) return "erp_not_configured";
  if (isOrderLaneEnabled()) {
    const limitMs = 3 * config.orders.fastPollMs;
    const [r] = await db<{ stale: number }[]>`
      select count(*)::int as stale from (values ('so_header'), ('do_header'), ('request_produksi')) t(name)
       left join erp_order_sync_state s on s.table_name = t.name and s.cursor_field = 'updated_at'
       where s.last_ok_at is null or s.last_ok_at < now() - make_interval(secs => ${limitMs / 1000})
    `;
    if ((r?.stale ?? 1) > 0) return "mirror_stale";
  } else {
    const limitMs = 3 * config.stock.syncIntervalMs;
    const [r] = await db<{ ok: boolean }[]>`
      select (last_ok_at is not null and last_ok_at >= now() - make_interval(secs => ${limitMs / 1000})) as ok
        from erp_sync_state where table_name = 'so_header'
    `;
    if (!r?.ok) return "mirror_stale";
  }
  if (channel.mode === "gateway" && !(await channel.health()).connected) return "gateway_disconnected";
  return null;
}

// ── Timer ────────────────────────────────────────────────────────────────────

export function defaultDispatchDeps(over: Partial<DispatchDeps> = {}): DispatchDeps | null {
  const db = over.db ?? getSql();
  if (!db) return null;
  return {
    db,
    channel: over.channel ?? getChannel(),
    mode: over.mode ?? config.notify.live,
    now: over.now ?? (() => new Date()),
    holds: over.holds ?? config.notify.holdMinutes,
    dailyCap: over.dailyCap ?? config.notify.dailyCapPerPhone,
    fromHour: over.fromHour ?? config.notify.quietStartHour,
    untilHour: over.untilHour ?? config.notify.quietEndHour,
    maxEventAgeHours: over.maxEventAgeHours ?? config.notify.maxEventAgeHours,
    excluded: over.excluded ?? config.notify.excludeCustomers,
    sharedNumberCustomers: over.sharedNumberCustomers ?? config.notify.sharedNumberCustomers,
    batch: over.batch ?? 20,
    pauseReason: over.pauseReason ?? defaultPauseReason,
    log: over.log ?? { info: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m) },
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<unknown> | null = null;
let lastPause: string | null = null;

export async function startNotifyDispatcher(): Promise<void> {
  const deps = defaultDispatchDeps();
  if (!deps || timer) return;
  // Always record the mode, OFF included: turning it back on later must start
  // from that moment, not replay everything that happened while it was off.
  try {
    await syncMode(deps.db, deps.mode, deps.now());
  } catch (err) {
    console.error(`[notify] could not record NOTIFY_LIVE=${deps.mode}: ${redactSecrets(err)}`);
    return;
  }
  if (deps.mode === "off") {
    console.log("[notify] live triggers OFF (NOTIFY_LIVE=off): events are recorded, nothing is sent.");
    return;
  }
  console.log(`[notify] live triggers ${deps.mode.toUpperCase()} via ${deps.channel.mode} channel.`);
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = dispatchOnce(deps)
      .then((r) => {
        if (r.paused !== lastPause) {
          if (r.paused) console.warn(`[notify] dispatch paused: ${r.paused} (messages wait, none are dropped).`);
          else if (lastPause) console.log("[notify] dispatch resumed.");
          lastPause = r.paused;
        }
      })
      .catch((err) => console.error(`[notify] dispatch failed: ${redactSecrets(err)}`))
      .finally(() => {
        inFlight = null;
      });
  }, config.notify.dispatchIntervalMs);
  timer.unref?.();
}

export async function stopNotifyDispatcher(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  if (inFlight) await inFlight.catch(() => undefined);
}
