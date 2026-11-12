/**
 * Kabar Pesanan WP-3 — the order event log (PRD §5.1, §6).
 *
 * `order_events` is APPEND-ONLY. A row is a business fact derived from the ERP
 * mirror ("DO KP/DO-13224 created for SO.26/12821"), and `event_key` (event
 * type + natural key) is unique, so a re-sync, a replay, a webhook racing the
 * poll, or a second replica can never record the same fact twice.
 *
 * Consumers (notification rules, the customer timeline, the delay log) read
 * from here; none of them re-derive from the mirror.
 */
import type { Sql } from "./client.js";

export async function runEventMigrations(db: Sql): Promise<void> {
  await db`
    create table if not exists order_events (
      id          bigserial primary key,
      event_key   text not null unique,
      event_type  text not null,
      so_no       text,
      subject_ref text,                         -- no_sj / request id / eta, per type
      occurred_at timestamptz,                  -- ERP time (naive WIB stored as UTC, A18)
      detected_at timestamptz not null default now(),
      payload     jsonb not null default '{}'::jsonb,
      source      text not null default 'erp-mirror'
                  check (source in ('erp-mirror', 'erp-webhook', 'manual'))
    )
  `;
  await db`create index if not exists order_events_so_idx   on order_events (so_no, id)`;
  await db`create index if not exists order_events_type_idx on order_events (event_type, id)`;

  // Where the catch-up sweep has read up to (mirror `synced_at`), and when the
  // time-based so.late sweep last ran. Single row.
  await db`
    create table if not exists order_event_state (
      id            int primary key default 1 check (id = 1),
      swept_until   timestamptz,
      late_swept_at timestamptz
    )
  `;
  await db`insert into order_event_state (id) values (1) on conflict (id) do nothing`;
}
