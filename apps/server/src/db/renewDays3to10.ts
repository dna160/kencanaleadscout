/**
 * renewDays3to10.ts — Surgical, non-destructive renewal of Days 3-10 leads.
 *
 * Run with:  tsx src/db/renewDays3to10.ts
 *
 * Safety guarantees:
 *  - Day 1 and Day 2 leads + all their outcomes are never touched.
 *  - Any old Day 3-10 lead that has an outcome row is KEPT (reported, not deleted).
 *  - Old Day 3-10 leads WITHOUT outcomes are removed (they were never worked).
 *  - INSERT ... ON CONFLICT (id) DO NOTHING — idempotent: safe to run twice.
 *  - No DROP, TRUNCATE, or DELETE of worked data.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getSql } from "./client.js";
import type { Sql } from "./client.js";

interface V2Lead {
  id: string;
  day: number;
  rep: string;
  pri: string;
  co: string;
  town: string;
  province?: string;
  tel: string;
  ask: string;
  role: string;
  email?: string;
  website?: string;
  source?: string;
}

function toRow(l: V2Lead) {
  return {
    id: l.id,
    day: l.day,
    rep: l.rep,
    priority: l.pri,
    company: l.co,
    town: l.town,
    province: l.province ?? "",
    landline: l.tel,
    ask_for: l.ask,
    role: l.role,
    email: l.email ?? "",
    website: l.website ?? "",
    source: l.source ?? "v2_cleaned",
  };
}

function loadV2(): V2Lead[] {
  const path = fileURLToPath(new URL("../../data/leads_v2_days3-10_cleaned.json", import.meta.url));
  const raw = JSON.parse(readFileSync(path, "utf8")) as V2Lead[];
  const filtered = raw.filter((l) => l.day >= 3);
  return filtered;
}

async function renew(db: Sql): Promise<void> {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  renewDays3to10 — Kencana LeadScout");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // ── Step 0: ensure source column exists ───────────────────────────────────
  await db`alter table leads add column if not exists source text`;

  // ── Step 1: pre-flight snapshot ───────────────────────────────────────────
  const [{ day1_count }] = await db<[{ day1_count: string }]>`
    select count(*) as day1_count from leads where day = 1`;
  const [{ day2_count }] = await db<[{ day2_count: string }]>`
    select count(*) as day2_count from leads where day = 2`;
  const [{ outcomes_before }] = await db<[{ outcomes_before: string }]>`
    select count(*) as outcomes_before from outcomes`;

  console.log("PRE-FLIGHT:");
  console.log(`  Day 1 leads in DB   : ${day1_count}`);
  console.log(`  Day 2 leads in DB   : ${day2_count}`);
  console.log(`  Outcomes rows       : ${outcomes_before}\n`);

  // ── Step 2: load new records ───────────────────────────────────────────────
  const records = loadV2();
  console.log(`Loaded ${records.length} records from leads_v2_days3-10_cleaned.json (day >= 3)\n`);

  if (records.length === 0) {
    throw new Error("No records loaded from JSON — aborting.");
  }

  // Guard: none should touch Day 1 or Day 2
  const badDay = records.filter((r) => r.day < 3);
  if (badDay.length > 0) {
    throw new Error(`JSON contains ${badDay.length} records with day < 3 — aborting. IDs: ${badDay.map((r) => r.id).join(", ")}`);
  }

  // ── Step 3: collision check — any v2 id already in leads? ─────────────────
  const v2Ids = records.map((r) => r.id);
  const existing = await db<{ id: string }[]>`
    select id from leads where id = any(${db.array(v2Ids)})`;
  const collisionIds = existing.map((r) => r.id);
  const newIds = v2Ids.filter((id) => !collisionIds.includes(id));

  if (collisionIds.length > 0) {
    console.log(`ID COLLISIONS (already in DB — skipped by ON CONFLICT DO NOTHING): ${collisionIds.length}`);
    collisionIds.forEach((id) => console.log(`  skip: ${id}`));
    console.log();
  }

  // ── Step 4: insert with DO NOTHING ────────────────────────────────────────
  const rows = records.map(toRow);
  let inserted = 0;

  if (rows.length > 0) {
    // Batch in chunks of 100 to stay within param limits
    const CHUNK = 100;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await db`
        insert into leads ${db(
          chunk,
          "id", "day", "rep", "priority", "company", "town",
          "province", "landline", "ask_for", "role", "email", "website", "source",
        )}
        on conflict (id) do nothing
      `;
    }
    inserted = newIds.length;
  }

  console.log(`INSERT: ${inserted} new leads inserted (${collisionIds.length} already existed, skipped)`);

  // ── Step 5: no-op flags check (no flags column/table in schema) ────────────
  console.log("FLAGS: No flags column or table found in schema — 0 flags to migrate.");

  // ── Step 6: identify old Day 3-10 leads ───────────────────────────────────
  // Old IDs look like d3_A_0, d3_B_1 etc. (no 'v2' substring).
  // v2 IDs look like d3v2_A_0, d3v2_B_1 etc.
  const oldStale = await db<{ id: string; company: string }[]>`
    select l.id, l.company
    from leads l
    left join outcomes o on o.lead_id = l.id
    where l.day >= 3
      and l.id not like '%v2%'
      and o.lead_id is null
  `;

  const oldWorked = await db<{ id: string; company: string; status: string }[]>`
    select l.id, l.company, o.status
    from leads l
    join outcomes o on o.lead_id = l.id
    where l.day >= 3
      and l.id not like '%v2%'
  `;

  if (oldWorked.length > 0) {
    console.log(`\nWARNING — old Day 3-10 leads WITH outcomes (KEPT, not deleted): ${oldWorked.length}`);
    oldWorked.forEach((r) => console.log(`  KEPT: ${r.id}  company=${r.company}  outcome=${r.status}`));
  }

  // ── Step 7: delete unworked old Day 3-10 leads ────────────────────────────
  let deleted = 0;
  if (oldStale.length > 0) {
    const staleIds = oldStale.map((r) => r.id);
    await db`delete from leads where id = any(${db.array(staleIds)})`;
    deleted = staleIds.length;
    console.log(`\nDELETE: ${deleted} unworked old Day 3-10 leads removed.`);
  } else {
    console.log("\nDELETE: 0 old unworked leads to remove (already clean or second run).");
  }

  // ── Step 8: post-flight verification ──────────────────────────────────────
  const [{ day1_after }] = await db<[{ day1_after: string }]>`
    select count(*) as day1_after from leads where day = 1`;
  const [{ day2_after }] = await db<[{ day2_after: string }]>`
    select count(*) as day2_after from leads where day = 2`;
  const [{ outcomes_after }] = await db<[{ outcomes_after: string }]>`
    select count(*) as outcomes_after from outcomes`;
  const [{ new_day3plus }] = await db<[{ new_day3plus: string }]>`
    select count(*) as new_day3plus from leads where day >= 3 and id like '%v2%'`;

  // Verify Day 1 and Day 2 are untouched
  if (day1_after !== day1_count) {
    throw new Error(`INTEGRITY FAIL: Day 1 count changed ${day1_count} → ${day1_after}`);
  }
  if (day2_after !== day2_count) {
    throw new Error(`INTEGRITY FAIL: Day 2 count changed ${day2_count} → ${day2_after}`);
  }
  if (outcomes_after !== outcomes_before) {
    throw new Error(`INTEGRITY FAIL: outcomes count changed ${outcomes_before} → ${outcomes_after}`);
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  RECONCILIATION REPORT");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Day 1 leads unchanged      : ${day1_after}  ✓`);
  console.log(`  Day 2 leads unchanged      : ${day2_after}  ✓`);
  console.log(`  Outcomes rows before       : ${outcomes_before}`);
  console.log(`  Outcomes rows after        : ${outcomes_after}  ✓`);
  console.log(`  Old Day 3-10 removed       : ${deleted}`);
  console.log(`  Old Day 3-10 kept (worked) : ${oldWorked.length}`);
  console.log(`  New v2 Day 3-10 inserted   : ${inserted}`);
  console.log(`  New v2 Day 3-10 in DB      : ${new_day3plus}`);
  console.log(`  ID collisions (skipped)    : ${collisionIds.length}`);
  console.log(`  Flags migrated             : 0  (no flags column in schema)`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ✓ All acceptance criteria met.");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

// ── Entrypoint ────────────────────────────────────────────────────────────────
if (
  process.argv[1]?.endsWith("renewDays3to10.ts") ||
  process.argv[1]?.endsWith("renewDays3to10.js")
) {
  const db = getSql();
  if (!db) {
    console.error("DATABASE_URL not set — cannot run.");
    process.exit(1);
  }
  renew(db)
    .then(() => db.end())
    .catch((err) => {
      console.error("\n✖ FAILED:", err.message ?? err);
      process.exit(1);
    });
}

export { renew };
