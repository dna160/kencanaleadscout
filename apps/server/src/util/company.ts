/**
 * Normalize a company name into a stable join key so the scraper's results
 * (keyed by company) can be matched back to the seeded pilot leads, even when
 * spacing/punctuation/legal-suffix casing differs slightly.
 */
export function normalizeCompany(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
