import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import type { Sql } from "./client.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA   = resolve(__dir, "../../data");

interface RawProject {
  rank: number | null; score: number | null; band: string | null;
  project_name: string; timing: string | null; fit: string | null;
  floor_area_m2: number | null; value_b_idr: number | null;
  province: string | null; town: string | null; stage: string | null;
  status: string | null; start_date: string | null; project_url: string | null;
  segment: string | null; is_captive: boolean;
}
interface RawContact {
  priority: string; band: string | null; score: number | null;
  company_name: string | null; role: string | null; contact_name: string | null;
  position: string | null; phone: string | null; email: string | null;
  project_name: string | null; project_ref: number | null;
  province: string | null; town: string | null; timing: string | null;
  source: string;
}

export async function seedSyHunter(db: Sql): Promise<{ projects: number; contacts: number }> {
  const projects: RawProject[] = JSON.parse(readFileSync(resolve(DATA, "sy_projects.json"), "utf8"));
  const contacts: RawContact[] = JSON.parse(readFileSync(resolve(DATA, "sy_contacts.json"), "utf8"));

  // Upsert projects (keyed on normalised project_name)
  for (const p of projects) {
    await db`
      insert into sy_projects
        (rank, score, band, project_name, timing, fit, floor_area_m2, value_b_idr,
         province, town, stage, status, start_date, project_url, segment, is_captive)
      values
        (${p.rank}, ${p.score}, ${p.band}, ${p.project_name}, ${p.timing}, ${p.fit},
         ${p.floor_area_m2}, ${p.value_b_idr}, ${p.province}, ${p.town},
         ${p.stage}, ${p.status}, ${p.start_date}, ${p.project_url},
         ${p.segment}, ${p.is_captive})
      on conflict (lower(trim(project_name))) do update set
        rank          = excluded.rank,
        score         = excluded.score,
        band          = excluded.band,
        timing        = excluded.timing,
        status        = excluded.status,
        project_url   = excluded.project_url
    `;
  }

  // Build project-name → id map for FK linking
  const projRows = await db`select id, project_name from sy_projects`;
  const projMap = new Map<string, number>(projRows.map((r) => [r.project_name as string, Number(r.id)]));

  // Upsert contacts — we treat (company_name, project_name, role) as a natural key.
  // The table has no unique constraint, so skip already-seeded contacts by checking count.
  const cntRows = await db`select count(*)::int as cnt from sy_contacts`;
  const cnt = cntRows[0]?.cnt;
  if (Number(cnt ?? 0) >= contacts.length) {
    return { projects: projects.length, contacts: Number(cnt ?? 0) };
  }

  // Full re-seed when count is lower than expected (first boot or partial seed)
  await db`delete from sy_contacts`;
  for (const c of contacts) {
    const resolvedProjId = c.project_name ? (projMap.get(c.project_name) ?? null) : null;
    await db`
      insert into sy_contacts
        (project_id, priority, band, score, company_name, role, contact_name, position,
         phone, email, project_name, province, town, timing, source)
      values
        (${resolvedProjId}, ${c.priority}, ${c.band}, ${c.score}, ${c.company_name},
         ${c.role}, ${c.contact_name}, ${c.position}, ${c.phone}, ${c.email},
         ${c.project_name}, ${c.province}, ${c.town}, ${c.timing}, ${c.source})
    `;
  }

  return { projects: projects.length, contacts: contacts.length };
}
