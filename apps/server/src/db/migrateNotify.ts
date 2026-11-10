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
}
