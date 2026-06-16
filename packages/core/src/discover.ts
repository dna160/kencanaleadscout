/**
 * Page discovery (microPRD §3a).
 *
 * From a homepage, find the contact/about pages most likely to carry a phone
 * number, staying same-domain and snappy (homepage + up to 3 more).
 */
import { load } from "cheerio";

/** Keywords matched against anchor href OR visible link text. */
const LINK_KEYWORDS = ["kontak", "contact", "hubungi", "tentang", "about"];

/** Paths to try directly even if not linked from the homepage. */
const DIRECT_PATHS = [
  "/kontak",
  "/contact",
  "/contact-us",
  "/hubungi-kami",
  "/tentang-kami",
  "/about",
];

/**
 * Normalize a raw website cell into a fetchable URL.
 * Adds `https://` when no protocol is present and drops a trailing slash.
 * Returns `null` when the value cannot be parsed as a host.
 */
export function normalizeSiteUrl(raw: string): string | null {
  let v = String(raw ?? "").trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  try {
    const u = new URL(v);
    if (!u.hostname.includes(".")) return null;
    u.hash = "";
    let out = u.toString();
    if (out.endsWith("/") && u.pathname === "/") out = out.slice(0, -1);
    return out;
  } catch {
    return null;
  }
}

function sameDomain(a: URL, b: URL): boolean {
  const norm = (h: string) => h.replace(/^www\./i, "").toLowerCase();
  return norm(a.hostname) === norm(b.hostname);
}

/**
 * Given a fetched homepage, return additional same-domain page URLs to crawl
 * (contact/about links + direct path guesses), deduped, capped so that the
 * total page budget (homepage + these) stays within `maxPages`.
 *
 * The homepage URL itself is NOT included in the returned list.
 */
export function discoverPages(homepageUrl: string, homepageHtml: string, maxPages = 4): string[] {
  const base = new URL(homepageUrl);
  const found: string[] = [];
  const seen = new Set<string>([stripTrailingSlash(homepageUrl)]);

  const add = (rawHref: string) => {
    let target: URL;
    try {
      target = new URL(rawHref, base);
    } catch {
      return;
    }
    if (!/^https?:$/.test(target.protocol)) return;
    if (!sameDomain(target, base)) return;
    target.hash = "";
    const key = stripTrailingSlash(target.toString());
    if (seen.has(key)) return;
    seen.add(key);
    found.push(key);
  };

  // 1) Anchors whose href or text mentions a contact/about keyword.
  const $ = load(homepageHtml);
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const text = $(el).text().toLowerCase();
    const hay = (href + " " + text).toLowerCase();
    if (LINK_KEYWORDS.some((k) => hay.includes(k))) add(href);
  });

  // 2) Direct path guesses.
  for (const p of DIRECT_PATHS) add(new URL(p, base).toString());

  // Cap: homepage counts as 1, so we may add at most maxPages - 1 more.
  return found.slice(0, Math.max(0, maxPages - 1));
}

function stripTrailingSlash(u: string): string {
  return u.length > 1 && u.endsWith("/") ? u.slice(0, -1) : u;
}
