/**
 * Canonicalize the free-text `category` used by the Mirae Visitation module.
 *
 * Reps type the category by hand, so the raw column ends up full of case
 * variants ("Toko" / "toko"), synonyms ("bengkel" for Workshop), and one-off
 * / random labels. Left alone, the insights heatmap groups by the raw string
 * and splits a single bucket across many rows/columns.
 *
 * This maps any input onto the canonical Mirae category set. Anything we can't
 * confidently place — including random or blank input — falls back to "Other",
 * which is Mirae's existing catch-all bucket.
 */

/** Canonical categories, in display order, matching the migrate.ts seed. */
export const MIRAE_CATEGORIES = [
  "Toko",
  "Workshop",
  "Aplikator",
  "Kontraktor",
  "Distributor",
  "Advertising/Signage",
  "Arsitek",
  "Project",
  "Other",
] as const;

export type MiraeCategory = (typeof MIRAE_CATEGORIES)[number];

/** Collapse to a comparison key: lowercase, strip all non-alphanumerics. */
function key(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Alias (collapsed form) → canonical. Only confident synonyms are listed;
 * everything else defaults to "Other".
 */
const ALIASES: Record<string, MiraeCategory> = {
  // Toko (retail / hardware store)
  toko: "Toko",
  store: "Toko",
  shop: "Toko",
  retail: "Toko",
  tokobangunan: "Toko",
  tokomaterial: "Toko",
  tokobesi: "Toko",
  tb: "Toko",
  // Workshop / bengkel
  workshop: "Workshop",
  bengkel: "Workshop",
  ws: "Workshop",
  // Aplikator
  aplikator: "Aplikator",
  applicator: "Aplikator",
  aplicator: "Aplikator",
  // Kontraktor
  kontraktor: "Kontraktor",
  contractor: "Kontraktor",
  maincontractor: "Kontraktor",
  generalcontractor: "Kontraktor",
  // Distributor
  distributor: "Distributor",
  distributur: "Distributor",
  subdistributor: "Distributor",
  agen: "Distributor",
  grosir: "Distributor",
  supplier: "Distributor",
  // Advertising / Signage
  advertising: "Advertising/Signage",
  signage: "Advertising/Signage",
  advertisingsignage: "Advertising/Signage",
  reklame: "Advertising/Signage",
  billboard: "Advertising/Signage",
  sign: "Advertising/Signage",
  signmaker: "Advertising/Signage",
  percetakan: "Advertising/Signage",
  digitalprinting: "Advertising/Signage",
  // Arsitek (architect / designer / design-&-build — reps type many variants)
  arsitek: "Arsitek",
  arsitektur: "Arsitek",
  architect: "Arsitek",
  designer: "Arsitek",
  desainer: "Arsitek",
  interiordesigner: "Arsitek",
  interiordesign: "Arsitek",
  // Project
  project: "Project",
  projek: "Project",
  proyek: "Project",
  // Other (explicit synonyms; unmatched input also lands here)
  other: "Other",
  others: "Other",
  lainnya: "Other",
  lainlain: "Other",
  dll: "Other",
  none: "Other",
};

/**
 * Map any raw category string onto a canonical Mirae category.
 * Returns "Other" for blank, unknown, or off-list input.
 */
export function normalizeMiraeCategory(raw: string | null | undefined): MiraeCategory {
  const k = key(String(raw ?? ""));
  if (!k) return "Other";
  if (ALIASES[k]) return ALIASES[k];
  // Architect/designer segment is hand-typed with many spellings & typos
  // ("ARCGITECT", "Arsitec design and built", "INTERIOR DESIGNER"). Catch the
  // common stems so they land in Arsitek rather than Other.
  if (k.startsWith("arsi") || k.startsWith("arch") || k.startsWith("arcgi")) return "Arsitek";
  if (k.includes("desain") || k.includes("designer")) return "Arsitek";
  return "Other";
}
