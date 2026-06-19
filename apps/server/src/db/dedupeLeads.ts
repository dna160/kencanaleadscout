/**
 * dedupeLeads.ts — Idempotent data-hygiene pass for Days 4-10 leads.
 *
 * Run with:  pnpm dedupe  (or tsx src/db/dedupeLeads.ts)
 *
 * What this does:
 *  1. Adds `flag TEXT` column if absent.
 *  2. Deletes old-format day>=4 leads (id NOT LIKE '%v2%') that have no
 *     outcome row — these are the original d4_A_0…d10_B_59 rows re-seeded
 *     by the boot seeder after renewDays3to10 replaced them with v2 rows.
 *     Any old-format row that somehow has an outcome is KEPT and reported.
 *  3. Collapses same-company duplicate v2 rows within (company, town, day)
 *     per survivor-selection rule (outcome > role seniority > ask_for > id).
 *  4. Flags v2 leads whose company name signals a material manufacturer.
 *
 * Safety:
 *  - Day 1, 2, 3 rows are NEVER touched (hard filter: day >= 4 only).
 *  - outcomes count must be identical before/after.
 *  - Idempotent: running twice changes nothing.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getSql } from "./client.js";
import type { Sql } from "./client.js";

const MFR_RE =
  /beton|concrete|precast|pracetak|ready[\s-]?mix|conwood|fibre|fiber|semen|cement|baja[\s-]?ringan|pabrik|manufaktur/i;

function rolePriority(role: string): number {
  const r = (role || "").toLowerCase();
  if (/director|owner|principal/.test(r)) return 5;
  if (/project manager/.test(r)) return 4;
  if (/purchasing|procurement/.test(r)) return 3;
  if (/manager|head/.test(r)) return 2;
  if (/coordinator|supervisor|engineer/.test(r)) return 1;
  return 0;
}

function normKey(company: string, town: string, day: number): string {
  const c = company
    .toUpperCase()
    .replace(/\b(PT|CV|UD|TB|TOKO|PD|TBK\.?|PERSERO)\b/g, "")
    .replace(/[^A-Z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const t = town.toUpperCase().replace(/[^A-Z0-9]/g, " ").replace(/\s+/g, " ").trim();
  return `${c}|${t}|${day}`;
}

async function dedupe(db: Sql): Promise<void> {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  dedupeLeads — Kencana LeadScout");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // ── Step 0: add flag column ────────────────────────────────────────────────
  await db`alter table leads add column if not exists flag text`;

  // ── Step 1: pre-flight snapshot ───────────────────────────────────────────
  const [{ d1 }] = await db<[{ d1: string }]>`select count(*) d1 from leads where day = 1`;
  const [{ d2 }] = await db<[{ d2: string }]>`select count(*) d2 from leads where day = 2`;
  const [{ d3 }] = await db<[{ d3: string }]>`select count(*) d3 from leads where day = 3`;
  const [{ outc_before }] = await db<[{ outc_before: string }]>`select count(*) outc_before from outcomes`;

  console.log("PRE-FLIGHT:");
  console.log(`  Day 1 leads  : ${d1}  (untouched)`);
  console.log(`  Day 2 leads  : ${d2}  (untouched)`);
  console.log(`  Day 3 leads  : ${d3}  (untouched)`);
  console.log(`  Outcomes     : ${outc_before}\n`);

  // ── Step 2: clean old-format day>=4 rows (re-seeded by boot seeder) ───────
  const oldWorked = await db<{ id: string; company: string; status: string }[]>`
    select l.id, l.company, o.status
    from leads l
    join outcomes o on o.lead_id = l.id
    where l.day >= 4 and l.id not like '%v2%'`;

  if (oldWorked.length > 0) {
    console.log(`WARNING — old-format day>=4 rows WITH outcomes (KEPT): ${oldWorked.length}`);
    oldWorked.forEach((r) => console.log(`  KEPT: ${r.id}  ${r.company}  status=${r.status}`));
    console.log();
  }

  const oldStale = await db<{ id: string }[]>`
    select l.id from leads l
    left join outcomes o on o.lead_id = l.id
    where l.day >= 4 and l.id not like '%v2%' and o.lead_id is null`;

  let oldDeleted = 0;
  if (oldStale.length > 0) {
    const ids = oldStale.map((r) => r.id);
    await db`delete from leads where id = any(${db.array(ids)})`;
    oldDeleted = ids.length;
  }
  console.log(`Old-format day>=4 cleanup: ${oldDeleted} unworked rows removed, ${oldWorked.length} kept.`);

  // ── Step 3: v2 dedup within (company, town, day) ──────────────────────────
  const v2rows = await db<{
    id: string; day: number; company: string; town: string;
    ask_for: string; role: string; flag: string | null;
  }[]>`
    select l.id, l.day, l.company, l.town, l.ask_for, l.role, l.flag,
           o.lead_id as outcome_id
    from leads l
    left join outcomes o on o.lead_id = l.id
    where l.day >= 4 and l.id like '%v2%'`;

  type V2Row = (typeof v2rows)[number] & { outcome_id?: string };

  // Group by norm key
  const groups = new Map<string, V2Row[]>();
  for (const r of v2rows) {
    const key = normKey(r.company, r.town, r.day);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r as V2Row);
  }

  const dupGroups = [...groups.values()].filter((g) => g.length > 1);
  let collapsed = 0;
  let surplusRemoved = 0;
  let flagsMigrated = 0;
  const ambiguous: string[] = [];

  for (const group of dupGroups) {
    const withOutcome = group.filter((r) => r.outcome_id);
    if (withOutcome.length > 1) {
      const first = group[0]!;
      ambiguous.push(`${first.company} / ${first.town} / day${first.day} (${group.length} rows, ${withOutcome.length} with outcomes)`);
      continue;
    }

    const sorted = [...group].sort((a, b) => {
      const aHas = a.outcome_id ? 1 : 0;
      const bHas = b.outcome_id ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      const rDiff = rolePriority(b.role) - rolePriority(a.role);
      if (rDiff !== 0) return rDiff;
      const aAsk = a.ask_for && a.ask_for !== "—" ? 1 : 0;
      const bAsk = b.ask_for && b.ask_for !== "—" ? 1 : 0;
      if (aAsk !== bAsk) return bAsk - aAsk;
      return a.id < b.id ? -1 : 1;
    });

    const survivor = sorted[0]!;
    const toDelete = sorted.slice(1).filter((r) => !r.outcome_id);

    const anyFlag = group.find((r) => r.flag && r.flag !== survivor.flag);
    if (anyFlag?.flag && !survivor.flag) {
      await db`update leads set flag = ${anyFlag.flag} where id = ${survivor.id}`;
      flagsMigrated++;
    }

    if (toDelete.length > 0) {
      await db`delete from leads where id = any(${db.array(toDelete.map((r) => r.id))})`;
      surplusRemoved += toDelete.length;
      collapsed++;
    }
  }

  console.log(`V2 dedup: ${dupGroups.length} duplicate groups found, ${collapsed} collapsed, ${surplusRemoved} surplus rows removed.`);
  if (ambiguous.length) {
    console.log(`Ambiguous groups kept-both (${ambiguous.length}):`);
    ambiguous.forEach((s) => console.log("  ", s));
  }

  // ── Step 4: manufacturer relevance flag ───────────────────────────────────
  const mfrLeads = await db<{ id: string; company: string; day: number }[]>`
    select id, company, day from leads
    where day >= 4 and id like '%v2%'
    and (flag is null or flag != 'irrelevant_manufacturer')
    and lower(company) ~* 'beton|concrete|precast|pracetak|ready.mix|conwood|fibre|fiber|semen|cement|baja.ringan|pabrik|manufaktur'`;

  let mfrFlagged = 0;
  if (mfrLeads.length > 0) {
    await db`
      update leads set flag = 'irrelevant_manufacturer'
      where id = any(${db.array(mfrLeads.map((r) => r.id))})`;
    mfrFlagged = mfrLeads.length;
    mfrLeads.forEach((r) => console.log(`Manufacturer flagged: day${r.day} ${r.id} | ${r.company}`));
  }

  // ── Step 5: post-flight integrity check ───────────────────────────────────
  const [{ d1_after }] = await db<[{ d1_after: string }]>`select count(*) d1_after from leads where day = 1`;
  const [{ d2_after }] = await db<[{ d2_after: string }]>`select count(*) d2_after from leads where day = 2`;
  const [{ d3_after }] = await db<[{ d3_after: string }]>`select count(*) d3_after from leads where day = 3`;
  const [{ outc_after }] = await db<[{ outc_after: string }]>`select count(*) outc_after from outcomes`;

  if (d1_after !== d1) throw new Error(`INTEGRITY FAIL: Day 1 changed ${d1} → ${d1_after}`);
  if (d2_after !== d2) throw new Error(`INTEGRITY FAIL: Day 2 changed ${d2} → ${d2_after}`);
  if (d3_after !== d3) throw new Error(`INTEGRITY FAIL: Day 3 changed ${d3} → ${d3_after}`);
  if (outc_after !== outc_before) throw new Error(`INTEGRITY FAIL: outcomes changed ${outc_before} → ${outc_after}`);

  const [{ v2_after }] = await db<[{ v2_after: string }]>`select count(*) v2_after from leads where day >= 4 and id like '%v2%'`;

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  RECONCILIATION REPORT");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Day 1/2/3 rows touched     : 0  ✓`);
  console.log(`  Outcomes before            : ${outc_before}`);
  console.log(`  Outcomes after             : ${outc_after}  ✓`);
  console.log(`  Old-format rows removed    : ${oldDeleted}`);
  console.log(`  Old-format rows kept(work) : ${oldWorked.length}`);
  console.log(`  V2 dup groups collapsed    : ${collapsed}`);
  console.log(`  V2 surplus rows removed    : ${surplusRemoved}`);
  console.log(`  Flags migrated to survivor : ${flagsMigrated}`);
  console.log(`  Manufacturer flagged       : ${mfrFlagged}`);
  console.log(`  Ambiguous groups kept-both : ${ambiguous.length}`);
  console.log(`  Day 4-10 v2 rows remaining : ${v2_after}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ✓ All acceptance criteria met.");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

if (
  process.argv[1]?.endsWith("dedupeLeads.ts") ||
  process.argv[1]?.endsWith("dedupeLeads.js")
) {
  const db = getSql();
  if (!db) { console.error("DATABASE_URL not set."); process.exit(1); }
  dedupe(db)
    .then(() => db.end())
    .catch((err) => { console.error("\n✖ FAILED:", err.message ?? err); process.exit(1); });
}

export { dedupe };
