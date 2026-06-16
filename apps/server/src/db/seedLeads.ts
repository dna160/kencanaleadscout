/**
 * Seed the `leads` table from data/leads.json (microPRD §14).
 *
 * Safe to run on every boot. Re-running refreshes the enrichable fields
 * (website/email/province) without touching `outcomes`, so the websites you
 * added in the call plan flow through on the next deploy.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Sql } from "./client.js";
import { getSql } from "./client.js";

/** Shape of one record in data/leads.json (short keys). */
interface SeedLead {
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
}

/** json key → leads column (microPRD §14). */
function toRow(l: SeedLead) {
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
  };
}

function loadSeed(): SeedLead[] {
  const path = fileURLToPath(new URL("../../data/leads.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as SeedLead[];
}

export async function seedLeads(db: Sql = getSql()!): Promise<number> {
  const records = loadSeed().map(toRow);
  if (records.length === 0) return 0;

  await db`
    insert into leads ${db(
      records,
      "id",
      "day",
      "rep",
      "priority",
      "company",
      "town",
      "province",
      "landline",
      "ask_for",
      "role",
      "email",
      "website",
    )}
    on conflict (id) do update set
      day = excluded.day,
      rep = excluded.rep,
      priority = excluded.priority,
      company = excluded.company,
      town = excluded.town,
      province = excluded.province,
      landline = excluded.landline,
      ask_for = excluded.ask_for,
      role = excluded.role,
      email = excluded.email,
      website = excluded.website
  `;

  return records.length;
}

// Allow `tsx src/db/seedLeads.ts` / `pnpm seed`.
if (process.argv[1]?.endsWith("seedLeads.ts") || process.argv[1]?.endsWith("seedLeads.js")) {
  const db = getSql();
  if (!db) {
    console.error("DATABASE_URL not set — cannot seed.");
    process.exit(1);
  }
  seedLeads(db)
    .then((n) => {
      console.log(`✓ seeded ${n} leads`);
      return db.end();
    })
    .catch((err) => {
      console.error("seed failed:", err);
      process.exit(1);
    });
}
