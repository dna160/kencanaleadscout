/**
 * Page fetching with timeout + one retry (microPRD §3d).
 *
 * - Per-request timeout (default 12s), 1 retry on failure.
 * - Realistic User-Agent.
 * - Follows redirects manually (http→https, www, etc.) up to a small cap so we
 *   stay version-agnostic across undici releases.
 * - Skips non-HTML responses; caps the body at ~2MB.
 * - Never throws transport errors to the caller — returns a FetchedPage with
 *   `ok: false` and an `error` string so a single bad site never crashes a batch.
 */
import { request } from "undici";
import type { FetchedPage } from "./types.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024; // ~2MB
const MAX_REDIRECTS = 5;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

async function fetchOnce(startUrl: string, timeoutMs: number): Promise<FetchedPage> {
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await request(currentUrl, {
      method: "GET",
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "id-ID,id;q=0.9,en;q=0.8",
      },
    });

    const status = res.statusCode;

    // Destroying/aborting an undici body emits a benign RequestAbortedError on
    // the stream. Swallow it so an early abort never crashes the process.
    res.body.on("error", () => {});

    // Follow redirects manually.
    if (REDIRECT_CODES.has(status)) {
      const location = headerValue(res.headers["location"]);
      res.body.destroy();
      if (!location || hop === MAX_REDIRECTS) {
        return { url: startUrl, finalUrl: currentUrl, html: "", ok: false, error: `too many redirects` };
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (status >= 400) {
      res.body.destroy();
      return { url: startUrl, finalUrl: currentUrl, html: "", ok: false, error: `HTTP ${status}` };
    }

    const contentType = headerValue(res.headers["content-type"]);
    if (contentType && !/html|text\/plain|xml/i.test(contentType)) {
      res.body.destroy();
      return { url: startUrl, finalUrl: currentUrl, html: "", ok: false, error: `non-HTML (${contentType})` };
    }

    // Read body up to the cap, then abort the rest.
    let received = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) {
      const buf = chunk as Buffer;
      received += buf.length;
      if (received > MAX_BODY_BYTES) {
        chunks.push(buf.subarray(0, buf.length - (received - MAX_BODY_BYTES)));
        res.body.destroy();
        break;
      }
      chunks.push(buf);
    }

    return { url: startUrl, finalUrl: currentUrl, html: Buffer.concat(chunks).toString("utf8"), ok: true };
  }

  return { url: startUrl, finalUrl: currentUrl, html: "", ok: false, error: "too many redirects" };
}

/**
 * Fetch a page with a single retry. Resolves (never rejects) to a FetchedPage.
 */
export async function fetchPage(url: string, timeoutMs = 12_000): Promise<FetchedPage> {
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetchOnce(url, timeoutMs);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  return { url, finalUrl: url, html: "", ok: false, error: lastErr || "fetch failed" };
}
