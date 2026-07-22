/**
 * Canonicalize the free-text `category` used by the Mirae Visitation module.
 *
 * Canonical set (the only categories the team uses):
 *   Aplikator, Architect, Designer, Kontraktor, Project, Toko, Workshop
 * plus "Other" as a fallback bucket for input that matches none of them.
 *
 * Reps type the category by hand, so the raw column fills with case variants,
 * synonyms and typos ("ARCHITECT", "arsitek", "ARCGITECT", "INTERIOR DESIGNER",
 * "DESAINER", "design and build"). This maps any input onto the canonical set
 * so the insights heatmap groups cleanly.
 */

/** Canonical categories, in display order. */
export const MIRAE_CATEGORIES = [
  "Toko",
  "Workshop",
  "Aplikator",
  "Kontraktor",
  "Architect",
  "Designer",
  "Project",
  "Other",
] as const;

export type MiraeCategory = (typeof MIRAE_CATEGORIES)[number];

/** The seven categories reps can pick (Other is a fallback, not a choice). */
export const MIRAE_ACTIVE_CATEGORIES = MIRAE_CATEGORIES.filter((c) => c !== "Other");

/** Collapse to a comparison key: lowercase, strip all non-alphanumerics. */
function key(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Exact-token aliases (collapsed form) → canonical. */
const ALIASES: Record<string, MiraeCategory> = {
  toko: "Toko", store: "Toko", shop: "Toko", retail: "Toko",
  workshop: "Workshop", bengkel: "Workshop",
  aplikator: "Aplikator", applicator: "Aplikator", aplicator: "Aplikator",
  kontraktor: "Kontraktor", contractor: "Kontraktor",
  maincontractor: "Kontraktor", generalcontractor: "Kontraktor",
  project: "Project", projek: "Project", proyek: "Project",
  architect: "Architect", arsitek: "Architect", arsitektur: "Architect",
  designer: "Designer", desainer: "Designer", interiordesigner: "Designer",
};

/**
 * Map any raw category string onto a canonical Mirae category.
 *
 * Order matters: "design and build" is treated as a contractor before the
 * architect/designer checks, per the team's convention.
 */
export function normalizeMiraeCategory(raw: string | null | undefined): MiraeCategory {
  const k = key(String(raw ?? ""));
  if (!k) return "Other";
  if (ALIASES[k]) return ALIASES[k];

  // Design & build shops are contractors.
  if (k.includes("build")) return "Kontraktor";
  // Architects / architecture studios (many hand-typed spellings & typos).
  if (k.includes("arsitek") || k.includes("architec") || k.includes("arcgi") ||
      k.includes("studio") || k.includes("atelier") ||
      k.includes("assosiate") || k.includes("associate")) return "Architect";
  // Interior / graphic / creative designers.
  if (k.includes("interior") || k.includes("desain") ||
      k.includes("design") || k.includes("creative")) return "Designer";
  if (k.includes("kontraktor") || k.includes("contractor")) return "Kontraktor";
  return "Other";
}
