/**
 * The scraper → cockpit bridge (the dynamic enrichment the pilot asked for).
 *
 * When a scrape finds WhatsApp numbers, we upsert them here keyed by a
 * normalized company name. The cockpit's `/api/leads` left-joins this table so
 * a rep sees a pre-found WA number (badged "scraped") before they even dial.
 *
 * The same normalization is applied here (JS) and in the leads join (SQL:
 * `btrim(regexp_replace(lower(company),'[^a-z0-9]+',' ','g'))`) so they match.
 */
import type { Sql } from "./client.js";
import { normalizeCompany } from "../util/company.js";

export interface EnrichmentInput {
  company: string;
  wa_numbers: string[];
  mobile_numbers: string[];
  source: string;
  confidence: string;
  pages_checked: number;
}

/**
 * Upsert a batch of enrichments. Only rows with a company name AND at least one
 * WA number are stored. Returns the number of rows written.
 */
export async function upsertEnrichments(db: Sql, items: EnrichmentInput[]): Promise<number> {
  const rows = items
    .filter((it) => it.company.trim() && it.wa_numbers.length > 0)
    .map((it) => ({
      company_norm: normalizeCompany(it.company),
      company: it.company.trim(),
      wa_numbers: it.wa_numbers.join(", "),
      mobile_numbers: it.mobile_numbers.join(", "),
      source: it.source,
      confidence: it.confidence,
      pages_checked: it.pages_checked,
    }))
    .filter((r) => r.company_norm.length > 0);

  if (rows.length === 0) return 0;

  // De-dupe by company_norm within the batch (last write wins).
  const byKey = new Map(rows.map((r) => [r.company_norm, r]));
  const deduped = [...byKey.values()];

  await db`
    insert into enrichments ${db(
      deduped,
      "company_norm",
      "company",
      "wa_numbers",
      "mobile_numbers",
      "source",
      "confidence",
      "pages_checked",
    )}
    on conflict (company_norm) do update set
      company        = excluded.company,
      wa_numbers     = excluded.wa_numbers,
      mobile_numbers = excluded.mobile_numbers,
      source         = excluded.source,
      confidence     = excluded.confidence,
      pages_checked  = excluded.pages_checked,
      updated_at     = now()
  `;

  return deduped.length;
}
