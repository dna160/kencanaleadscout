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

const PRIORITY_ORDER: Record<string, number> = { P1: 1, P2: 2, P3: 3 };
const BAND_ORDER:     Record<string, number> = { A:  1, B:  2, C:  3 };

function timingOrder(t: string | null): number {
  if (!t) return 4;
  if (t.startsWith("HOT"))  return 1;
  if (t.startsWith("WARM")) return 2;
  if (t.startsWith("COLD")) return 3;
  return 4;
}

function cleanPhone(phone: string | null): string {
  return phone ? phone.replace(/\D/g, "") : "";
}

export async function seedSyHunter(db: Sql): Promise<{ projects: number; contacts: number }> {
  const projects: RawProject[] = JSON.parse(readFileSync(resolve(DATA, "sy_projects.json"), "utf8"));
  const contacts: RawContact[] = JSON.parse(readFileSync(resolve(DATA, "sy_contacts.json"), "utf8"));

  // Upsert projects
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
        rank        = excluded.rank,
        score       = excluded.score,
        band        = excluded.band,
        timing      = excluded.timing,
        status      = excluded.status,
        project_url = excluded.project_url
    `;
  }

  // Build project-name → id map
  const projRows = await db`select id, project_name from sy_projects`;
  const projMap  = new Map<string, number>(projRows.map((r) => [r.project_name as string, Number(r.id)]));

  // Skip if already seeded with dedup applied (day column populated)
  const cntRows = await db`select count(*)::int as cnt from sy_contacts where day is not null`;
  if (Number(cntRows[0]?.cnt ?? 0) > 0) {
    const totalRows = await db`select count(*)::int as cnt from sy_contacts where active = true`;
    return { projects: projects.length, contacts: Number(totalRows[0]?.cnt ?? 0) };
  }

  // Sort: P1→P2→P3, A→B→C, HOT→WARM→COLD, score desc
  const sorted = [...contacts].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 9, pb = PRIORITY_ORDER[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    const ba = BAND_ORDER[a.band ?? ""] ?? 9, bb = BAND_ORDER[b.band ?? ""] ?? 9;
    if (ba !== bb) return ba - bb;
    const ta = timingOrder(a.timing), tb = timingOrder(b.timing);
    if (ta !== tb) return ta - tb;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  // Deduplicate by normalized phone — keep highest-priority (first in sorted order)
  const seenPhones = new Set<string>();
  type Enriched = RawContact & { phone_clean: string | null; active: boolean; day: number | null };
  const deduped: Enriched[] = sorted.map((c) => {
    const pc = cleanPhone(c.phone);
    const isActive = !pc || !seenPhones.has(pc);
    if (pc) seenPhones.add(pc);
    return { ...c, phone_clean: pc || null, active: isActive, day: null };
  });

  // Assign day 1–10 to active contacts in sorted order
  const active = deduped.filter((c) => c.active);
  const perDay = Math.ceil(active.length / 10);
  let dayIdx = 0;
  for (const c of active) {
    c.day = Math.min(10, Math.floor(dayIdx / perDay) + 1);
    dayIdx++;
  }

  // Full seed — clear first
  await db`delete from sy_contacts`;

  for (const c of deduped) {
    const resolvedProjId = c.project_name ? (projMap.get(c.project_name) ?? null) : null;
    await db`
      insert into sy_contacts
        (project_id, priority, band, score, company_name, role, contact_name, position,
         phone, phone_clean, email, project_name, province, town, timing, source, day, active)
      values
        (${resolvedProjId}, ${c.priority}, ${c.band}, ${c.score}, ${c.company_name},
         ${c.role}, ${c.contact_name}, ${c.position}, ${c.phone}, ${c.phone_clean},
         ${c.email}, ${c.project_name}, ${c.province}, ${c.town}, ${c.timing},
         ${c.source}, ${c.day}, ${c.active})
    `;
  }

  return { projects: projects.length, contacts: active.length };
}
