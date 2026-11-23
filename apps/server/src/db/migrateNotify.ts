/**
 * Kabar Pesanan tables. Additive, idempotent, safe on every boot.
 *
 *  notify_settings — single row: the system WhatsApp number shown as sender.
 *  notify_ledger   — every message the system produced, test or live, with the
 *                    channel's verdict. The idempotency key is what makes a
 *                    re-run of the live deriver unable to send twice (NTF-R40).
 */
import type { Sql } from "./client.js";

export async function runNotifyMigrations(db: Sql): Promise<void> {
  await db`
    create table if not exists notify_settings (
      id             int primary key default 1 check (id = 1),
      system_number  text,
      updated_at     timestamptz not null default now()
    )
  `;
  await db`insert into notify_settings (id) values (1) on conflict (id) do nothing`;

  await db`
    create table if not exists notify_ledger (
      id                   bigserial primary key,
      mode                 text not null check (mode in ('test', 'live')),
      milestone            text not null,
      so_no                text,
      recipient_role       text not null check (recipient_role in ('customer', 'sales_cc')),
      to_number            text not null,
      from_number          text,
      body                 text not null,
      channel              text not null,
      status               text not null,
      provider_message_id  text,
      error                text,
      context_source       text,
      idempotency_key      text not null unique,
      created_at           timestamptz not null default now()
    )
  `;
  await db`create index if not exists notify_ledger_created_idx on notify_ledger (created_at desc)`;
  await db`create index if not exists notify_ledger_so_idx on notify_ledger (so_no)`;

  // ── WP-4: the ledger is also the OUTBOX (PRD §5.2, §6) ──────────────────
  // Live rows are planned before they are rendered: the recipient and the text
  // are resolved at SEND time (fresh phone, pre-send recheck), so both start
  // empty. Test rows keep filling them up front as before.
  await db`alter table notify_ledger alter column to_number drop not null`;
  await db`alter table notify_ledger alter column body drop not null`;
  await db`alter table notify_ledger drop constraint if exists notify_ledger_mode_check`;
  await db`
    alter table notify_ledger add constraint notify_ledger_mode_check
      check (mode in ('test', 'live', 'shadow'))
  `;
  await db`alter table notify_ledger add column if not exists event_id         bigint`;
  await db`alter table notify_ledger add column if not exists subject_ref      text`; // DO id for MV3
  await db`alter table notify_ledger add column if not exists due_at           timestamptz`;
  await db`alter table notify_ledger add column if not exists attempts         int not null default 0`;
  await db`alter table notify_ledger add column if not exists leased_until     timestamptz`;
  await db`alter table notify_ledger add column if not exists template_version text`;
  await db`alter table notify_ledger add column if not exists lid              text`;
  await db`alter table notify_ledger add column if not exists sent_at          timestamptz`;
  await db`alter table notify_ledger add column if not exists delivered_at     timestamptz`;
  await db`alter table notify_ledger add column if not exists read_at          timestamptz`;
  await db`alter table notify_ledger add column if not exists cancel_reason    text`;
  await db`alter table notify_ledger add column if not exists meta             jsonb not null default '{}'::jsonb`;
  // The dispatcher's claim query.
  await db`
    create index if not exists notify_ledger_due_idx on notify_ledger (due_at)
     where status in ('pending', 'sending')
  `;
  await db`create index if not exists notify_ledger_to_idx on notify_ledger (to_number, sent_at)`;

  // Planner state: which mode is active, since when, and the last event planned.
  await db`alter table notify_settings add column if not exists live_mode            text`;
  await db`alter table notify_settings add column if not exists activation_watermark timestamptz`;
  await db`alter table notify_settings add column if not exists planned_event_id     bigint not null default 0`;

  // ── Consent and contacts (PRD §9.3) ─────────────────────────────────────
  await db`
    create table if not exists notify_contacts (
      phone_e164         text primary key,
      lid                text,
      consent_state      text not null default 'implied'
                         check (consent_state in ('implied', 'explicit', 'opted_out')),
      consent_source     text,
      opted_out_at       timestamptz,
      first_contacted_at timestamptz,
      notes              text,
      updated_at         timestamptz not null default now()
    )
  `;

  // ── Per-customer overrides (PRD §9.1 step 1, §7 mutes) ──────────────────
  await db`
    create table if not exists notify_customer_overrides (
      customer_name_id text primary key,               -- tbl_1054 id, as on erp_so_header
      phone_e164       text,                           -- replaces kontak_penerima when set
      muted            boolean not null default false,
      set_by           text,
      reason           text,
      updated_at       timestamptz not null default now()
    )
  `;

  // ── Inbound replies from the gateway (PRD §10.5, WP-5) ──────────────────
  await db`
    create table if not exists notify_inbound (
      id          bigserial primary key,
      message_id  text unique,                       -- WhatsApp id; the gateway may retry a callback
      from_pn     text,                              -- E.164 when known
      from_lid    text,                              -- WhatsApp LID when the sender is LID-addressed
      text        text not null,
      action      text,                              -- opted_out | opted_in | shadow_grade | forwarded | unmatched | unresolved
      so_no       text,
      received_at timestamptz not null default now()
    )
  `;
  await db`create index if not exists notify_inbound_from_idx on notify_inbound (from_pn, received_at desc)`;
  // WP-6 admin switches: a global kill switch (pauses sending; planning goes
  // on, nothing is dropped) and per-step on/off (missing key = on).
  await db`alter table notify_settings add column if not exists kill_switch        boolean not null default false`;
  await db`alter table notify_settings add column if not exists milestones_enabled jsonb not null default '{}'::jsonb`;
  await db`alter table notify_settings add column if not exists switches_set_by    text`;
  // Last connection state the gateway reported (logged_out / temporary_ban / …).
  await db`alter table notify_settings add column if not exists gateway_state    text`;
  await db`alter table notify_settings add column if not exists gateway_detail   text`;
  await db`alter table notify_settings add column if not exists gateway_state_at timestamptz`;

  // ── Images received on (and forwarded from) the notification number ─────
  // Stored in Postgres: volumes are small (customer photos of goods, receipts)
  // and it keeps backups/restore in one place. Ids are random UUIDs, so a
  // media URL cannot be guessed by counting.
  await db`
    create table if not exists notify_media (
      id         text primary key,
      mime       text not null,
      size       int not null,
      sha256     text not null,
      bytes      bytea not null,
      caption    text,
      created_at timestamptz not null default now()
    )
  `;
  await db`alter table notify_inbound add column if not exists kind        text not null default 'text'`;
  await db`alter table notify_inbound add column if not exists media_id    text`;
  await db`alter table notify_inbound add column if not exists media_error text`;
  await db`alter table notify_ledger  add column if not exists media_id    text`;

  // ── "Pesan" tab: when each conversation was last read on /notify ────────
  await db`
    create table if not exists notify_chat_reads (
      phone_e164   text primary key,
      last_read_at timestamptz not null default now(),
      read_by      text
    )
  `;
  await db`create index if not exists notify_inbound_unread_idx on notify_inbound (from_pn, received_at)`;

  // ── Rep phones for the sales CC (PRD §9.4, D9) ──────────────────────────
  // Keyed by the Selaras rep id (tbl_1130), vertical-agnostic. Falls away once
  // Selaras carries the phone itself (erp_sales.phone).
  await db`
    create table if not exists notify_sales_contacts (
      erp_sales_id text primary key,
      sales_name   text,
      phone_e164   text,
      cc_enabled   boolean not null default true,
      source       text not null default 'manual' check (source in ('manual', 'selaras')),
      updated_at   timestamptz not null default now()
    )
  `;

  // ── Dispatch marks: "barang dikirim" / "ditunda" (PRD §20) ─────────────
  // The ERP never records the truck leaving or a same-day slip, so staff mark
  // each surat jalan in LeadScout. `notify_dispatch` is the current state per
  // DO; `notify_dispatch_marks` is the append-only history (and the undo log).
  await db`
    create table if not exists notify_dispatch (
      do_id         text primary key,
      so_no         text,
      sched_date    date,                     -- date the customer was last given; null = not yet known
      tbd           boolean not null default false,
      departed_on   date,                     -- WIB day staff marked it departed
      erp_seen_date date,                     -- last sj_date seen in the mirror (detects ERP edits)
      last_mark_id  bigint,
      updated_by    text,
      updated_at    timestamptz not null default now()
    )
  `;
  await db`
    create table if not exists notify_dispatch_marks (
      id         bigserial primary key,
      do_id      text not null,
      so_no      text,
      action     text not null check (action in ('departed', 'rescheduled')),
      from_date  date,
      to_date    date,
      tbd        boolean not null default false,
      source     text not null default 'staff' check (source in ('staff', 'selaras')),
      marked_by  text,
      marked_at  timestamptz not null default now(),
      prev       jsonb,                       -- notify_dispatch row before this mark (for undo)
      event_id   bigint,
      undone_at  timestamptz,
      undone_by  text
    )
  `;
  await db`create index if not exists notify_dispatch_marks_do_idx on notify_dispatch_marks (do_id, id)`;
  await db`alter table notify_settings add column if not exists dispatch_remind_hour    int not null default 13`;
  await db`alter table notify_settings add column if not exists dispatch_remind_numbers text[] not null default '{}'`;
  await db`alter table notify_settings add column if not exists dispatch_reminded_on    date`;

  // PRD §21.3: "sedang dikirim" from XTable, and the 08:00 interim notice.
  await db`alter table notify_settings add column if not exists depart_from_xtable    boolean not null default true`;
  await db`alter table notify_settings add column if not exists depart_morning_notice boolean not null default true`;
  await db`alter table notify_settings add column if not exists morning_notice_hour   int not null default 8`;
  await db`alter table notify_settings add column if not exists morning_noticed_on    date`;
  // Konfigurasi contacts (PRD §21.3, §21.4): reminders, fallbacks, escalation.
  await db`alter table notify_settings add column if not exists sales_admin_number text`;
  await db`alter table notify_settings add column if not exists warehouse_number   text`;
  await db`alter table notify_settings add column if not exists escalation_number  text`;
  // PRD §21.4: the reply agent (needs ANTHROPIC_API_KEY; off = forward as before).
  await db`alter table notify_settings add column if not exists reply_agent      boolean not null default true`;
  await db`alter table notify_settings add column if not exists reply_debounce_s int not null default 90`;

  // PRD §21.5: a customer asked to move a delivery. While a hold is open, the
  // predictive messages for that DO (08:00 notice, an unsent step 3) wait.
  await db`
    create table if not exists notify_do_holds (
      id             bigserial primary key,
      do_id          text not null,
      so_no          text,
      reason         text not null default 'ubah_jadwal',
      requested_date date,
      inbound_id     bigint,
      opened_at      timestamptz not null default now(),
      reminded_at    timestamptz,
      resolved_at    timestamptz,
      resolved_by    text,
      resolution     text check (resolution in ('sj_date_changed', 'tunda', 'kept', 'do_cancelled'))
    )
  `;
  await db`create unique index if not exists notify_do_holds_open_idx on notify_do_holds (do_id) where resolved_at is null`;
}
