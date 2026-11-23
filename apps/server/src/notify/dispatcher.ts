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
 *   2. holds step 3 until the SO's confirmation (step 1) has gone out;
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
import { unmarkedToday, type UnmarkedRow } from "./dispatch.js";
import {
  isMilestone,
  MILESTONES,
  renderCustomerMessage,
  renderDispatchReminder,
  renderHoldReminder,
  renderDoCancelledNotice,
  renderSalesCc,
  renderShadow,
  TEMPLATE_VERSION,
  type Milestone,
} from "./messages.js";
import {
  DISPATCH_REMINDER,
  HOLD_REMINDER,
  DO_CANCELLED_NOTICE,
  DO_MILESTONES,
  erpAgeHours,
  EVENT_MILESTONE,
  holdFor,
  isDirectShip,
  isExcludedCustomer,
  maskE164,
  nextSendWindow,
  outboxKey,
  resolveRecipient,
  wibDate,
  wibDayStart,
  wibHour,
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
  holds: Partial<Record<Milestone, number>>;
  dailyCap: number;
  fromHour: number;
  untilHour: number;
  maxEventAgeHours: number;
  excluded: readonly string[];
  sharedNumberCustomers: number;
  batch: number;
  /** Plan the afternoon reminder of unmarked deliveries (off in tests that count messages). */
  reminders: boolean;
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
  meta?: Record<string, unknown>;
}

export async function planEvents(deps: DispatchDeps, limit = 500): Promise<number> {
  const { db, mode } = deps;
  if (mode === "off") return 0;
  const now = deps.now();
  const lmode = ledgerMode(mode);
  const [s] = await db<{ planned_event_id: string }[]>`select planned_event_id::text from notify_settings where id = 1`;
  const after = Number(s?.planned_event_id ?? 0);
  const [sw] = await db<{ milestones_enabled: Record<string, boolean>; depart_from_xtable: boolean }[]>`
    select milestones_enabled, depart_from_xtable from notify_settings where id = 1`;
  const enabled = (m: string) => sw?.milestones_enabled?.[m] !== false;
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
    const doId = DO_MILESTONES.includes(milestone) ? String(e.payload["do_id"] ?? e.subject_ref ?? "") : null;
    // Step 3 is one message per surat jalan; a dispatch mark is one per mark
    // (a DO can be delayed twice), and the dispatcher sends only the latest.
    const markId = e.payload["mark_id"] != null ? String(e.payload["mark_id"]) : null;
    const subject = doId ? (markId ? `${doId}:m${markId}` : doId) : e.so_no;
    if (!subject) continue;

    const age = erpAgeHours(e.occurred_at, now);
    // A step switched off on /notify is recorded as skipped (audit), never sent.
    const off = !enabled(milestone);
    // "Sedang dikirim" from XTable (PRD §21.3): a field filled after the
    // delivery day is a backfill, and the source can be switched off.
    const xtable = e.payload["source"] === "xtable";
    const backfill = xtable && e.payload["backfill"] === true;
    const sourceOff = xtable && sw?.depart_from_xtable === false;
    const stale = off || backfill || sourceOff || (age !== null && age > deps.maxEventAgeHours);
    const due = new Date(now.getTime() + holdFor(milestone, deps.holds) * 60_000);
    const base = { milestone, so_no: e.so_no, event_id: eid, subject_ref: doId, meta: doId ? e.payload : {} };
    rows.push({
      ...base,
      recipient_role: "customer",
      status: stale ? "skipped" : "pending",
      cancel_reason: off ? "milestone_off" : backfill ? "backfill" : sourceOff ? "source_off" : stale ? "stale_event" : null,
      idempotency_key: outboxKey(mode, milestone, subject, "customer"),
      due_at: due,
    });
    // "Barang dikirim" carries no rep CC: one more message per delivery to every
    // rep, every morning, would bury the CCs that need attention (delays).
    if (mode === "on" && !stale && milestone !== "delivery_departed") {
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
        rows.map((r) => ({ ...r, meta: db.json(r.meta ?? {}), mode: lmode, channel: deps.channel.mode, context_source: "erp" })),
        "mode", "milestone", "so_no", "recipient_role", "status", "cancel_reason", "idempotency_key",
        "event_id", "subject_ref", "due_at", "channel", "context_source", "meta",
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
     where mode = ${lmode} and milestone = any(${DO_MILESTONES as string[]}) and subject_ref = ${doId}
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
  due_at: Date | null;
}

export interface DispatchResult {
  paused: string | null;
  planned: number;
  processed: number;
}

async function claim(deps: DispatchDeps): Promise<LedgerRow[]> {
  const now = deps.now();
  const lease = new Date(now.getTime() + 120_000);
  const rows = await deps.db<LedgerRow[]>`
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
              idempotency_key, subject_ref, attempts, meta, due_at
  `;
  // UPDATE … RETURNING yields rows in PHYSICAL order, not the subquery's. The
  // processing order matters (a customer row must settle before its CC, which
  // is planned with the same due_at and a higher id), so restore it here.
  return [...rows].sort(
    (a, b) => (a.due_at?.getTime() ?? 0) - (b.due_at?.getTime() ?? 0) || Number(a.id) - Number(b.id),
  );
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
       and milestone = any(${[...MILESTONES] as string[]})
       and sent_at >= ${wibDayStart(deps.now())}
  `;
  return r?.n ?? 0;
}

async function processCustomer(deps: DispatchDeps, row: LedgerRow): Promise<void> {
  const { db, mode } = deps;
  const m = row.milestone as Milestone;
  const isDelivery = DO_MILESTONES.includes(m);
  const order = await loadLiveOrder(db, row.so_no, isDelivery ? row.subject_ref : null);
  if (!order) return finish(deps, row, { status: "cancelled", cancel_reason: "so_missing" });
  const { header, ctx, rep, doRow } = order;

  // 1. Pre-send recheck.
  if (config.stock.cancelledStatuses.some((c) => c.toLowerCase() === (header.status_order ?? "").toLowerCase())) {
    return finish(deps, row, { status: "cancelled", cancel_reason: "so_cancelled" });
  }
  if (isDelivery && (!doRow || doRow.deleted || (doRow.cancel_order ?? "").toLowerCase() === "yes" || !ctx.delivery)) {
    return finish(deps, row, { status: "cancelled", cancel_reason: "do_cancelled" });
  }

  // 1b. Dispatch marks (PRD §20): only the DO's latest mark is ever sent, and
  // step 3 gives way to a mark made before it went out (the mark's message
  // carries the up-to-date schedule).
  const lmode = ledgerMode(mode);
  let change: { from: string | null; to: string | null; told: boolean } | undefined;
  if (isDelivery && row.subject_ref) {
    const [ds] = await db<{ last_mark_id: string | null }[]>`
      select last_mark_id::text from notify_dispatch where do_id = ${row.subject_ref}`;
    const markId = row.meta["mark_id"] != null ? String(row.meta["mark_id"]) : null;
    const xtable = row.meta["source"] === "xtable";
    if (m === "delivery_scheduled") {
      if (ds?.last_mark_id) return finish(deps, row, { status: "cancelled", cancel_reason: "superseded" });
      // PRD §21.5: the customer asked to move this delivery; the schedule waits for the answer.
      const [hold] = await db<{ id: string }[]>`
        select id::text from notify_do_holds where do_id = ${row.subject_ref} and resolved_at is null limit 1`;
      if (hold) return defer(deps, row, new Date(deps.now().getTime() + 15 * 60_000), "reschedule_hold");
      // PRD §21.5 (4): this DO re-issues one cancelled in the last 7 days whose date the
      // customer was given: say the schedule CHANGED, not a fresh "dijadwalkan".
      const [prev] = await db<{ sj_date: string | null }[]>`
        select to_char(o.sj_date, 'YYYY-MM-DD') as sj_date
          from erp_do_header o
         where o.so_no = ${row.so_no} and o.id <> ${row.subject_ref}
           and (o.deleted_at is not null or lower(coalesce(o.cancel_order, '')) = 'yes')
           and coalesce(o.deleted_at, o.erp_updated_at) >= ${new Date(deps.now().getTime() - 7 * 86_400_000 + 7 * 3_600_000)}
           and exists (select 1 from notify_ledger l where l.mode = ${lmode} and l.subject_ref = o.id
                        and l.recipient_role = 'customer' and l.milestone in ('delivery_scheduled', 'delivery_changed')
                        and l.status = any(${SENT}))
         order by coalesce(o.deleted_at, o.erp_updated_at) desc limit 1`;
      if (prev?.sj_date && ctx.delivery && prev.sj_date !== ctx.delivery.sjDate) {
        change = { from: prev.sj_date, to: ctx.delivery.sjDate, told: true };
      }
    } else if (m === "delivery_today") {
      const why = await morningNoticeBlocked(db, row, wibDate(deps.now()));
      if (why) return finish(deps, row, { status: "cancelled", cancel_reason: why });
    } else {
      // A staff mark is sent only while it is the DO's latest; an XTable
      // departure is a fact about the truck, never replaced by a mark.
      if (!xtable && (!markId || ds?.last_mark_id !== markId)) {
        return finish(deps, row, { status: "cancelled", cancel_reason: "superseded" });
      }
      const today = wibDate(deps.now());
      if (m === "delivery_departed" && row.meta["marked_on"] !== today) {
        return finish(deps, row, { status: "cancelled", cancel_reason: "stale_departure" });
      }
      const to = (row.meta["to"] as string | null) ?? null;
      if (m === "delivery_changed" && to !== null && to < today) {
        return finish(deps, row, { status: "cancelled", cancel_reason: "stale_change" });
      }
      // Has the customer been given a date for this DO? If not, the pending
      // step-3 message is dropped and this one gives the full details.
      const [told] = await db<{ n: number }[]>`
        select count(*)::int as n from notify_ledger
         where mode = ${lmode} and subject_ref = ${row.subject_ref} and recipient_role = 'customer'
           and milestone in ('delivery_scheduled', 'delivery_changed') and status = any(${SENT}) and id <> ${row.id}
      `;
      const wasTold = (told?.n ?? 0) > 0;
      if (!wasTold) {
        await db`
          update notify_ledger set status = 'cancelled', cancel_reason = 'superseded', leased_until = null,
                 meta = meta || ${db.json({ supersededBy: row.id })}
           where mode = ${lmode} and subject_ref = ${row.subject_ref} and milestone = 'delivery_scheduled'
             and status in ('pending', 'held')
        `;
      }
      if (m === "delivery_changed") change = { from: (row.meta["from"] as string | null) ?? null, to, told: wasTold };
    }
  }

  // 2. Step 3 never goes before the SO's confirmation (PRD §21.1): while a
  // confirmation for this SO is still waiting, step 3 waits until 60 s after it.
  if (m === "delivery_scheduled") {
    const [conf] = await db<{ due_at: Date | null }[]>`
      select due_at from notify_ledger
       where mode = ${lmode} and so_no = ${row.so_no} and milestone = 'so_received'
         and recipient_role = 'customer' and status in ('pending', 'sending') and id <> ${row.id}
       order by due_at limit 1
    `;
    if (conf) {
      const at = Math.max(deps.now().getTime() + 60_000, (conf.due_at?.getTime() ?? 0) + 60_000);
      return defer(deps, row, new Date(at), "awaiting_confirmation");
    }
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
    // An admin who reviewed a held shared number and released it (WP-6) has decided.
    const shared = row.meta["released"] !== true && (await customersOnNumber(db, phone)) >= deps.sharedNumberCustomers;
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
  const departure =
    m === "delivery_departed"
      ? { vehicle: (row.meta["no_kendaraan"] as string | null) ?? null, driver: (row.meta["driver"] as string | null) ?? null }
      : undefined;
  const text = renderCustomerMessage(m, ctx, { change, departure, introduce: Boolean(phone) && !contact?.first_contacted_at });
  const meta = { recipientSource: recipient.source, verdict: verdict.reason ?? "ok" };

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

// ── 08:00 "dikirim hari ini" (PRD §21.3 interim) ────────────────────────────

/**
 * While the warehouse habit of filling the vehicle / driver takes hold: once
 * per WIB day at `morning_notice_hour`, every delivery due today that has not
 * departed is told "dijadwalkan dikirim hari ini". It never claims the truck
 * has left. Re-checked at send time (morningNoticeBlocked).
 */
export async function planMorningNotices(deps: DispatchDeps): Promise<number> {
  const { db, mode } = deps;
  if (mode === "off" || !deps.reminders) return 0;
  const now = deps.now();
  const today = wibDate(now);
  const [s] = await db<{ on: boolean; hour: number }[]>`
    select depart_morning_notice as on, morning_notice_hour as hour from notify_settings where id = 1`;
  if (!s?.on || wibHour(now) < s.hour) return 0;
  const claimed = await db`
    update notify_settings set morning_noticed_on = ${today}::date
     where id = 1 and morning_noticed_on is distinct from ${today}::date
    returning id`;
  if (!claimed.length) return 0;
  const dos = await db<{ do_id: string; so_no: string }[]>`
    select d.id as do_id, d.so_no
      from erp_do_header d
      left join notify_dispatch s on s.do_id = d.id
     where d.deleted_at is null and lower(coalesce(d.cancel_order, '')) <> 'yes'
       and coalesce(d.cara_kirim, '') !~* 'ambil' and d.so_no is not null
       and (case when s.do_id is null then d.sj_date when s.tbd then null else s.sched_date end) = ${today}::date
       and s.departed_on is null
       and coalesce(nullif(trim(d.no_kendaraan), ''), nullif(trim(d.driver), '')) is null and d.delivery_date is null
  `;
  if (!dos.length) return 0;
  const lmode = ledgerMode(mode);
  const rows = dos.map((d: { do_id: string; so_no: string }) => ({
    mode: lmode,
    milestone: "delivery_today",
    so_no: d.so_no,
    recipient_role: "customer",
    status: "pending",
    idempotency_key: outboxKey(mode, "delivery_today", `${d.do_id}:${today}`, "customer"),
    subject_ref: d.do_id,
    due_at: now,
    channel: deps.channel.mode,
    context_source: "erp",
    meta: db.json({ date: today }),
  }));
  await db`
    insert into notify_ledger ${db(rows, "mode", "milestone", "so_no", "recipient_role", "status", "idempotency_key",
      "subject_ref", "due_at", "channel", "context_source", "meta")}
    on conflict (idempotency_key) do nothing
  `;
  return rows.length;
}

/** Why a morning notice must not go out any more, or null. */
async function morningNoticeBlocked(db: AnySql, row: LedgerRow, today: string): Promise<string | null> {
  if (row.meta["date"] !== today) return "stale_event";
  const [d] = await db<{ eff: string | null; departed: boolean; held: boolean; told_departed: boolean }[]>`
    select to_char(case when s.do_id is null then h.sj_date when s.tbd then null else s.sched_date end, 'YYYY-MM-DD') as eff,
           (s.departed_on is not null or coalesce(nullif(trim(h.no_kendaraan), ''), nullif(trim(h.driver), '')) is not null
             or h.delivery_date is not null) as departed,
           exists (select 1 from notify_do_holds o where o.do_id = h.id and o.resolved_at is null) as held,
           exists (select 1 from notify_ledger l where l.subject_ref = h.id and l.milestone = 'delivery_departed'
                    and l.status not in ('cancelled', 'skipped')) as told_departed
      from erp_do_header h left join notify_dispatch s on s.do_id = h.id
     where h.id = ${row.subject_ref}
  `;
  if (!d) return "do_cancelled";
  if (d.departed || d.told_departed) return "already_departed";
  if (d.held) return "reschedule_hold";
  if (d.eff !== today) return "date_moved";
  return null;
}

// ── Reschedule requests nobody answered (PRD §21.5) ─────────────────────────

/**
 * At 16:00 WIB the day before the DO's current date (or at once if the
 * request came in later than that), the rep and Sales Admin are reminded of
 * an open reschedule request. Once per hold. The hold stays on.
 */
export async function planHoldReminders(deps: DispatchDeps): Promise<number> {
  const { db, mode } = deps;
  if (mode === "off" || !deps.reminders) return 0;
  const now = deps.now();
  const holds = await db<{ id: string; do_id: string; so_no: string | null; no_sj: string | null; eff: string | null; requested: string | null }[]>`
    select o.id::text, o.do_id, coalesce(o.so_no, d.so_no) as so_no, d.no_sj,
           to_char(case when s.do_id is null then d.sj_date when s.tbd then null else s.sched_date end, 'YYYY-MM-DD') as eff,
           to_char(o.requested_date, 'YYYY-MM-DD') as requested
      from notify_do_holds o
      join erp_do_header d on d.id = o.do_id
      left join notify_dispatch s on s.do_id = d.id
     where o.resolved_at is null and o.reminded_at is null`;
  const [st] = await db<{ admin: string | null }[]>`select sales_admin_number as admin from notify_settings where id = 1`;
  const lmode = ledgerMode(mode);
  let n = 0;
  for (const h of holds) {
    // 16:00 WIB on the day before = 09:00 UTC that day.
    const due = h.eff ? new Date(`${h.eff}T09:00:00Z`).getTime() - 86_400_000 : now.getTime();
    if (now.getTime() < due) continue;
    const header = h.so_no ? await loadHeader(db, h.so_no) : null;
    const rep = header ? await loadRep(db, header) : null;
    const to = [...new Set([rep?.phone, st?.admin].filter((x): x is string => Boolean(x)))];
    const body = renderHoldReminder(header?.customer_name_text ?? "Pelanggan", h.no_sj ?? h.do_id, h.eff, h.requested, mode === "shadow");
    const rows = to.map((phone) => ({
      mode: lmode,
      milestone: HOLD_REMINDER,
      so_no: h.so_no,
      recipient_role: "sales_cc",
      to_number: phone,
      body,
      status: "pending",
      idempotency_key: outboxKey(mode, HOLD_REMINDER, `${h.id}:${phone}`, "sales_cc"),
      subject_ref: h.do_id,
      due_at: now,
      channel: deps.channel.mode,
      context_source: "erp",
      meta: db.json({ hold_id: h.id }),
    }));
    if (rows.length) {
      await db`
        insert into notify_ledger ${db(rows, "mode", "milestone", "so_no", "recipient_role", "to_number", "body", "status",
          "idempotency_key", "subject_ref", "due_at", "channel", "context_source", "meta")}
        on conflict (idempotency_key) do nothing`;
    }
    await db`update notify_do_holds set reminded_at = ${now} where id = ${h.id}`;
    n += rows.length;
  }
  return n;
}

async function processHoldReminder(deps: DispatchDeps, row: LedgerRow): Promise<void> {
  const [h] = await deps.db<{ open: boolean }[]>`
    select resolved_at is null as open from notify_do_holds where id = ${String(row.meta["hold_id"] ?? "0")}`;
  if (!h?.open) return finish(deps, row, { status: "cancelled", cancel_reason: "hold_resolved" });
  if (!row.to_number || !row.body) return finish(deps, row, { status: "cancelled", cancel_reason: "unreachable" });
  const wait = nextSendWindow(deps.now(), deps.fromHour, deps.untilHour);
  if (wait) return defer(deps, row, wait, "quiet_hours");
  await send(deps, row, row.to_number, row.body);
}

// ── Afternoon reminder of unmarked deliveries (PRD §20) ─────────────────────

/**
 * Once per WIB day, at `dispatch_remind_hour`: today's deliveries nobody has
 * marked Berangkat or Ditunda go to each one's rep, and the full list to the
 * logistics numbers set in Konfigurasi. The customer is never messaged on the
 * strength of a missing mark.
 */
export async function planReminders(deps: DispatchDeps): Promise<number> {
  const { db, mode } = deps;
  if (mode === "off" || !deps.reminders) return 0;
  const now = deps.now();
  const today = wibDate(now);
  const [s] = await db<{ hour: number; numbers: string[]; admin: string | null; warehouse: string | null }[]>`
    select dispatch_remind_hour as hour, dispatch_remind_numbers as numbers,
           sales_admin_number as admin, warehouse_number as warehouse
      from notify_settings where id = 1`;
  if (!s || s.hour < 0 || s.hour > 23 || wibHour(now) < s.hour) return 0;
  const claimed = await db`
    update notify_settings set dispatch_reminded_on = ${today}::date
     where id = 1 and dispatch_reminded_on is distinct from ${today}::date
    returning id
  `;
  if (!claimed.length) return 0; // already done today (or by another replica)

  const rows = await unmarkedToday(db, today);
  if (!rows.length) return 0;
  const byPhone = new Map<string, UnmarkedRow[]>();
  const add = (phone: string, list: UnmarkedRow[]) => {
    const cur = byPhone.get(phone) ?? [];
    for (const r of list) if (!cur.includes(r)) cur.push(r);
    byPhone.set(phone, cur);
  };
  // PRD §21.3: Sales Admin and the warehouse contact, plus any extra numbers.
  for (const n of [s.admin, s.warehouse, ...(s.numbers ?? [])]) if (n) add(n, rows);
  if (!byPhone.size) return 0;
  const lmode = ledgerMode(mode);
  const planned = [...byPhone.entries()].map(([phone, list]) => ({
    mode: lmode,
    milestone: DISPATCH_REMINDER,
    so_no: null,
    recipient_role: "sales_cc",
    to_number: phone,
    body: renderDispatchReminder(
      today,
      list.map((r) => ({ sjNo: r.no_sj ?? r.do_id, soNo: r.so_no, customer: r.customer ?? "-" })),
      mode === "shadow",
    ),
    status: "pending",
    idempotency_key: outboxKey(mode, DISPATCH_REMINDER, `${today}:${phone}`, "sales_cc"),
    due_at: now,
    channel: deps.channel.mode,
    context_source: "erp",
    meta: db.json({ date: today, count: list.length }),
  }));
  await db`
    insert into notify_ledger ${db(planned, "mode", "milestone", "so_no", "recipient_role", "to_number", "body", "status",
      "idempotency_key", "due_at", "channel", "context_source", "meta")}
    on conflict (idempotency_key) do nothing
  `;
  return planned.length;
}

async function processReminder(deps: DispatchDeps, row: LedgerRow): Promise<void> {
  if (row.meta["date"] !== wibDate(deps.now())) return finish(deps, row, { status: "cancelled", cancel_reason: "stale_event" });
  if (!row.to_number || !row.body) return finish(deps, row, { status: "cancelled", cancel_reason: "unreachable" });
  const wait = nextSendWindow(deps.now(), deps.fromHour, deps.untilHour);
  if (wait) return defer(deps, row, wait, "quiet_hours");
  await send(deps, row, row.to_number, row.body);
}

async function processRow(deps: DispatchDeps, row: LedgerRow): Promise<void> {
  try {
    // An earlier row in this same batch may have settled this one (a step-3
    // message merging step 1 cancels it). Only a row still ours is processed.
    const [cur] = await deps.db<{ status: string }[]>`select status from notify_ledger where id = ${row.id}`;
    if (cur?.status !== "sending") return;
    if (row.milestone === DO_CANCELLED_NOTICE) return await processNotice(deps, row);
    if (row.milestone === DISPATCH_REMINDER) return await processReminder(deps, row);
    if (row.milestone === HOLD_REMINDER) return await processHoldReminder(deps, row);
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
  const planned =
    (await planEvents(deps)) + (await planMorningNotices(deps)) + (await planReminders(deps)) + (await planHoldReminders(deps));
  const [ks] = await deps.db<{ kill_switch: boolean }[]>`select kill_switch from notify_settings where id = 1`;
  const paused = ks?.kill_switch ? "kill_switch" : await deps.pauseReason(deps.db, deps.channel);
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
    reminders: over.reminders ?? true,
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
