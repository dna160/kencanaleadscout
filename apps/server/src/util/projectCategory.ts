/**
 * Canonicalize the free-text `category` used by the Project Visitation module.
 *
 * Reps type the category by hand, so the raw column ends up sprinkled with case
 * variants ("HO" / "ho"), one-off project names ("Project JAC Blibli Tower")
 * and off-list values ("Cafe"). Left alone, the insights heatmap groups by the
 * raw string and splits a single bucket across several rows/columns.
 *
 * This maps any input onto the canonical Project category set so the heatmap
 * (area × category) stays clean. Anything we can't confidently place — including
 * specific project names and stray labels — falls back to "Project", which is
 * the catch-all bucket for the team.
 */

/** Canonical categories, in display order, matching the migrate.ts seed. */
export const PROJECT_CATEGORIES = [
  "Project",
  "HO",
  "Aplikator",
  "Arsitek",
  "Design & Build",
  "Build Contractor",
] as const;

export type ProjectCategory = (typeof PROJECT_CATEGORIES)[number];

/** Collapse to a comparison key: lowercase, strip all non-alphanumerics. */
function key(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Alias → canonical, keyed by the collapsed form. Only confident synonyms are
 * listed here; everything else defaults to "Project".
 */
const ALIASES: Record<string, ProjectCategory> = {
  // HO
  ho: "HO",
  headoffice: "HO",
  kantorpusat: "HO",
  // Aplikator
  aplikator: "Aplikator",
  applicator: "Aplikator",
  aplicator: "Aplikator",
  // Arsitek
  arsitek: "Arsitek",
  architect: "Arsitek",
  arsitektur: "Arsitek",
  // Design & Build
  designbuild: "Design & Build",
  designandbuild: "Design & Build",
  db: "Design & Build",
  dnb: "Design & Build",
  // Build Contractor
  buildcontractor: "Build Contractor",
  contractor: "Build Contractor",
  kontraktor: "Build Contractor",
  kontraktorbangunan: "Build Contractor",
  builder: "Build Contractor",
  maincontractor: "Build Contractor",
  generalcontractor: "Build Contractor",
  // Project (explicit synonyms; unmatched input also lands here)
  project: "Project",
  projek: "Project",
  proyek: "Project",
};

/**
 * Map any raw category string onto a canonical Project category.
 * Returns "Project" for blank, unknown, or off-list input.
 */
export function normalizeProjectCategory(raw: string | null | undefined): ProjectCategory {
  const k = key(String(raw ?? ""));
  if (!k) return "Project";
  return ALIASES[k] ?? "Project";
}
