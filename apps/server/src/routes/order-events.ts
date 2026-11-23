/**
 * Kabar Pesanan WP-3 — read-only views of the order backbone.
 *
 * GET /api/orders/events?so_no=&type=&limit=   the event log, newest first
 * GET /api/orders/sync-status                  order-lane cursors/errors + event counts
 *
 * Payloads carry no phone numbers (derive.ts), so these are safe to expose to
 * the same audience as /notify's Riwayat.
 */
import type { FastifyInstance } from "fastify";
import { getSql } from "../db/client.js";
import { isOrderLaneEnabled, orderLaneStatus } from "../erp/orderSync.js";
import { config } from "../config.js";

// so.created / production.requested stay queryable as history (before 2026-11-23).
const TYPES = new Set([
  "so.confirmed", "do.created", "do.cancelled", "do.rescheduled", "do.departed", "so.late",
  "so.created", "production.requested",
]);

export async function orderEventRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/orders/events", async (req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const q = req.query as { so_no?: string; type?: string; limit?: string };
    const soNo = typeof q.so_no === "string" && q.so_no.trim() ? q.so_no.trim() : null;
    const type = typeof q.type === "string" && TYPES.has(q.type) ? q.type : null;
    if (q.type && !type) return reply.code(400).send({ error: `type harus salah satu dari: ${[...TYPES].join(", ")}.` });
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const rows = await db`
      select id::text, event_key, event_type, so_no, subject_ref, occurred_at, detected_at, payload, source
        from order_events
       where (${soNo}::text is null or so_no = ${soNo})
         and (${type}::text is null or event_type = ${type})
       order by id desc
       limit ${limit}
    `;
    return { rows };
  });

  /**
   * GET /api/orders/do-timing — aggregate DO timing, to judge which ERP signal
   * marks "barang dikirimkan" and how often schedules move. Counts only: no
   * customer, phone or SO numbers. Admin token required.
   *
   * Mirror timestamps hold WIB wall-clock digits stored as UTC (A18), so
   * `x at time zone 'UTC'` reads back the WIB wall clock.
   */
  app.get("/api/orders/do-timing", async (req, reply) => {
    const required = config.notify.adminToken;
    if (required && req.headers["x-notify-token"] !== required) return reply.code(401).send({ error: "unauthorized" });
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const live = db`deleted_at is null and lower(coalesce(cancel_order, '')) <> 'yes'`;
    const today = db`(now() at time zone 'Asia/Jakarta')::date`;
    const [range] = await db`
      select count(*)::int as dos, min(sj_date)::text as first_sj, max(sj_date)::text as last_sj,
             count(*) filter (where print_status is null)::int as no_print_status
        from erp_do_header where ${live}`;
    const byBucket = await db`
      select case when sj_date < ${today} - 1 then 'past (≥2 days ago)'
                  when sj_date = ${today} - 1 then 'yesterday'
                  when sj_date = ${today} then 'today'
                  else 'future' end as sj_bucket,
             coalesce(print_status, '(null)') as print_status, count(*)::int as n
        from erp_do_header where ${live} and sj_date is not null
       group by 1, 2 order by 1, 2`;
    // When was a PRINTED DO last touched, relative to its scheduled day (WIB)?
    const printedWhen = await db`
      select ((erp_updated_at at time zone 'UTC')::date - sj_date) as day_offset,
             extract(hour from erp_updated_at at time zone 'UTC')::int as hour_wib, count(*)::int as n
        from erp_do_header
       where ${live} and print_status = 'Printed' and erp_updated_at is not null and sj_date is not null
       group by 1, 2 order by 1, 2`;
    // Same for WAITING DOs (never printed): when last touched.
    const waitingWhen = await db`
      select ((erp_updated_at at time zone 'UTC')::date - sj_date) as day_offset, count(*)::int as n
        from erp_do_header
       where ${live} and coalesce(print_status, '') <> 'Printed' and erp_updated_at is not null and sj_date is not null
       group by 1 order by 1`;
    // How far ahead DOs are created.
    const createdAhead = await db`
      select (sj_date - (coalesce(do_created_at, erp_created_at) at time zone 'UTC')::date) as days_ahead, count(*)::int as n
        from erp_do_header where ${live} and sj_date is not null and coalesce(do_created_at, erp_created_at) is not null
       group by 1 order by 1`;
    // Schedule moves since the event log started: sj_date when first recorded vs now.
    const moves = await db`
      select (d.sj_date - (e.payload->>'sj_date')::date) as shift_days,
             ((d.erp_updated_at at time zone 'UTC')::date - (e.payload->>'sj_date')::date) as changed_day_vs_old_date,
             count(*)::int as n
        from order_events e
        join erp_do_header d on d.id = e.payload->>'do_id'
       where e.event_type = 'do.created' and e.payload->>'sj_date' is not null and d.sj_date is not null
         and d.sj_date <> (e.payload->>'sj_date')::date
       group by 1, 2 order by 1, 2`;
    const [tracked] = await db`
      select count(*)::int as n, min(detected_at)::text as since from order_events where event_type = 'do.created'`;
    // The SO line's estimate_delivery (the "dijadwalkan" date set at order entry)
    // against the first live DO's sj_date (the actual dispatch day).
    const etaVsDo = await db`
      with eta as (
        select po_no, min(estimate_delivery) as eta from erp_so_line
         where po_no is not null and estimate_delivery is not null group by po_no),
      firstdo as (
        select so_no, min(sj_date) as sj from erp_do_header where ${live} and sj_date is not null group by so_no)
      select greatest(least(f.sj - e.eta, 15), -15) as do_minus_eta_days, count(*)::int as n
        from eta e join firstdo f on f.so_no = e.po_no
       where f.sj >= date '2026-09-01'
       group by 1 order by 1`;
    // How far ahead of the order date the estimate is set.
    const etaLead = await db`
      with eta as (
        select po_no, min(estimate_delivery) as eta from erp_so_line
         where po_no is not null and estimate_delivery is not null group by po_no)
      select greatest(least(e.eta - h.po_date, 30), -5) as eta_minus_po_days, count(*)::int as n
        from eta e join erp_so_header h on h.po_no = e.po_no
       where h.po_date >= date '2026-09-01'
       group by 1 order by 1`;
    // Cancelled or deleted DOs, and whether the SO got another DO later.
    const cancelled = await db`
      select case when d.deleted_at is not null then 'deleted' else 'cancel_order=yes' end as kind,
             count(*)::int as n,
             count(*) filter (where exists (
               select 1 from erp_do_header x
                where x.so_no = d.so_no and x.id <> d.id and x.deleted_at is null
                  and lower(coalesce(x.cancel_order, '')) <> 'yes' and x.sj_date > d.sj_date))::int as redone_later
        from erp_do_header d
       where (d.deleted_at is not null or lower(coalesce(d.cancel_order, '')) = 'yes') and d.sj_date >= date '2026-09-01'
       group by 1`;
    // Open SOs past their estimate with no DO yet, by days overdue.
    const overdueNow = await db`
      with late as (
        select po_no, min(estimate_delivery) as eta from v_live_commitments
         where po_no is not null and estimate_delivery < ${today} group by po_no)
      select case when ${today} - eta <= 1 then '1' when ${today} - eta <= 3 then '2-3'
                  when ${today} - eta <= 7 then '4-7' when ${today} - eta <= 30 then '8-30' else '>30' end as days_overdue,
             count(*)::int as sos,
             count(*) filter (where exists (select 1 from erp_do_header x where x.so_no = late.po_no and x.deleted_at is null))::int as with_some_do
        from late group by 1 order by 1`;
    return {
      range, byBucket, printedWhen, waitingWhen, createdAhead, moves, movesTrackedOver: tracked,
      etaVsDo, etaLead, cancelled, overdueNow,
    };
  });

  app.get("/api/orders/sync-status", async (_req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const [lane, counts, state] = await Promise.all([
      orderLaneStatus(db),
      db<{ event_type: string; n: number; last_detected: Date | null }[]>`
        select event_type, count(*)::int as n, max(detected_at) as last_detected
          from order_events group by event_type order by event_type
      `,
      db<{ swept_until: Date | null; late_swept_at: Date | null }[]>`
        select swept_until, late_swept_at from order_event_state where id = 1
      `,
    ]);
    return { laneEnabled: isOrderLaneEnabled(), lane, events: counts, sweep: state[0] ?? null };
  });
}
