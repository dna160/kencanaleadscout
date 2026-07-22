/**
 * Normalize the free-text `area` used by the retail Visitation module.
 *
 * Reps type the area by hand, so it collects trailing punctuation and common
 * abbreviations ("Bekasi.", "Jaktim", "Tangsel", "Tabgerang"). This maps the
 * known variants onto their canonical area name and Title-Cases the rest.
 * Unknown areas are left as-is (only cleaned of trailing punctuation/casing) —
 * nothing is ever collapsed into a catch-all.
 */

/** Known abbreviations / typos (collapsed key) → canonical area. */
const AREA_ALIASES: Record<string, string> = {
  bekasi: "Bekasi", // also catches "Bekasi." after trailing-punctuation strip
  jaktim: "Jakarta Timur",
  jaksel: "Jakarta Selatan",
  jakpus: "Jakarta Pusat",
  jakbar: "Jakarta Barat",
  jakut: "Jakarta Utara",
  tabgerang: "Tangerang",
  tangsel: "Tangerang Selatan",
  tangesel: "Tangerang Selatan",
};

/** Collapse to a comparison key: lowercase, strip all non-alphanumerics. */
function key(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function normalizeRetailArea(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
  if (!s) return "";
  const alias = AREA_ALIASES[key(s)];
  if (alias) return alias;
  // Default: Title-Case each word (matches the module's existing behavior).
  return s.replace(/\b\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}
