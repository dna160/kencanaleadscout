# Kencana LeadScout — WA-Harvest

One small app, two surfaces, one Fastify service:

- **Part A — Scraper (`/scraper`)** — visit Indonesian construction company websites, extract WhatsApp-capable mobile numbers, download an enriched spreadsheet.
- **Part B — Call Dashboard** — a mobile-first cockpit (`/calls`) reps use to work their daily lead list one lead per screen, plus a live champion dashboard (`/champion`) tracking capture rate across reps in real time.

The two surfaces share a monorepo and a single Docker image. Part A is database-free; Part B uses Postgres for cross-device sync.

---

## Architecture

```
wa-harvest/  (pnpm workspaces)
├── packages/core/          THE IP — pure, unit-tested, zero web/db deps
│   ├── normalize.ts        libphonenumber-js validate → E.164 (mobiles only)
│   ├── extract.ts          wa.me / tel: / body-text regex extraction
│   ├── discover.ts         contact/about page discovery (same-domain)
│   ├── fetchPage.ts        undici fetch w/ timeout + 1 retry + 2MB cap
│   └── index.ts            enrichRow() / enrichBatch()
└── apps/server/            Fastify service (both surfaces + all APIs)
    ├── src/routes/         [A] enrich/progress/result · [B] leads/outcome/stats
    ├── src/db/             [B] client / migrate / seedLeads / enrichments
    ├── src/io/             [A] read/write xlsx+csv
    ├── data/leads.json     [B] 600 pilot leads (enriched w/ website+email+province)
    └── public/             index · scraper · calls · champion (vanilla HTML/JS)
```

`packages/core` stays pure so it can drop into LeadScout unchanged.

### The scraper → cockpit bridge (dynamic enrichment)

The pilot wanted scraped WhatsApp numbers to reach reps *before they dial*. When
a scrape finishes, found numbers are upserted into an `enrichments` table keyed
by a **normalized company name**. The cockpit's `/api/leads` left-joins that
table, so a rep opening a matching company sees the WhatsApp field **pre-filled
and badged `scraped`**. The same normalization runs in JS (on write) and SQL (on
read) so they always match.

### Cross-checking: LinkedIn first, WhatsApp as the add-on

Per pilot direction, the cockpit's primary verification affordance is a
**"Verify on LinkedIn"** deep-link (search by contact name + company) sitting
beside the company website and email. WhatsApp capture is the value-add on top.
We deliberately do **not** scrape LinkedIn — that needs auth and breaks their
ToS; a deep-link is the safe, standard pattern.

---

## Quick start (local)

Prereqs: Node 20+ and pnpm 10.

```bash
pnpm install
pnpm -r build

# Part A only (no database needed):
pnpm start                 # → http://localhost:8080/scraper

# Full app (Part A + B): point DATABASE_URL at a Postgres, then:
cp .env.example .env       # edit DATABASE_URL
pnpm dev                   # tsx watch, migrates + seeds on boot
```

Or bring up the whole stack (Postgres + app) with Docker:

```bash
docker compose up --build  # → http://localhost:8080
```

### Scripts

| Command | What |
|---|---|
| `pnpm dev` | Run the server with hot reload (loads `.env`). |
| `pnpm build` | Compile `packages/core` then `apps/server`. |
| `pnpm start` | Run the compiled server. |
| `pnpm test` | Run the core unit tests (normalize + extract). |
| `pnpm typecheck` | Type-check both packages. |
| `pnpm seed` | Re-seed `leads` from `data/leads.json`. |

---

## APIs

**Part A**
- `POST /api/enrich` — multipart upload (`.xlsx`/`.csv` with a `Website` column) → `{ jobId, total }`.
- `GET /api/progress/:id` — SSE: `{ done, total, found, status }` ~every second.
- `GET /api/result/:id` — streams the enriched `.xlsx`.

**Part B**
- `GET /api/leads?rep=Rep%20A&day=1` — the rep's leads for a day, with outcome + scraped enrichment.
- `POST /api/outcome` — upsert a call result. `won_wa` requires a valid `+628…` number.
- `GET /api/stats` — champion aggregates (totals, by_rep, by_day, by_tier, recent).
- `GET /health` — `{ ok, db }`.

### Output contract (Part A)

Input rows + appended columns: `wa_found`, `wa_numbers` (E.164, comma-sep),
`mobile_numbers`, `source` (`wa_link`|`tel`|`text_regex`|`none`), `confidence`
(`high`|`medium`|`low`), `pages_checked`, `error`.

Only WhatsApp-capable Indonesian mobiles survive normalization — landlines
(`+6221…`) are discarded because they can't receive WhatsApp.

---

## Environment

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Injected by Railway. |
| `CONCURRENCY` | `10` | Sites scraped in parallel. |
| `REQUEST_TIMEOUT_MS` | `12000` | Per-request fetch timeout. |
| `MAX_PAGES_PER_SITE` | `4` | Homepage + 3 discovered pages. |
| `DATABASE_URL` | — | Postgres (Part B). Absent ⇒ Part B returns 503, Part A still works. |

---

## Deploy to Railway

1. Push this repo; Railway builds via the `Dockerfile` (set by `railway.toml`).
2. Add the **Postgres** plugin — `DATABASE_URL` is auto-injected.
3. On boot the server runs migrations and seeds the 600 leads idempotently.
4. Open the public URL → `/calls` (reps) and `/champion` (champion).

```bash
railway up
```

## Tests

```bash
pnpm test
```

`normalize.test.ts` covers the make-or-break §7 cases (valid mobiles in/landlines
out). `extract.test.ts` proves a `wa.me` float button is read at `confidence:
high` against a saved HTML fixture.
