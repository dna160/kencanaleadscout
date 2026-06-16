/**
 * Shared types for the WhatsApp-harvest core.
 *
 * This package is intentionally free of any web-framework, database, or
 * filesystem dependency so it can be unit-tested in isolation and later
 * dropped into LeadScout unchanged.
 */

/** Confidence in a discovered number, highest first. */
export type Confidence = "high" | "medium" | "low";

/** Where a number was found. `none` => nothing usable on the site. */
export type Source = "wa_link" | "tel" | "text_regex" | "none";

/**
 * One input account row. The only column the scraper requires is `Website`
 * (matched case-insensitively by the IO layer). Every other column is carried
 * through to the output untouched.
 */
export type AccountRow = Record<string, string | number | boolean | null | undefined>;

/** A raw phone candidate captured during extraction, before normalization. */
export interface Candidate {
  /** Raw matched string, e.g. "0812-3456-7890" or "wa.me/62812...". */
  raw: string;
  /** Which extraction priority produced it. */
  source: Source;
}

/** The enrichment verdict for a single account. */
export interface EnrichResult {
  /** TRUE when at least one WA-capable number was found. */
  wa_found: boolean;
  /** Numbers we will WhatsApp, normalized E.164, deduped. */
  wa_numbers: string[];
  /** Superset: every validated mobile found (E.164, deduped). */
  mobile_numbers: string[];
  /** Best (highest-priority) source that yielded a kept number. */
  source: Source;
  /** Confidence tied to `source`; empty string when nothing was found. */
  confidence: Confidence | "";
  /** How many pages were fetched for this site. */
  pages_checked: number;
  /** Fetch/parse error string, else empty. Never throws to the caller. */
  error: string;
}

/** Options threaded through a batch run (env-tunable at the edges). */
export interface EnrichOptions {
  /** Per-request timeout in ms. */
  requestTimeoutMs?: number;
  /** Homepage + N discovered pages. */
  maxPagesPerSite?: number;
  /** Parallel sites in flight. */
  concurrency?: number;
  /** Injected for tests; defaults to the real undici fetcher. */
  fetchPage?: (url: string, timeoutMs: number) => Promise<FetchedPage>;
}

/** Result of fetching one page. */
export interface FetchedPage {
  url: string;
  /** Final URL after redirects. */
  finalUrl: string;
  /** Raw HTML body (capped). Empty on non-HTML or error. */
  html: string;
  /** True when the response was HTML and within the size cap. */
  ok: boolean;
  /** Populated on transport/parse failure. */
  error?: string;
}
