# Retail Visitation Log — Module D

This document covers the **retail** visitation-log system: the field-sales module
where reps log store visits/calls, work a daily portfolio ("My Day"), track
accounts through a pipeline, and management reviews activity via Rack-up and
Insights. This is the original/default module (routes and tables have no
prefix). Two structurally-identical clones exist for other business lines —
**Mirae** (`mirae_*` tables, `/mirae-*` routes) and **Project** (`project_*`
tables, `/project-*` routes) — built by literally duplicating this module's
schema and endpoints. They are not covered in depth here except where noted.

Server: Fastify 5, single service, `apps/server/src/index.ts`. Pages are
static HTML+vanilla JS served via `sendFile()`; each page talks to its own
small set of JSON APIs. DB: Postgres via `postgres.js` (`porsager/postgres`) —
**all bigserial IDs come back from the driver as strings**, never numbers.

---

## 1. Page map

| Route | File | Purpose |
|---|---|---|
| `/visits` | `visits.html` | Log a visit / phone call / escalation (the form reps fill after every stop) |
| `/visits-rack` | `visits-rack.html` | "Rack-up" — management's live activity board: today's totals, per-rep leaderboard, 7-day trend, full kunjungan table, pending escalations |
| `/visits-rep` | `visits-rep.html` | Single-rep profile page: recent visits + AI-generated weekly synthesis |
| `/visits-insights` | `visits-insights.html` | Insights dashboard — team leaderboard, area×category heatmap, per-rep scorecards/archetypes |
| `/myday` | `myday.html` | Rep's daily cockpit — portfolio chips, overdue/today follow-ups, today's visits, full account list |
| `/account` | `account.html` | Single account (customer) detail — pipeline stage, action timeline, stage history, scheduled follow-ups |
| `/salespeople` | `salespeople.html` | Admin: register/edit/deactivate sales reps |

All are registered as plain `app.get(path, ...)` static-file routes in
`apps/server/src/index.ts:86-92` (no client-side router, no build step —
pages are hand-written HTML files with inline `<script>`).

---

## 2. Data model

Defined in `apps/server/src/db/migrate.ts` (idempotent `create table if not
exists` + `alter table add column if not exists`, run on every boot — no
separate migration files/tool).

### `salespeople`
Field-rep registry. Never hard-deleted (rows are FK'd from `visits`,
`customers.owner_id`, etc.) — deactivated via `active = false` instead.

| column | type | notes |
|---|---|---|
| id | bigserial PK | |
| full_name | text | |
| code | text unique | short code, e.g. `HNF` |
| phone_e164 | text | |
| default_area | text | |
| active | boolean, default true | |
| created_at | timestamptz | |

### `customers` (= "accounts" in pipeline UI)
Master customer/account record. One row per unique `(store_name, area)`
(case-insensitive, trimmed — enforced by unique index `customers_norm`).

| column | type | notes |
|---|---|---|
| id | bigserial PK | |
| store_name | text | |
| category | text | free text, drives `account_type` derivation |
| area | text | Title-cased on write |
| address, postal_code | text | |
| first_seen_at | timestamptz | |
| created_by | bigint → salespeople | |
| **account_type** | text, default `repeating` | `'project'` or `'repeating'` — derived at visit-creation time from `category` (`Kontraktor`, `Aplikator`, `Project` → project; everything else → repeating) |
| **stage** | text, default `aktif` | pipeline stage — see §3 |
| **owner_id** | bigint → salespeople | the account's assigned rep |
| **last_contact_at** | timestamptz | bumped by every visit/action; drives cadence engine and "days since" badges |

### `visits`
The append-only visit log. `visited_at` is server-stamped on submit and is
immutable to reps (only a Handler override via `PATCH /api/visits/:id` can
change it, and that write is audited).

| column | type | notes |
|---|---|---|
| id | bigserial PK | |
| salesperson_id | bigint → salespeople, not null | |
| customer_id | bigint → customers, nullable | set if the store matched/created a customer row |
| pic_name | text | person-in-charge contacted |
| store_name, category, address, area, postal_code | text | denormalized copy of what was submitted, independent of `customers` |
| customer_type | text, check `new`\|`old` | |
| notes | text | free text; also fuels the "notes discipline" insight metric |
| activity_type | text, default `kunjungan` | `kunjungan` \| `telepon` (escalations do NOT create a visit row — see `escalations`) |
| visited_at | timestamptz | server-stamped |
| source | text, default `app` | |

Indexes: `(salesperson_id, visited_at desc)`, `(area)`, `(customer_type)`.

### `visit_audits`
Audit trail for Handler overrides of `visited_at` (field/old_value/new_value/
changed_by/changed_at). Written by `PATCH /api/visits/:id`.

### `visit_photos`
Up to 5 photos per visit, stored as `bytea` directly in Postgres (not S3/blob
storage). Client-side compression (canvas resize to max 1600px, JPEG q=0.82)
happens before upload. Served back via `GET /api/photos/:id`.

### `actions`
Every touchpoint against an account — a superset of visits, also covering
non-visit events like received orders.

| column | notes |
|---|---|
| account_id → customers | |
| salesperson_id → salespeople | |
| action_type | `kunjungan` \| `telepon` \| `received_order` \| `note` (received_order requires `invoice_number`) |
| invoice_number, notes | |
| actioned_at | |

`POST /api/visits` auto-inserts a matching `actions` row for every visit
(enriched with PIC name in the notes). `account.html` can also record a
one-off action directly (e.g. logging a received order without a full visit
form).

### `stage_history`
Append-only audit of every pipeline stage transition: `account_id,
old_stage, new_stage, changed_by, changed_at`. Written whenever `customers.stage`
changes, whether from the visit form's inline stage picker, the account
page's stage selector, or the automatic cadence engine.

### `scheduled_actions`
Rep-created follow-up reminders: `account_id, salesperson_id, action_type
(default 'followup'), scheduled_for, notes, completed_at`. Drives My Day's
"Terlambat" (overdue) / "Hari Ini" (today) / upcoming-7-day buckets.
`completed_at is null` = still open; marking done is a `PATCH
/api/scheduled/:sid/done`.

### `escalations`
For leads a rep found but can't personally visit/find contact info for — a
separate desk ("Tim Eskalasi") researches and resolves it, then the result
surfaces back to the rep's My Day.

| column | notes |
|---|---|
| salesperson_id → salespeople | who raised it |
| store_name, category, area, address, notes | lead info as submitted |
| status | `pending` → `resolved` |
| resolved_contact_name/phone/notes, resolved_by, resolved_at | filled in on resolve |
| followed_up_at | set when the rep acknowledges the resolution (removes it from My Day) |

Escalations do **not** create a `visits` or `customers` row — they're a
separate lightweight queue, submitted from `visits.html`'s third activity-type
toggle.

### `visit_lists`
Managed enum values for the visit form's Category and Area fields (so they
render as datalists with autocomplete but aren't hardcoded).
`(id, type ['category'|'area'], value, active)`, unique on
`(type, lower(value))`. Seeded once with a starter set of Jabodetabek areas
and common categories.

---

## 3. Pipeline stages

`account_type` is derived once, at first-visit time, from `category`:
- `category ∈ {Kontraktor, Aplikator, Project}` → **project**
- anything else → **repeating**

Each type has its own stage set (enforced server-side in both
`visits.ts` and `accounts.ts`):

- **project**: `prospek → penawaran → negosiasi → won | gugur`
- **repeating**: `aktif → perlu_followup → at_risk → hibernasi`, plus
  `repeat_order` (added for accounts that have converted to a recurring
  reorder pattern — selectable from the visit form's stage picker and shown
  as a distinct badge in My Day / account views)

### Automatic cadence engine (`accounts.ts: startCadenceEngine`)
Runs once on boot, then hourly, for **repeating** accounts only (never
touches `hibernasi` or project accounts):
- `aktif → perlu_followup` if `last_contact_at` is null or > 14 days old
- `perlu_followup → at_risk` if > 28 days old

Each auto-transition writes a `stage_history` row with `changed_by = null`
(distinguishing system-driven changes from rep-driven ones).

Note: `insights.ts` computes a *different*, purely presentational "health"
bucketing for the heatmap/scorecards (based on `last visit` recency: <10d
aktif, <14d perlu_followup, <17d at_risk, else hibernasi) — this is not
written back to `customers.stage`, it's just a display-time recompute with
tighter thresholds than the cadence engine's stored-stage thresholds.

---

## 4. Page-by-page feature breakdown

### `visits.html` — the visit-logging form
- Three activity-type toggle: **Kunjungan** (visit) / **Telepon** (call) /
  **Eskalasi** (escalation — hides customer-type field, posts to
  `/api/escalations` instead of `/api/visits`)
- Sales dropdown (`/api/salespeople?active=true`)
- **Nama Toko** autocomplete: hits `/api/customers/suggest?q=&rep_id=`,
  scoped to the selected rep's own portfolio (`owner_id` filter) so reps
  don't see each other's customers. Exact-match on an existing store
  auto-fills category/area/address/postal code/last PIC name and reveals the
  inline stage-update section.
- Category/Area: free-text inputs backed by `<datalist>` from
  `/api/lists/categories` / `/api/lists/areas`
- Inline **Update Tahap** section (only shown for a matched existing
  customer) — stage options depend on `account_type` (project vs repeating,
  including `repeat_order` for repeating accounts)
- Photo capture: up to 5, client-compressed, uploaded post-submit to
  `/api/visits/:id/photos`
- `?prefill=<accountId>` query param — used by My Day / account page "Log
  Kunjungan" buttons to pre-populate the form from an existing account
  (`GET /api/accounts/:id`)
- On success: WhatsApp-formatted report preview (tap-to-copy), link to the
  account page, "Log Lagi" (log another) shortcut

Backing routes (`visits.ts`):
- `POST /api/visits` — creates the visit; upserts the `customers` row
  (dedup key: lower/trim store_name + area); records initial stage history
  for brand-new accounts or an explicit stage-change row if `new_stage` was
  submitted and differs from current; also inserts a matching `actions` row
- `GET /api/customers/suggest?q=&rep_id=` — autocomplete, `rep_id` filters
  by `owner_id`
- `POST /api/visits/:id/photos`, `GET /api/photos/:id`, `GET
  /api/visits/:id/photos`, `DELETE /api/photos/:photoId`
- `PATCH /api/visits/:id` — Handler-only `visited_at` override, audit-logged
  to `visit_audits`

### `visits-rack.html` — Rack-up (management activity board)
Live dashboard, not rep-specific. Sections: pending escalations queue (with
inline resolve form), per-sales-today leaderboard, live feed of recent
visits, 7-day trend, and the full paginated/filterable Rack-up table (by
rep/type/category/area/date range), with XLSX export.

Backing routes:
- `GET /api/visits/stats` — today/week totals, per-rep-today breakdown,
  7-day daily series, recent feed, today's visit list
- `GET /api/visits` — filterable, paginated rack-up table
- `GET /api/visits/export` — XLSX download (blue/green row fill by New/Old)
- `GET /api/visits/summary?from=&to=&rep=` — count bar totals (used for
  today/month-to-date headline numbers) + won-accounts count in range
- `GET /api/escalations?status=pending`, `PATCH
  /api/escalations/:id/resolve`

### `visits-rep.html` — single-rep profile
Recent visit list for one rep plus an **AI synthesis** button that calls
`POST /api/visits/rep/:id/synthesize` — this builds a 7-day visit-log prompt
and, if `AI_API_KEY` is configured server-side, calls the Anthropic Messages
API (default model `claude-haiku-4-5-20251001`) to generate a short
Indonesian-language narrative summary (patterns, needs/issues surfaced,
follow-up recommendations). Gracefully degrades to a "not configured"
message if no API key is set — this is a scaffold feature.

### `visits-insights.html` — Insights dashboard
Team leaderboard (visits, new customers, unique stores, "hunter index" =
% of visits that were new customers), area×category coverage heatmap,
project pipeline stage counts, repeating-account health distribution, and
per-rep scorecards with a computed **archetype** label
(`Hunter|Maintainer` / optional `Specialist` / `Anchored|Roamer`, from
`insights.ts: archetype()`).

Backing routes (`insights.ts`):
- `GET /api/insights/team?from=&to=` — leaderboard, heatmap, team totals,
  pipeline/health aggregates
- `GET /api/insights/rep/:id?from=&to=` — one rep's full scorecard: total
  visits, active days, visits/active-day, hunter index, unique stores,
  notes discipline (% of visits with notes ≥40 chars), category mix, area
  mix, hourly histogram (WIB), pipeline stage counts, health buckets,
  archetype

### `myday.html` — rep's daily cockpit
The rep's single home screen, structured in zones:
- **Zone 1 — Portfolio chips**: SEMUA / AT RISK / PERLU FOLLOW-UP / AKTIF /
  PROJECT AKTIF / MENANG BLN INI / HIBERNASI — filters Zone 3 and, for AT
  RISK / PERLU FOLLOW-UP, also surfaces a dedicated **"Butuh Perhatian"**
  urgent panel above Zone 2 listing every matching account with days-since-
  contact and a one-tap "Log Kunjungan" shortcut (fixed so the chips
  actually drive visible follow-up action instead of only filtering the
  bottom list)
- **Zone 2 — Aksi Hari Ini**: Terlambat (overdue) / Hari Ini (today)
  scheduled-action columns, from `scheduled_actions`; each has a "Selesai ✓"
  button (`PATCH /api/scheduled/:sid/done`); auto-collapses when empty
- **Zone 2b — Eskalasi Kembali**: resolved escalations awaiting rep
  acknowledgement, with WhatsApp deep-link and "Tandai Follow-up" button
  (`PATCH /api/escalations/:id/followup`)
- **Kunjungan Hari Ini**: today's own logged visits, tap to expand a
  WhatsApp-formatted copy-preview
- **Zone 3 — Portfolio Akun**: full account list for the rep, filterable by
  the Zone 1 chips, each card shows stage badge, category/area, days since
  last contact (color-coded), and quick actions (Log Kunjungan / Lihat Akun)

Backing route: `GET /api/reps/:id/myday` (single aggregate call — overdue,
today, upcoming, at-risk list, quick stats, portfolio stage counts, won-
this-month, resolved escalations, today's visits) + `GET
/api/accounts?rep_id=&sort=urgency&limit=200` for the Zone 3 list.

### `account.html` — single account detail
Pipeline position (project stage stepper, or repeating-account health
badge), inline stage-change control, "Catat Aktivitas" quick-log modal
(any of the 4 action types), "Jadwalkan Follow-up" modal, full timeline of
`actions`, `stage_history`, and open `scheduled_actions`.

Backing routes (`accounts.ts`):
- `GET /api/accounts/:id` — account + actions (50) + stage_history (20) +
  open scheduled (20)
- `PATCH /api/accounts/:id/stage` — validated against the account's own
  `account_type` stage set; writes `stage_history`
- `POST /api/accounts/:id/actions` — logs a touchpoint; bumps
  `last_contact_at`, sets `owner_id` if unset
- `POST /api/accounts/:id/schedule` — creates a `scheduled_actions` row
- `PATCH /api/scheduled/:sid/done`
- `GET /api/accounts?stage=&rep_id=&area=&type=&q=&sort=urgency&limit=&offset=`
  — the general account list/search (also used by My Day Zone 3)

### `salespeople.html` — admin roster management
List active/inactive reps, register new ones (`full_name`, optional
`code`/`phone`/`default_area`), edit or deactivate (`active=false` — never
hard-deleted, since `visits`/`customers.owner_id`/etc. FK into it).

Backing routes (`salespeople.ts`): `GET /api/salespeople?active=`, `GET
/api/salespeople/:id`, `POST /api/salespeople`, `PATCH
/api/salespeople/:id`.

---

## 5. Cross-page data flow

```
visits.html  ──POST /api/visits──▶  visits (append)
                                     customers (upsert, dedup on store+area)
                                     actions (auto-insert)
                                     stage_history (if new account, or explicit stage change)
                     │
                     ▼
        customers.last_contact_at, .stage  ─── read by ───▶  myday.html (Zone 1/3, urgent panel)
                                                              account.html (pipeline position)
                                                              accounts.ts cadence engine (hourly re-stage)

scheduled_actions  ◀── POST /api/accounts/:id/schedule ── account.html
        │
        └── read by ──▶ myday.html Zone 2 (overdue/today), /api/reps/:id/myday

escalations  ◀── POST /api/escalations ── visits.html (Eskalasi toggle)
        │
        ├── read by ──▶ visits-rack.html (pending queue, resolve UI)
        └── resolved ──▶ myday.html Zone 2b (rep acknowledges via /followup)

visits + customers + salespeople  ──▶  insights.ts (aggregates, no writes)
                                   ──▶  visits-rack.html /api/visits/stats, /export
```

`customers` is the hub: it's written by the visit form (upsert), the
cadence engine (auto stage advance), and the account page (manual stage /
action / schedule); it's read by nearly every other page for stage badges,
ownership, and "days since contact" displays.

---

## 6. Known module clones (not detailed here)

- **Mirae** (`/mirae-visits`, `/mirae-rack`, `/mirae-myday`,
  `/mirae-insights`, routes in `apps/server/src/routes/mirae.ts`) — same
  shape, separate tables (`mirae_salespeople`, `mirae_customers`,
  `mirae_visits`, `mirae_visit_photos`, `mirae_visit_audits`). Notably
  `mirae_customers` uses a `status` column instead of `stage`/`account_type`
  pipeline, and `mirae_visits` has a `phone` column the retail module
  doesn't.
- **Project** (`/project-visits`, `/project-rack`, `/project-myday`,
  `/project-insights`, routes in `apps/server/src/routes/project.ts`) —
  same shape again, `project_*` tables, no `visit_audits`-style stage
  pipeline observed in the retail sense (project-specific fields instead).

Both were built as structural duplicates of Module D for different business
lines/teams and are maintained independently — a schema or route change to
the retail module does **not** propagate to them automatically.
