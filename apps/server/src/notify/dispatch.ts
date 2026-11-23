/**
 * Kabar Pesanan — the Pengiriman tab: schedule changes (PRD §20, §21.3, §21.5).
 *
 * "Sedang dikirim" comes from XTable since 2026-11-23: the warehouse fills the
 * vehicle / driver on the DO as the truck leaves (events/derive.ts,
 * do.departed). The staff "Berangkat" button of §20 is gone; departures it
 * recorded before then stay as history (`departed_on`, marks with action
 * 'departed'). What staff still mark here is a change of date:
 *
 *   Tunda                 → do.rescheduled → delivery_changed ("tertunda", new date or TBD)
 *   Selaras edits sj_date → do.rescheduled (source selaras), same message
 *
 * `notify_dispatch` holds the current state per DO (the date the customer was
 * last given, departed or not); `notify_dispatch_marks` is the history, and
 * each mark stores the state before it so the latest one can be undone while
 * its message has not gone out yet.
 */
import type { Sql } from "../db/client.js";
import { insertEvents } from "../events/store.js";
import { wibDate } from "./rules.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySql = Sql | any;

const SENT = ["sent", "queued", "stubbed"];

/** The truck has left according to XTable (PRD §21.3), on an erp_do_header row. */
export const DEPARTED_SQL =
  "coalesce(nullif(trim(no_kendaraan), ''), nullif(trim(driver), '')) is not null or delivery_date is not null";
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export class DispatchError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export interface DispatchState {
  do_id: string;
  so_no: string | null;
  sched_date: string | null;
  tbd: boolean;
  departed_on: string | null;
  erp_seen_date: string | null;
  last_mark_id: string | null;
  updated_by: string | null;
}

export interface MarkInput {
  doId: string;
  action: "rescheduled";
  /** rescheduled: the new date, or null when it is not known yet (staff only). */
  toDate?: string | null;
  source: "staff" | "selaras";
  by: string | null;
  now: Date;
  /** selaras only: the sj_date the customer was originally given (do.created payload). */
  baseline?: string | null;
}

export interface MarkResult {
  doId: string;
  markId: string | null;
  /** True when the mark produced an event (and so, in shadow/live mode, a message). */
  notify: boolean;
  /** Why nothing was recorded or no message follows. */
  note: string | null;
}

const STATE_COLS = `do_id, so_no, to_char(sched_date, 'YYYY-MM-DD') as sched_date, tbd,
  to_char(departed_on, 'YYYY-MM-DD') as departed_on, to_char(erp_seen_date, 'YYYY-MM-DD') as erp_seen_date,
  last_mark_id::text as last_mark_id, updated_by`;

/**
 * Record one mark. Runs in its own transaction with the DO's state row locked,
 * so two people clicking at once (or a click racing the Selaras sweep) cannot
 * both record a departure.
 */
export async function markDispatch(db: AnySql, input: MarkInput): Promise<MarkResult> {
  const { doId, action, source, now } = input;
  const today = wibDate(now);
  // "Berangkat" was a staff mark until 2026-11-23; departure now comes from XTable (§21.3).
  if (action !== "rescheduled") throw new DispatchError("Tanda Berangkat sudah tidak dipakai: isi No. kendaraan / sopir di XTable.");
  if (input.toDate != null && !ISO.test(input.toDate)) {
    throw new DispatchError("Tanggal baru harus berformat YYYY-MM-DD.");
  }
  return db.begin(async (tx: AnySql) => {
    const [d] = await tx<{ id: string; so_no: string | null; no_sj: string | null; sj_date: string | null; live: boolean; left: boolean }[]>`
      select id, so_no, no_sj, to_char(sj_date, 'YYYY-MM-DD') as sj_date,
             (deleted_at is null and lower(coalesce(cancel_order, '')) <> 'yes') as live,
             (${tx.unsafe(DEPARTED_SQL)}) as left
        from erp_do_header where id = ${doId}
    `;
    if (!d) throw new DispatchError("Surat jalan tidak ditemukan.", 404);
    if (!d.live) throw new DispatchError(`${d.no_sj ?? doId} sudah dibatalkan atau dihapus di Selaras.`, 409);

    const baseline = source === "selaras" ? (input.baseline ?? input.toDate ?? d.sj_date) : d.sj_date;
    const inserted = await tx`
      insert into notify_dispatch (do_id, so_no, sched_date, erp_seen_date)
      values (${doId}, ${d.so_no}, ${baseline}, ${source === "selaras" ? baseline : d.sj_date})
      on conflict (do_id) do nothing
      returning do_id
    `;
    const [st] = (await tx.unsafe(`select ${STATE_COLS} from notify_dispatch where do_id = $1 for update`, [doId])) as DispatchState[];
    if (!st) throw new DispatchError("Status surat jalan tidak terbaca.", 500);
    // The state before this mark, for undo: none when this mark created the row.
    const prev = inserted.length ? null : st;

    let from: string | null = st.tbd ? null : st.sched_date;
    let to: string | null = null;
    let tbd = false;
    let notify = true;
    let note: string | null = null;

    {
      if (st.departed_on || d.left) {
        if (source === "selaras") {
          await tx`update notify_dispatch set erp_seen_date = ${input.toDate ?? null} where do_id = ${doId}`;
          return { doId, markId: null, notify: false, note: "already departed" };
        }
        throw new DispatchError(`${d.no_sj ?? doId} sudah berangkat; jadwalnya tidak bisa diubah lagi.`, 409);
      }
      to = input.toDate ?? null;
      if (to === null && source === "selaras") throw new DispatchError("Selaras edit without a date.", 500);
      if (source === "staff" && to !== null && to < today) throw new DispatchError("Tanggal baru tidak boleh sebelum hari ini.");
      tbd = to === null;
      if (source === "selaras") {
        await tx`update notify_dispatch set erp_seen_date = ${to} where do_id = ${doId}`;
      }
      if ((!st.tbd && to !== null && to === st.sched_date) || (st.tbd && tbd)) {
        if (source === "selaras") return { doId, markId: null, notify: false, note: "same date" };
        throw new DispatchError(tbd ? "Sudah ditandai tertunda tanpa tanggal." : `Jadwalnya sudah ${to}.`);
      }
      await tx`
        update notify_dispatch set sched_date = ${to ?? st.sched_date}, tbd = ${tbd},
               updated_by = ${input.by}, updated_at = now()
         where do_id = ${doId}
      `;
      from = st.tbd ? null : st.sched_date;
    }

    const [mark] = await tx<{ id: string }[]>`
      insert into notify_dispatch_marks (do_id, so_no, action, from_date, to_date, tbd, source, marked_by, prev)
      values (${doId}, ${d.so_no}, ${action}, ${from}, ${to}, ${tbd}, ${source}, ${input.by},
              ${prev ? tx.json(prev) : null})
      returning id::text
    `;
    const markId = mark!.id;
    // PRD §21.5: a new date for the DO answers an open reschedule request.
    await tx`
      update notify_do_holds set resolved_at = now(), resolved_by = ${input.by},
             resolution = ${source === "selaras" ? "sj_date_changed" : "tunda"}
       where do_id = ${doId} and resolved_at is null`;
    let eventId: string | null = null;
    if (notify && d.so_no) {
      const type = "do.rescheduled";
      const [ev] = await insertEvents(
        tx,
        [
          {
            event_key: `${type}:${markId}`,
            event_type: type,
            so_no: d.so_no,
            subject_ref: d.no_sj ?? doId,
            // Same clock convention as mirror rows (WIB digits stored as UTC).
            occurred_at: new Date(now.getTime() + 7 * 3_600_000),
            payload: { do_id: doId, mark_id: markId, no_sj: d.no_sj, from, to, tbd, marked_on: today, source, by: input.by },
          },
        ],
        "manual",
      );
      eventId = ev?.id ?? null;
    }
    await tx`update notify_dispatch_marks set event_id = ${eventId} where id = ${markId}`;
    await tx`update notify_dispatch set last_mark_id = ${markId} where do_id = ${doId}`;
    return { doId, markId, notify: notify && Boolean(eventId), note };
  });
}

/**
 * Undo the latest staff mark on a DO, if its customer message has not gone
 * out (or started going out). Pending messages for it are cancelled.
 */
export async function undoDispatch(db: AnySql, doId: string, by: string | null): Promise<{ restored: DispatchState | null }> {
  return db.begin(async (tx: AnySql) => {
    const [st] = await tx<{ last_mark_id: string | null }[]>`
      select last_mark_id::text from notify_dispatch where do_id = ${doId} for update`;
    if (!st?.last_mark_id) throw new DispatchError("Belum ada tanda untuk dibatalkan.", 404);
    const [m] = await tx<{ id: string; source: string; event_id: string | null; prev: Record<string, unknown> | null }[]>`
      select id::text, source, event_id::text, prev from notify_dispatch_marks where id = ${st.last_mark_id}`;
    if (!m) throw new DispatchError("Tanda tidak ditemukan.", 404);
    if (m.source !== "staff") throw new DispatchError("Perubahan jadwal dari Selaras tidak bisa dibatalkan di sini.", 409);
    if (m.event_id) {
      const rows = await tx<{ status: string }[]>`
        select status from notify_ledger where event_id = ${m.event_id} and recipient_role = 'customer'`;
      if (rows.some((r: { status: string }) => SENT.includes(r.status) || r.status === "sending")) {
        throw new DispatchError("Pesannya sudah terkirim ke pelanggan, jadi tanda ini tidak bisa dibatalkan.", 409);
      }
      await tx`
        update notify_ledger set status = 'cancelled', cancel_reason = 'undone', leased_until = null
         where event_id = ${m.event_id} and status in ('pending', 'held')
      `;
    }
    await tx`update notify_dispatch_marks set undone_at = now(), undone_by = ${by} where id = ${m.id}`;
    if (!m.prev) {
      await tx`delete from notify_dispatch where do_id = ${doId}`;
      return { restored: null };
    }
    const p = m.prev as Record<string, any>;
    await tx`
      update notify_dispatch set
        sched_date = ${p.sched_date ?? null}, tbd = ${Boolean(p.tbd)}, departed_on = ${p.departed_on ?? null},
        erp_seen_date = ${p.erp_seen_date ?? null}, last_mark_id = ${p.last_mark_id ?? null},
        updated_by = ${by}, updated_at = now()
       where do_id = ${doId}
    `;
    const [r] = await tx.unsafe(`select ${STATE_COLS} from notify_dispatch where do_id = $1`, [doId]);
    return { restored: (r as DispatchState) ?? null };
  });
}

/**
 * Selaras edits to a DO's sj_date (never seen so far, but supported): compare
 * the mirror with the last date seen (first: the do.created payload) and turn
 * a change into a `rescheduled` mark from source `selaras`. A Selaras date
 * equal to what staff already told the customer changes nothing.
 */
export async function sweepErpReschedules(db: AnySql, now: Date): Promise<number> {
  const today = wibDate(now);
  // A cancelled or deleted DO closes its reschedule request (PRD §21.5).
  await db`
    update notify_do_holds o set resolved_at = now(), resolved_by = 'Selaras', resolution = 'do_cancelled'
      from erp_do_header d
     where o.do_id = d.id and o.resolved_at is null
       and (d.deleted_at is not null or lower(coalesce(d.cancel_order, '')) = 'yes')`;
  const rows = await db<{ id: string; sj: string; seen: string | null }[]>`
    select d.id, to_char(d.sj_date, 'YYYY-MM-DD') as sj,
           to_char(coalesce(s.erp_seen_date, (e.payload->>'sj_date')::date), 'YYYY-MM-DD') as seen
      from erp_do_header d
      join order_events e on e.event_type = 'do.created' and e.payload->>'do_id' = d.id
      left join notify_dispatch s on s.do_id = d.id
     where d.deleted_at is null and lower(coalesce(d.cancel_order, '')) <> 'yes'
       and d.sj_date is not null and d.sj_date >= ${today}::date - 1
       and s.departed_on is null
       and coalesce(s.erp_seen_date, (e.payload->>'sj_date')::date) is distinct from d.sj_date
  `;
  let marked = 0;
  for (const r of rows) {
    try {
      const res = await markDispatch(db, {
        doId: r.id,
        action: "rescheduled",
        toDate: r.sj,
        source: "selaras",
        by: "Selaras",
        now,
        baseline: r.seen ?? r.sj,
      });
      if (res.markId) marked += 1;
    } catch (err) {
      if (!(err instanceof DispatchError)) throw err;
    }
  }
  return marked;
}

// ── The Pengiriman list ──────────────────────────────────────────────────────

export interface DispatchRow {
  do_id: string;
  no_sj: string | null;
  so_no: string | null;
  customer: string | null;
  address: string | null;
  sales: string | null;
  sj_date: string | null;
  eff_date: string | null;
  tbd: boolean;
  departed_on: string | null;
  vehicle: string | null;
  driver: string | null;
  dep_status: string | null;
  dep_reason: string | null;
  /** An open customer request to move this delivery (PRD §21.5). */
  hold_id: string | null;
  hold_requested: string | null;
  section: "today" | "overdue" | "tbd" | "upcoming";
  last_action: string | null;
  last_source: string | null;
  last_to: string | null;
  last_by: string | null;
  last_at: Date | null;
  last_has_event: boolean | null;
  msg_status: string | null;
  msg_reason: string | null;
  told_status: string | null;
}

/**
 * Deliveries for `date` (WIB): due that day, unmarked from the 3 days before,
 * delayed without a date, and the next day (so a delay known the evening
 * before can be marked ahead). Pickups are not listed.
 */
export async function listDispatch(db: AnySql, date: string): Promise<DispatchRow[]> {
  return db<DispatchRow[]>`
    with eff as (
      select d.id as do_id, d.no_sj, d.so_no, d.sj_date,
             coalesce(s.tbd, false) as tbd,
             case when s.do_id is null then d.sj_date when s.tbd then null else s.sched_date end as eff_date,
             -- XTable departure (§21.3): the WIB day the fields were seen (mirror stamps are WIB digits).
             coalesce(s.departed_on,
                      case when coalesce(nullif(trim(d.no_kendaraan), ''), nullif(trim(d.driver), '')) is not null
                                or d.delivery_date is not null
                           then coalesce(dep.seen_on, (d.erp_updated_at at time zone 'UTC')::date) end) as departed_on,
             nullif(trim(d.no_kendaraan), '') as vehicle, nullif(trim(d.driver), '') as driver,
             s.last_mark_id
        from erp_do_header d
        left join lateral (
          select (e.payload->>'marked_on')::date as seen_on from order_events e
           where e.event_key = 'do.departed:' || d.id) dep on true
        left join notify_dispatch s on s.do_id = d.id
       where d.deleted_at is null and lower(coalesce(d.cancel_order, '')) <> 'yes'
         and coalesce(d.cara_kirim, '') !~* 'ambil'
         and (d.sj_date between ${date}::date - 30 and ${date}::date + 30 or s.do_id is not null)
    ), sec as (
      select eff.*,
             case when eff_date = ${date}::date or departed_on = ${date}::date then 'today'
                  when tbd and departed_on is null then 'tbd'
                  when eff_date between ${date}::date - 3 and ${date}::date - 1 and departed_on is null then 'overdue'
                  when eff_date = ${date}::date + 1 and departed_on is null then 'upcoming'
             end as section
        from eff
    )
    select sec.do_id, sec.no_sj, sec.so_no, h.customer_name_text as customer, h.alamat_kirim as address,
           h.sales_name_text as sales, to_char(sec.sj_date, 'YYYY-MM-DD') as sj_date,
           to_char(sec.eff_date, 'YYYY-MM-DD') as eff_date, sec.tbd,
           to_char(sec.departed_on, 'YYYY-MM-DD') as departed_on, sec.vehicle, sec.driver, sec.section,
           dmsg.status as dep_status, dmsg.cancel_reason as dep_reason,
           m.action as last_action, m.source as last_source, to_char(m.to_date, 'YYYY-MM-DD') as last_to,
           m.marked_by as last_by, m.marked_at as last_at, (m.event_id is not null) as last_has_event,
           msg.status as msg_status, msg.cancel_reason as msg_reason, told.status as told_status,
           hold.id as hold_id, to_char(hold.requested_date, 'YYYY-MM-DD') as hold_requested
      from sec
      left join lateral (
        select customer_name_text, alamat_kirim, sales_name_text from erp_so_header
         where po_no = sec.so_no order by erp_updated_at desc nulls last limit 1) h on true
      left join notify_dispatch_marks m on m.id = sec.last_mark_id
      left join lateral (
        select status, cancel_reason from notify_ledger
         where m.event_id is not null and event_id = m.event_id and recipient_role = 'customer'
         order by id desc limit 1) msg on true
      left join lateral (
        select status from notify_ledger
         where subject_ref = sec.do_id and milestone = 'delivery_scheduled' and recipient_role = 'customer'
           and mode in ('live', 'shadow')
         order by id desc limit 1) told on true
      left join lateral (
        select status, cancel_reason from notify_ledger
         where subject_ref = sec.do_id and milestone = 'delivery_departed' and recipient_role = 'customer'
           and mode in ('live', 'shadow')
         order by id desc limit 1) dmsg on true
      left join lateral (
        select id::text, requested_date from notify_do_holds where do_id = sec.do_id and resolved_at is null limit 1) hold on true
     where sec.section is not null
     order by case sec.section when 'today' then 0 when 'overdue' then 1 when 'tbd' then 2 else 3 end,
              sec.departed_on is not null, h.customer_name_text, sec.no_sj
  `;
}

/** Today's deliveries with no departure in XTable and no Tunda: what the 13:00 reminder lists. */
export interface UnmarkedRow {
  do_id: string;
  no_sj: string | null;
  so_no: string;
  customer: string | null;
  sales_name_id: string | null;
  sales_name_text: string | null;
}

export async function unmarkedToday(db: AnySql, today: string): Promise<UnmarkedRow[]> {
  return db<UnmarkedRow[]>`
    select d.id as do_id, d.no_sj, d.so_no, h.customer_name_text as customer, h.sales_name_id, h.sales_name_text
      from erp_do_header d
      left join notify_dispatch s on s.do_id = d.id
      left join lateral (
        select customer_name_text, sales_name_id, sales_name_text from erp_so_header
         where po_no = d.so_no order by erp_updated_at desc nulls last limit 1) h on true
     where d.deleted_at is null and lower(coalesce(d.cancel_order, '')) <> 'yes'
       and coalesce(d.cara_kirim, '') !~* 'ambil' and d.so_no is not null
       and (case when s.do_id is null then d.sj_date when s.tbd then null else s.sched_date end) = ${today}::date
       and s.departed_on is null
       and coalesce(nullif(trim(d.no_kendaraan), ''), nullif(trim(d.driver), '')) is null and d.delivery_date is null
     order by h.customer_name_text, d.no_sj
  `;
}

// ── Reschedule holds (PRD §21.5) ─────────────────────────────────────────────

/** "Tetap sesuai jadwal": the rep declined the request; nothing is sent, the hold closes. */
export async function keepSchedule(db: AnySql, holdId: string, by: string | null): Promise<void> {
  const rows = await db`
    update notify_do_holds set resolved_at = now(), resolved_by = ${by}, resolution = 'kept'
     where id = ${holdId} and resolved_at is null returning id`;
  if (!rows.length) throw new DispatchError("Permintaan ini sudah ditutup.", 409);
}
