/**
 * Phone-number extraction from a fetched page (microPRD §3b).
 *
 * Three priorities, highest confidence first:
 *   1. WhatsApp links            -> confidence "high"   (source "wa_link")
 *   2. tel: links                -> confidence "medium" (source "tel")
 *   3. raw numbers in body text  -> confidence "low"    (source "text_regex")
 *
 * This module only *collects* raw candidates tagged with their source. Whether
 * a candidate is a real WA-capable mobile is decided later in normalize.ts.
 */
import { load } from "cheerio";
import type { Candidate, Source } from "./types.js";

/** Priority 1 — explicit WhatsApp links (run against raw HTML). */
const WA_LINK_PATTERNS: RegExp[] = [
  /wa\.me\/(\+?\d[\d\s\-]+)/gi,
  /api\.whatsapp\.com\/send\?phone=(\+?\d+)/gi,
  /whatsapp:\/\/send\?phone=(\+?\d+)/gi,
];

/** Priority 2 — tel: href links. */
const TEL_LINK_PATTERN = /href=["']tel:(\+?\d[\d\s\-]+)["']/gi;

/** Priority 3 — Indonesian mobile-shaped numbers in visible text. */
const TEXT_NUMBER_PATTERN =
  /(?:\+?62|0)\s?8[\s\-.]?\d{1,4}[\s\-.]?\d{2,4}[\s\-.]?\d{2,5}/g;

function collect(pattern: RegExp, text: string, source: Source, out: Candidate[]): void {
  // Reset lastIndex defensively (patterns are module-level + global).
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const raw = (m[1] ?? m[0]).trim();
    if (raw) out.push({ raw, source });
    if (m.index === pattern.lastIndex) pattern.lastIndex++; // guard against zero-width
  }
}

/**
 * Extract all raw phone candidates from one page.
 *
 * @param html      raw HTML (for href/link patterns)
 * @param visibleText  the page's visible text (for the body-text regex). When
 *                     omitted it is derived from `html` via cheerio.
 */
export function extractCandidates(html: string, visibleText?: string): Candidate[] {
  const out: Candidate[] = [];

  // Priority 1: WhatsApp links anywhere in the HTML.
  for (const p of WA_LINK_PATTERNS) collect(p, html, "wa_link", out);

  // Priority 2: tel: links in the HTML.
  collect(TEL_LINK_PATTERN, html, "tel", out);

  // Priority 3: numbers in visible text only (avoid matching asset URLs, etc.).
  let text = visibleText;
  if (text === undefined) {
    const $ = load(html);
    $("script, style, noscript").remove();
    text = $("body").text() || $.root().text();
  }
  collect(TEXT_NUMBER_PATTERN, text, "text_regex", out);

  return out;
}
