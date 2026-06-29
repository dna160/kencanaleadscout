/**
 * Idempotent schema creation (microPRD §14). Safe to run on every boot.
 *
 * Tables:
 *   leads        — seeded once from data/leads.json
 *   outcomes     — one upserted row per call attempt
 *   enrichments  — scraper bridge: WA numbers keyed by normalized company name,
 *                  so the cockpit can pre-fill a lead before the rep dials.
 */
import type { Sql } from "./client.js";
import { getSql } from "./client.js";

export async function runMigrations(db: Sql = getSql()!): Promise<void> {
  // ── Legacy Modules A–C (best-effort; failures must not block Module D) ────
  // If the leads/outcomes/enrichments tables are absent or already diverged,
  // we still need salespeople + visit tables to exist so the app can boot.
  try {
    await db`
      create table if not exists leads (
        id        text primary key,
        day       int  not null,
        rep       text not null,
        priority  text,
        company   text,
        town      text,
        province  text,
        landline  text,
        ask_for   text,
        role      text,
        email     text,
        website   text
      )
    `;

    await db`
      create table if not exists outcomes (
        lead_id     text primary key references leads(id),
        status      text,
        wa_number   text,
        pic_name    text,
        sample_sent boolean default false,
        updated_at  timestamptz default now(),
        updated_by  text
      )
    `;

    // Part C — pipeline/handler additions (microPRD §24). Additive only; never drop.
    await db`alter table outcomes add column if not exists stage       text default 'captured'`;
    await db`alter table outcomes add column if not exists handler     text`;
    await db`alter table outcomes add column if not exists captured_at timestamptz`;
    await db`alter table outcomes add column if not exists messaged_at timestamptz`;
    await db`alter table outcomes add column if not exists replied_at  timestamptz`;
    await db`alter table outcomes add column if not exists meeting_at  timestamptz`;
    await db`alter table outcomes add column if not exists pipe_note   text`;

    await db`
      create table if not exists enrichments (
        company_norm   text primary key,
        company        text,
        wa_numbers     text,
        mobile_numbers text,
        source         text,
        confidence     text,
        pages_checked  int,
        updated_at     timestamptz default now()
      )
    `;

    // Helpful indexes for the cockpit + champion queries.
    // Sales Lead: flag leads previously contacted by the sales lead.
    await db`alter table leads add column if not exists sl_flag       boolean default false`;
    await db`alter table leads add column if not exists sl_note       text`;
    // Transaction review: invoice ID, alias name used, and review outcome.
    await db`alter table leads add column if not exists invoice_id    text`;
    await db`alter table leads add column if not exists transacted_as text`;
    await db`alter table leads add column if not exists review_status text`;
    // Dedup / relevance flag set by scripts (e.g. irrelevant_manufacturer).
    await db`alter table leads add column if not exists flag          text`;

    await db`create index if not exists leads_rep_day_idx on leads (rep, day)`;
    await db`create index if not exists outcomes_status_idx on outcomes (status)`;
    await db`create index if not exists outcomes_stage_idx on outcomes (stage)`;
  } catch (legacyErr) {
    // Non-fatal: log and continue so Module D tables always get created.
    console.error("[migrate] legacy A–C step failed (non-fatal):", legacyErr);
  }

  // ── Module D — Visitation Log ──────────────────────────────────────────────

  // visit_lists: wrapped separately because the unique index uses an expression
  // (lower(value)), which cannot be expressed as an inline table constraint in
  // PostgreSQL — it must be a separate CREATE UNIQUE INDEX statement.
  try {
    await db`
      create table if not exists visit_lists (
        id     bigserial primary key,
        type   text not null,
        value  text not null,
        active boolean not null default true
      )
    `;
    await db`
      create unique index if not exists visit_lists_type_value_idx
        on visit_lists (type, lower(value))
    `;
  } catch (vlErr) {
    console.error("[migrate] visit_lists step failed (non-fatal):", vlErr);
  }

  // Field-rep registry. Deactivate on departure; never hard-delete (historical FK).
  await db`
    create table if not exists salespeople (
      id           bigserial primary key,
      full_name    text not null,
      code         text unique,
      phone_e164   text,
      default_area text,
      active       boolean not null default true,
      created_at   timestamptz not null default now()
    )
  `;
  // Additive: if table existed before `active` was introduced, add it now.
  await db`alter table salespeople add column if not exists active boolean not null default true`;

  // Customer master: enables New/Old auto-detection + dedup.
  await db`
    create table if not exists customers (
      id            bigserial primary key,
      store_name    text not null,
      category      text not null,
      area          text,
      address       text,
      postal_code   text,
      first_seen_at timestamptz,
      created_by    bigint references salespeople(id)
    )
  `;
  await db`
    create unique index if not exists customers_norm
      on customers (lower(trim(store_name)), coalesce(area, ''))
  `;

  // The visit log. visited_at is server-stamped on submit; immutable to reps.
  await db`
    create table if not exists visits (
      id             bigserial primary key,
      salesperson_id bigint not null references salespeople(id),
      customer_id    bigint references customers(id),
      pic_name       text,
      store_name     text not null,
      customer_type  text not null check (customer_type in ('new','old')),
      category       text not null,
      address        text,
      area           text not null,
      postal_code    text check (postal_code is null or postal_code ~ '^\\d{5}$'),
      notes          text,
      visited_at     timestamptz not null default now(),
      created_at     timestamptz not null default now(),
      source         text not null default 'app'
    )
  `;
  await db`create index if not exists visits_rep_time on visits (salesperson_id, visited_at desc)`;
  await db`create index if not exists visits_area     on visits (area)`;
  await db`create index if not exists visits_type     on visits (customer_type)`;
  await db`alter table visits add column if not exists activity_type text not null default 'kunjungan'`;

  // Audit log for Handler overrides of visited_at.
  await db`
    create table if not exists visit_audits (
      id         bigserial primary key,
      visit_id   bigint not null references visits(id),
      field      text not null,
      old_value  text,
      new_value  text,
      changed_by text,
      changed_at timestamptz not null default now()
    )
  `;

  // Photo attachments — up to 5 per visit, stored as bytea.
  await db`
    create table if not exists visit_photos (
      id         bigserial primary key,
      visit_id   bigint not null references visits(id) on delete cascade,
      file_data  bytea not null,
      mime_type  text not null default 'image/jpeg',
      filename   text,
      file_size  int not null,
      created_at timestamptz not null default now()
    )
  `;
  await db`create index if not exists visit_photos_visit_idx on visit_photos (visit_id)`;

  // ── Module D — Accounts (customers enhancement + pipeline tables) ──────────

  // Enhance customers table with account pipeline columns.
  await db`alter table customers add column if not exists account_type   text default 'repeating'`;
  await db`alter table customers add column if not exists stage          text default 'aktif'`;
  await db`alter table customers add column if not exists owner_id       bigint references salespeople(id)`;
  await db`alter table customers add column if not exists last_contact_at timestamptz`;

  // Backfill owner_id + last_contact_at from visits for accounts that pre-date Module D.
  await db`
    update customers c
    set
      owner_id        = coalesce(c.owner_id,        v.salesperson_id),
      last_contact_at = coalesce(c.last_contact_at, v.visited_at)
    from (
      select distinct on (customer_id)
        customer_id, salesperson_id, visited_at
      from visits
      where customer_id is not null
      order by customer_id, visited_at desc
    ) v
    where c.id = v.customer_id
      and (c.owner_id is null or c.last_contact_at is null)
  `;

  // Every touchpoint (visit, call, order) linked to an account.
  await db`
    create table if not exists actions (
      id             bigserial primary key,
      account_id     bigint not null references customers(id),
      salesperson_id bigint references salespeople(id),
      action_type    text not null,
      invoice_number text,
      notes          text,
      actioned_at    timestamptz not null default now(),
      created_at     timestamptz not null default now()
    )
  `;
  await db`create index if not exists actions_account_idx on actions (account_id, actioned_at desc)`;
  await db`create index if not exists actions_rep_idx     on actions (salesperson_id, actioned_at desc)`;

  // Audit trail for stage transitions.
  await db`
    create table if not exists stage_history (
      id          bigserial primary key,
      account_id  bigint not null references customers(id),
      old_stage   text,
      new_stage   text not null,
      changed_by  bigint references salespeople(id),
      changed_at  timestamptz not null default now()
    )
  `;
  await db`create index if not exists stage_history_account_idx on stage_history (account_id, changed_at desc)`;

  // Scheduled follow-up actions.
  await db`
    create table if not exists scheduled_actions (
      id             bigserial primary key,
      account_id     bigint not null references customers(id),
      salesperson_id bigint references salespeople(id),
      action_type    text not null default 'followup',
      scheduled_for  timestamptz not null,
      notes          text,
      completed_at   timestamptz,
      created_at     timestamptz not null default now()
    )
  `;
  await db`create index if not exists scheduled_actions_rep_idx  on scheduled_actions (salesperson_id, scheduled_for)`;
  await db`create index if not exists scheduled_actions_acct_idx on scheduled_actions (account_id, scheduled_for)`;

  // Seed categories + areas — wrapped so a missing visit_lists table never
  // prevents the salespeople seeding below from running.
  try {
    for (const v of ["Toko", "Workshop", "Aplikator", "Kontraktor", "Distributor", "Advertising/Signage", "Project", "Other"]) {
      await db`insert into visit_lists (type, value) values ('category', ${v}) on conflict do nothing`;
    }
    for (const v of [
      "Bekasi Barat", "Bekasi Timur", "Bekasi Utara", "Bekasi Selatan", "Bekasi Kota",
      "Cikarang", "Karawang", "Depok", "Tangerang Selatan",
      "Jakarta Timur", "Jakarta Selatan", "Jakarta Pusat", "Jakarta Barat", "Jakarta Utara",
      "Bogor",
    ]) {
      await db`insert into visit_lists (type, value) values ('area', ${v}) on conflict do nothing`;
    }
  } catch (listSeedErr) {
    console.error("[migrate] visit_lists seeding failed (non-fatal):", listSeedErr);
  }

  // Seed initial roster (inferred from workbook tabs). Handler can extend.
  try {
    for (const r of [
      { full_name: "Hanif",    code: "HNF" },
      { full_name: "Edhy",     code: "EDH" },
      { full_name: "Suwondo",  code: "SWD" },
      { full_name: "Rahmanto", code: "RHM" },
      { full_name: "Burhan",   code: "BRH" },
      { full_name: "Anthony",  code: "ANT" },
    ]) {
      await db`
        insert into salespeople (full_name, code)
        values (${r.full_name}, ${r.code})
        on conflict (code) do nothing
      `;
    }
  } catch (seedErr) {
    console.error("[migrate] salespeople seeding failed (non-fatal):", seedErr);
  }
}

// Allow `tsx src/db/migrate.ts` as a one-off.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("migrate.ts")) {
  const db = getSql();
  if (!db) {
    console.error("DATABASE_URL not set — nothing to migrate.");
    process.exit(1);
  }
  runMigrations(db)
    .then(() => {
      console.log("✓ migrations applied");
      return db.end();
    })
    .catch((err) => {
      console.error("migration failed:", err);
      process.exit(1);
    });
}
