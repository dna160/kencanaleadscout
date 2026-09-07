/**
 * Stok Booking (Simple) — idempotent schema (PRD §5). Safe to run on every boot.
 *
 * Called from bootDatabase() right after runMigrations(db). Same style as
 * migrate.ts: each block in its own non-fatal try/catch so a partial failure
 * never blocks the rest of the app from booting.
 *
 * Three tables, one derived number:
 *   stock_uploads   — one active period at a time (partial unique index, R1)
 *   stock_items     — the uploaded inventory rows, immutable after upload (R3)
 *   stock_bookings  — every booking; seven statuses; deducts by derivation (R4–R17)
 *
 *   available (Tersedia) = qty_initial − booked(item)                  (never stored)
 *   booked(item) = Σ qty of bookings in confirmed | overbooked | approved | completed
 *                  whose EFFECTIVE item — coalesce(fulfilled_item_id, item_id) — is item.
 *
 * An upload replaces the quantities but never wipes bookings: still-deducting
 * ones flip to 'outstanding' (R1/R2), which deducts nowhere until PPIC presses
 * Penuhi (R17) and the qty is re-applied against the then-active period.
 */
import type { Sql } from "./client.js";
import { getSql } from "./client.js";

export async function runStockMigrations(db: Sql = getSql()!): Promise<void> {
  // ── stock_uploads — one period per upload; exactly one active (R1) ──────────
  // The partial unique index enforces "at most one active" at the DB layer, so
  // two PPIC tabs uploading at once can never both win (§8.5). Wrapped on its
  // own because the index is an expression index (status) with a WHERE clause,
  // which cannot be an inline table constraint.
  try {
    await db`
      create table if not exists stock_uploads (
        id          bigserial primary key,
        filename    text,
        sheet_name  text,
        note        text,
        uploaded_by text,
        status      text not null default 'active',   -- active | archived
        row_count   integer not null default 0,
        created_at  timestamptz not null default now(),
        archived_at timestamptz
      )
    `;
    // R1: at most one row with status='active'.
    await db`
      create unique index if not exists stock_uploads_one_active
        on stock_uploads ((status)) where status = 'active'
    `;
    // Additive: if an earlier draft created the table without sheet_name.
    await db`alter table stock_uploads add column if not exists sheet_name text`;
  } catch (uploadsErr) {
    console.error("[migrateStock] stock_uploads step failed (non-fatal):", uploadsErr);
  }

  // ── stock_items — uploaded inventory rows; immutable after upload (R3) ──────
  try {
    await db`
      create table if not exists stock_items (
        id           bigserial primary key,
        upload_id    bigint not null references stock_uploads(id),
        name         text not null,       -- display name; composed server-side for structured rows (R9/§6.2)
        product_line text,                -- BRAND from the file; free text
        warna        text,                -- structured columns from the primary map (all null on generic uploads)
        batch_warna  text,
        coating      text,
        th           numeric,             -- aluminium thickness (0.1–0.5 in the sample)
        mm           numeric,             -- panel thickness (3/4 in the sample)
        p            numeric,             -- length, mm
        l            numeric,             -- width, mm
        unit         text not null default 'pcs',   -- 'lembar' when the primary map matched
        qty_initial  numeric not null check (qty_initial >= 0),
        sort_order   integer not null default 0,       -- preserves file row order
        created_at   timestamptz not null default now()
      )
    `;
    await db`create index if not exists stock_items_upload_idx on stock_items (upload_id)`;
  } catch (itemsErr) {
    console.error("[migrateStock] stock_items step failed (non-fatal):", itemsErr);
  }

  // ── stock_bookings — deducts by derivation; six statuses (R4–R12) ──────────
  try {
    await db`
      create table if not exists stock_bookings (
        id            bigserial primary key,
        upload_id     bigint not null references stock_uploads(id),
        item_id       bigint not null references stock_items(id),
        rep_key       text,                             -- 'retail:7' from /api/sales-reps
        rep_name      text not null,
        qty           numeric not null check (qty > 0),
        customer_name text not null,
        so_number     text,                             -- Sales Order no., optional at booking time
        note          text,
        status        text not null default 'confirmed', -- confirmed | overbooked | approved | rejected | cancelled | completed | outstanding
        -- set by Penuhi (R17): the ACTIVE-period item this booking was deducted
        -- from. Only ever written together with status='completed', so the
        -- effective item a booking counts against is coalesce(fulfilled_item_id, item_id).
        fulfilled_item_id bigint references stock_items(id),
        created_at    timestamptz not null default now(),
        verified_by   text,
        verified_at   timestamptz,
        completed_by  text,
        completed_at  timestamptz,
        cancelled_by  text,
        cancelled_at  timestamptz
      )
    `;
    await db`create index if not exists stock_bookings_upload_idx on stock_bookings (upload_id, status)`;
    await db`create index if not exists stock_bookings_item_idx   on stock_bookings (item_id, status)`;
    await db`create index if not exists stock_bookings_rep_idx    on stock_bookings (rep_key)`;

    // Additive: a database from an earlier draft of this schema may pre-date the
    // Selesai action (R12) — bring the completion stamps in via the usual pattern.
    await db`alter table stock_bookings add column if not exists completed_by text`;
    await db`alter table stock_bookings add column if not exists completed_at timestamptz`;
    // R17: Penuhi target. Added separately so databases predating outstanding
    // bookings pick it up on the next boot.
    await db`alter table stock_bookings add column if not exists fulfilled_item_id bigint references stock_items(id)`;
    // SO number: recorded with the booking when the rep already has one.
    await db`alter table stock_bookings add column if not exists so_number text`;
    await db`create index if not exists stock_bookings_fulfilled_idx on stock_bookings (fulfilled_item_id)`;
  } catch (bookingsErr) {
    console.error("[migrateStock] stock_bookings step failed (non-fatal):", bookingsErr);
  }

  // ── online_salespeople — the "Online" sales team ───────────────────────────
  // Same shape as the other per-team rosters (salespeople, project_salespeople,
  // distributor_salespeople). Booking attribution is by rep_key "online:<id>",
  // so these reps flow into the tracker, riwayat, and exports like any other.
  // Deactivate on departure; never hard-delete (bookings reference the name).
  try {
    await db`
      create table if not exists online_salespeople (
        id         bigserial primary key,
        full_name  text not null,
        code       text unique,
        active     boolean not null default true,
        created_at timestamptz not null default now()
      )
    `;
    for (const r of [
      { full_name: "Andini", code: "ADN" },
      { full_name: "Risti",  code: "RST" },
    ]) {
      await db`
        insert into online_salespeople (full_name, code)
        values (${r.full_name}, ${r.code})
        on conflict (code) do nothing
      `;
    }
  } catch (onlineErr) {
    console.error("[migrateStock] online_salespeople step failed (non-fatal):", onlineErr);
  }
}

// Allow `tsx src/db/migrateStock.ts` as a one-off.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("migrateStock.ts")) {
  const db = getSql();
  if (!db) {
    console.error("DATABASE_URL not set — nothing to migrate.");
    process.exit(1);
  }
  runStockMigrations(db)
    .then(() => {
      console.log("✓ stock migrations applied");
      return db.end();
    })
    .catch((err) => {
      console.error("stock migration failed:", err);
      process.exit(1);
    });
}
