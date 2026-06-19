/**
 * Deduplication + relevance cleanup for the leads table.
 *
 * SCOPE: day >= 4 only. Day 1-3 are never touched.
 * SCOPE (dedup): groups where the same normalised company+town appears more than once.
 * SCOPE (manufacturer flag): leads whose company name suggests they are a
 *   manufacturer/supplier rather than an ACP buyer — tagged review_flag='irrelevant_manufacturer'.
 *
 * Usage:
 *   tsx src/db/dedupeLeads.ts           # dry-run (inspect, print report, no writes)
 *   tsx src/db/dedupeLeads.ts --run     # execute (idempotent)
 *
 * Safety guarantees:
 *   - Leads that already have an outcome row are NEVER deleted.
 *   - sl_flag is migrated to the survivor before any sibling is deleted.
 *   - The script is idempotent: re-running after --run produces zero changes.
 */

import postgres from "postgres";

const DRY_RUN = !process.argv.includes("--run");

// ── helpers ──────────────────────────────────────────────────────────────────

function norm(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/\bpt\b\.?/g, "")           // strip PT / PT. prefix/suffix
    .replace(/\btbk\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const SENIOR_ROLES = [
  "owner", "director", "direktur", "ceo", "president",
  "general manager", "gm ", "vice president", "vp ",
  "commissioner", "komisaris", "principal", "partner",
];

function isSenior(role: string | null | undefined): boolean {
  if (!role) return false;
  const r = role.toLowerCase();
  return SENIOR_ROLES.some((s) => r.includes(s));
}

// Company names that suggest manufacturer/supplier — not ACP buyers.
const MFR_SIGNALS = [
  "industri",
  "manufacturing",
  "manufacturer",
  "pabrik",
  "produsen",
  "suplier",
  "supplier",
  "distributor",
  "perdagangan bahan",
  "material",
  "bahan bangunan",
  "aluminium",
  "composite panel",
  "acp",
];

function looksLikeManufacturer(company: string | null | undefined): boolean {
  if (!company) return false;
  const c = company.toLowerCase();
  return MFR_SIGNALS.some((s) => c.includes(s));
}

// ── types ────────────────────────────────────────────────────────────────────

interface LeadFull {
  id: string;
  day: number;
  rep: string;
  priority: string | null;
  company: string | null;
  town: string | null;
  province: string | null;
  ask_for: string | null;
  role: string | null;
  sl_flag: boolean;
  sl_note: string | null;
  has_outcome: boolean;
  review_flag: string | null;
}

interface DupeGroup {
  key: string; // norm_company|norm_town
  leads: LeadFull[];
  survivor: LeadFull;
  toDelete: LeadFull[];
}

// ── survivor selection ───────────────────────────────────────────────────────

function pickSurvivor(group: LeadFull[]): LeadFull {
  // Sort: has_outcome DESC, is_senior DESC, has_ask_for DESC, id ASC
  return [...group].sort((a, b) => {
    if (a.has_outcome !== b.has_outcome) return a.has_outcome ? -1 : 1;
    const aS = isSenior(a.role);
    const bS = isSenior(b.role);
    if (aS !== bS) return aS ? -1 : 1;
    const aAsk = !!a.ask_for?.trim();
    const bAsk = !!b.ask_for?.trim();
    if (aAsk !== bAsk) return aAsk ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  })[0]!;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error("DATABASE_URL not set.");
    process.exit(1);
  }

  const db = postgres(url, { onnotice: () => {} });

  try {
    // ── 0. Ensure review_flag column exists ──────────────────────────────────
    if (!DRY_RUN) {
      await db`alter table leads add column if not exists review_flag text`;
      console.log("✓ review_flag column ensured");
    } else {
      console.log("(dry-run) would add column: leads.review_flag text");
    }

    // ── 1. Load all leads for day >= 4 ───────────────────────────────────────
    const rows = await db<LeadFull[]>`
      select
        l.id, l.day, l.rep, l.priority, l.company, l.town, l.province,
        l.ask_for, l.role,
        coalesce(l.sl_flag, false) as sl_flag,
        l.sl_note,
        (o.lead_id is not null) as has_outcome,
        l.review_flag
      from leads l
      left join outcomes o on o.lead_id = l.id
      where l.day >= 4
      order by l.day, l.id
    `;

    console.log(`\n── INSPECTION ──`);
    console.log(`Leads in scope (day >= 4): ${rows.length}`);

    // Day distribution
    const byDay = new Map<number, number>();
    for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + 1);
    const dayTable = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
    console.log("By day:", dayTable.map(([d, n]) => `day${d}:${n}`).join("  "));

    const withOutcome = rows.filter((r) => r.has_outcome).length;
    console.log(`With outcomes: ${withOutcome}`);

    // ID patterns
    const v2Leads = rows.filter((r) => r.id.includes("v2"));
    console.log(`IDs containing 'v2': ${v2Leads.length}`);
    if (v2Leads.length > 0) {
      console.log("  Sample v2 ids:", v2Leads.slice(0, 5).map((r) => r.id).join(", "));
    }

    // ── 2. Find duplicate groups ──────────────────────────────────────────────
    const grouped = new Map<string, LeadFull[]>();
    for (const row of rows) {
      const key = `${norm(row.company)}|${norm(row.town)}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(row);
    }

    const dupeGroups: DupeGroup[] = [];
    for (const [key, group] of grouped) {
      if (group.length < 2) continue;
      const survivor = pickSurvivor(group);
      const toDelete = group.filter((l) => l.id !== survivor.id);
      // Safety: never delete a lead with an outcome
      const safeToDelete = toDelete.filter((l) => !l.has_outcome);
      const blocked = toDelete.filter((l) => l.has_outcome);
      if (blocked.length > 0) {
        console.log(
          `  ⚠ group "${key}" has ${blocked.length} sibling(s) with outcomes — they will NOT be deleted`
        );
      }
      if (safeToDelete.length > 0) {
        dupeGroups.push({ key, leads: group, survivor, toDelete: safeToDelete });
      }
    }

    console.log(`\nDuplicate groups found: ${dupeGroups.length}`);
    const totalToDelete = dupeGroups.reduce((s, g) => s + g.toDelete.length, 0);
    console.log(`Leads to delete: ${totalToDelete}`);

    if (dupeGroups.length > 0) {
      console.log("\nTop duplicate groups:");
      for (const g of dupeGroups.slice(0, 20)) {
        const key = g.key.replace("|", " / ");
        console.log(`  "${key}" — ${g.leads.length} leads`);
        console.log(`    KEEP  : ${g.survivor.id} (day${g.survivor.day} ${g.survivor.rep} ${g.survivor.role ?? ""})`);
        for (const d of g.toDelete) {
          console.log(`    DELETE: ${d.id} (day${d.day} ${d.rep} ${d.role ?? ""})`);
        }
      }
    }

    // ── 3. Manufacturer candidates ───────────────────────────────────────────
    const mfrCandidates = rows.filter(
      (r) => looksLikeManufacturer(r.company) && r.review_flag !== "irrelevant_manufacturer"
    );
    console.log(`\nManufacturer flag candidates: ${mfrCandidates.length}`);
    if (mfrCandidates.length > 0) {
      console.log("  Sample:");
      for (const m of mfrCandidates.slice(0, 10)) {
        console.log(`    ${m.id} — ${m.company} (${m.town})`);
      }
    }

    // ── 4. Summary ───────────────────────────────────────────────────────────
    const alreadyFlagged = rows.filter((r) => r.review_flag === "irrelevant_manufacturer").length;
    console.log(`\nAlready flagged irrelevant_manufacturer: ${alreadyFlagged}`);

    if (DRY_RUN) {
      console.log(`
── DRY-RUN COMPLETE (no changes made) ──
To execute, re-run with:
  DATABASE_URL=<url> tsx src/db/dedupeLeads.ts --run
`);
      return;
    }

    // ── 5. Execute dedup ─────────────────────────────────────────────────────
    console.log("\n── EXECUTING ──");
    let deleted = 0;
    let slMigrated = 0;

    for (const group of dupeGroups) {
      const survivorId = group.survivor.id;

      // Migrate sl_flag to survivor if any sibling had it set
      const anySiblingFlagged = group.toDelete.some((l) => l.sl_flag);
      if (anySiblingFlagged && !group.survivor.sl_flag) {
        const combinedNote = [group.survivor.sl_note, ...group.toDelete.filter((l) => l.sl_flag).map((l) => l.sl_note)]
          .filter(Boolean)
          .join(" | ");
        await db`
          update leads set
            sl_flag = true,
            sl_note = ${combinedNote || null}
          where id = ${survivorId}
        `;
        slMigrated++;
      }

      // Delete siblings (safe — no outcome)
      const idsToDelete = group.toDelete.map((l) => l.id);
      await db`delete from leads where id in ${db(idsToDelete)}`;
      deleted += idsToDelete.length;
    }

    console.log(`Deleted ${deleted} duplicate leads (sl_flag migrated in ${slMigrated} cases)`);

    // ── 6. Flag manufacturer leads ───────────────────────────────────────────
    if (mfrCandidates.length > 0) {
      const mfrIds = mfrCandidates.map((l) => l.id);
      await db`
        update leads set review_flag = 'irrelevant_manufacturer'
        where id in ${db(mfrIds)}
      `;
      console.log(`Flagged ${mfrIds.length} manufacturer leads`);
    }

    console.log("\n✓ done");
  } finally {
    await db.end();
  }
}

run().catch((err) => {
  console.error("dedup failed:", err);
  process.exit(1);
});
