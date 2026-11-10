/**
 * Kabar Pesanan WP-2 — the order-lane mirror tables and their sync state.
 * Additive and idempotent; runs on every boot after migrateErpStock (which owns
 * erp_so_header / erp_so_line).
 *
 * Timestamps follow the existing mirror convention (selarasClient A18): the
 * ERP's naive WIB wall-clock values are stored as if they were UTC.
 */
import type { Sql } from "./client.js";

export async function runOrderMigrations(db: Sql): Promise<void> {
  await db`
    create table if not exists erp_do_header (
      id                 text primary key,           -- tbl_1082_SOLogisticPID_id
      so_no              text,                       -- SO number (= erp_so_header.po_no)
      no_sj              text,                       -- surat jalan / DO number
      sj_date            date,                       -- SCHEDULED date
      do_created_at      timestamptz,
      cara_kirim         text,                       -- 'di Antar' | 'di Ambil' (label)
      cancel_order       text,                       -- 'Yes' | 'No'
      print_status       text,
      top                text,
      top_days           numeric,
      due_date           date,
      invoice_no         text,
      customer_name_id   text,
      customer_name_text text,
      total_lembar       numeric,
      total_m2           numeric,
      erp_created_at     timestamptz,
      erp_updated_at     timestamptz,
      deleted_at         timestamptz,                -- kept, not purged: WP-3 derives do.cancelled
      synced_at          timestamptz not null default now()
    )
  `;
  await db`create index if not exists erp_do_header_so_idx on erp_do_header (so_no)`;
  await db`create index if not exists erp_do_header_sj_idx on erp_do_header (no_sj)`;

  await db`
    create table if not exists erp_do_line (
      id             text primary key,               -- tbl_1205_SOSalesOrderDeliveryNID_id
      po_no          text,                           -- SO number
      so_item_no     text,                           -- -> erp_so_line.id
      sj_id          text,                           -- -> erp_do_header.id (Selaras: sj_no)
      do_text        text,
      sj_date        date,
      sn_fg          text,
      item_details   text,
      qty_delivered  numeric,
      erp_created_at timestamptz,
      erp_updated_at timestamptz,
      deleted_at     timestamptz,
      synced_at      timestamptz not null default now()
    )
  `;
  await db`create index if not exists erp_do_line_sj_idx on erp_do_line (sj_id)`;
  await db`create index if not exists erp_do_line_po_idx on erp_do_line (po_no)`;

  await db`
    create table if not exists erp_request_produksi (
      id              text primary key,              -- tbl_1236_DBRequestProduksiID_id
      so_no           text,
      so_ms           text,                          -- 'SO' | 'MS' | 'O' | 'TRIAL'
      wo_no           text,
      no_request      text,
      tanggal_request date,
      brand           text,                          -- 1236.sticker
      brand_text      text,
      warna           text,
      warna_text      text,
      th_panel        numeric,                       -- 1236.th_alu_skin ("Tebal") = PANEL mm
      th_skin         numeric,                       -- 1236.alu = skin
      qty_lembar      numeric,
      erp_created_at  timestamptz,
      erp_updated_at  timestamptz,
      deleted_at      timestamptz,
      synced_at       timestamptz not null default now()
    )
  `;
  await db`create index if not exists erp_request_produksi_so_idx on erp_request_produksi (so_no)`;

  await db`
    create table if not exists erp_sales (
      id             text primary key,               -- tbl_1130_CRMListSalesID_id
      sales_name     text,
      department     text,
      active         text,
      phone          text,                           -- NULL until Selaras adds a phone field
      erp_created_at timestamptz,
      erp_updated_at timestamptz,
      deleted_at     timestamptz,
      synced_at      timestamptz not null default now()
    )
  `;

  // One row per (table, cursor field). Kept apart from erp_sync_state so the
  // stock sync's lock, freshness alarm and reset-all paths never touch it.
  await db`
    create table if not exists erp_order_sync_state (
      table_name   text not null,
      cursor_field text not null,
      cursor_value timestamptz,
      last_ok_at   timestamptz,
      last_error   text,
      last_error_kind text,
      last_error_at timestamptz,
      rows_synced  bigint not null default 0,
      primary key (table_name, cursor_field)
    )
  `;
  // A lease, so a second replica (or a slow tick) never runs the lane twice.
  await db`
    create table if not exists erp_order_sync_lease (
      id          int primary key default 1 check (id = 1),
      owner       text,
      lease_until timestamptz
    )
  `;
  await db`insert into erp_order_sync_lease (id) values (1) on conflict (id) do nothing`;
}
