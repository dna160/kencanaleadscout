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
  await db`alter table leads add column if not exists sl_flag boolean default false`;
  await db`alter table leads add column if not exists sl_note text`;

  await db`create index if not exists leads_rep_day_idx on leads (rep, day)`;
  await db`create index if not exists outcomes_status_idx on outcomes (status)`;
  await db`create index if not exists outcomes_stage_idx on outcomes (stage)`;
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
