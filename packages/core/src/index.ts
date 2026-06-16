/**
 * @kencana/core — the scraper IP.
 *
 * Pure orchestration over discover → fetch → extract → normalize. No web
 * framework, no database, no filesystem. `enrichBatch` is what the server calls.
 */
import pLimit from "p-limit";
import { discoverPages, normalizeSiteUrl } from "./discover.js";
import { extractCandidates } from "./extract.js";
import { fetchPage as defaultFetchPage } from "./fetchPage.js";
import { normalizeNumber } from "./normalize.js";
import type {
  AccountRow,
  Candidate,
  Confidence,
  EnrichOptions,
  EnrichResult,
  Source,
} from "./types.js";

export * from "./types.js";
export { normalizeNumber, normalizeAll, isWaCapable, isValidWaE164 } from "./normalize.js";
export { extractCandidates } from "./extract.js";
export { discoverPages, normalizeSiteUrl } from "./discover.js";
export { fetchPage } from "./fetchPage.js";

const CONFIDENCE_BY_SOURCE: Record<Exclude<Source, "none">, Confidence> = {
  wa_link: "high",
  tel: "medium",
  text_regex: "low",
};

const EMPTY_RESULT = (): EnrichResult => ({
  wa_found: false,
  wa_numbers: [],
  mobile_numbers: [],
  source: "none",
  confidence: "",
  pages_checked: 0,
  error: "",
});

/** Case-insensitively read the `Website` column from a row. */
function readWebsite(row: AccountRow): string {
  for (const key of Object.keys(row)) {
    if (key.trim().toLowerCase() === "website") {
      const v = row[key];
      return v == null ? "" : String(v);
    }
  }
  return "";
}

/**
 * Enrich one account row. Never throws — all failures land in `result.error`.
 */
export async function enrichRow(row: AccountRow, opts: EnrichOptions = {}): Promise<EnrichResult> {
  const result = EMPTY_RESULT();

  const websiteRaw = readWebsite(row);
  if (!websiteRaw.trim()) return result; // no website -> skipped, source none, no error

  const homepageUrl = normalizeSiteUrl(websiteRaw);
  if (!homepageUrl) {
    result.error = "invalid website url";
    return result;
  }

  const timeoutMs = opts.requestTimeoutMs ?? 12_000;
  const maxPages = opts.maxPagesPerSite ?? 4;
  const fetchPage = opts.fetchPage ?? defaultFetchPage;

  const candidates: Candidate[] = [];
  const errors: string[] = [];

  // 1) Homepage.
  const home = await fetchPage(homepageUrl, timeoutMs);
  result.pages_checked = 1;
  if (home.ok) {
    candidates.push(...extractCandidates(home.html));
  } else if (home.error) {
    errors.push(home.error);
  }

  // 2) Discovered contact/about pages (only if homepage gave us HTML).
  if (home.ok && home.html) {
    const pages = discoverPages(homepageUrl, home.html, maxPages);
    for (const url of pages) {
      const page = await fetchPage(url, timeoutMs);
      result.pages_checked += 1;
      if (page.ok) candidates.push(...extractCandidates(page.html));
      else if (page.error) errors.push(page.error);
    }
  }

  // 3) Normalize per source, preserving priority order.
  const bySource: Record<Exclude<Source, "none">, string[]> = {
    wa_link: [],
    tel: [],
    text_regex: [],
  };
  for (const c of candidates) {
    if (c.source === "none") continue;
    const n = normalizeNumber(c.raw);
    if (n) bySource[c.source].push(n);
  }

  const mobiles = dedupe([...bySource.wa_link, ...bySource.tel, ...bySource.text_regex]);
  result.mobile_numbers = mobiles;
  // The team will WhatsApp any validated mobile, so wa_numbers == all mobiles.
  result.wa_numbers = mobiles;
  result.wa_found = mobiles.length > 0;

  // Best source = highest priority that actually yielded a kept number.
  if (bySource.wa_link.length) result.source = "wa_link";
  else if (bySource.tel.length) result.source = "tel";
  else if (bySource.text_regex.length) result.source = "text_regex";
  else result.source = "none";

  result.confidence = result.source === "none" ? "" : CONFIDENCE_BY_SOURCE[result.source];

  // Surface an error only when we found nothing AND something went wrong.
  if (!result.wa_found && errors.length) result.error = errors[0]!;

  return result;
}

/**
 * Enrich many rows with bounded concurrency (microPRD §3d), reporting progress.
 * Returns results aligned 1:1 with the input rows.
 */
export async function enrichBatch(
  rows: AccountRow[],
  opts: EnrichOptions = {},
  onProgress?: (p: { done: number; total: number; found: number }) => void,
): Promise<EnrichResult[]> {
  const total = rows.length;
  const limit = pLimit(opts.concurrency ?? 10);
  const results: EnrichResult[] = new Array(total);
  let done = 0;
  let found = 0;

  await Promise.all(
    rows.map((row, i) =>
      limit(async () => {
        const res = await enrichRow(row, opts).catch((err): EnrichResult => {
          const r = EMPTY_RESULT();
          r.error = err instanceof Error ? err.message : String(err);
          return r;
        });
        results[i] = res;
        done += 1;
        if (res.wa_found) found += 1;
        onProgress?.({ done, total, found });
      }),
    ),
  );

  return results;
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
