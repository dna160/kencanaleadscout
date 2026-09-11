# Stock 2.0 — FROZEN CONTRACTS

> **Read this before writing a line of code. Do not change anything in this file
> without the Lead Architect's approval — every work package compiles against it.**
> If a contract is wrong, raise it; do not unilaterally "fix" it, because three
> other agents are coding against the version you are about to break.

---

## 0. The one formula

```
ATP(sku) = on_hand(sku) − open_commitment(sku) + manual_adjustment(sku)
```

- `on_hand` — from `erp_live_fg` mirror. **Never written by LeadScout.**
- `open_commitment` — Σ `qty_balance` of **live** SO lines only (ST-R17).
- `manual_adjustment` — signed sum of `stock_adjustments` for that SKU.
- **DERIVED ON EVERY READ. NEVER STORED.** No table has an `atp` column. If you
  find yourself writing `update ... set atp = ...` you have made the exact
  double-subtraction mistake PRD §3 exists to prevent.
- ATP may be **negative**. Never clamp. Never `greatest(0, ...)`.

### Liveness predicate (ST-R17) — the single source of truth

A mirrored SO line counts toward `open_commitment` **iff all four hold**:

```sql
approval = 'Approved'
AND qty_balance > 0
AND status_order NOT IN (<cancelled/void set, config>)
AND (estimate_delivery >= (current_date - <window_days>)  -- default 60
     OR estimate_delivery IS NULL)                        -- AMENDMENT 1
```

Anything that fails **only** the `estimate_delivery` clause is **stale** →
excluded from ATP, listed in the stale review queue (ST-R18). Anything
confirm-closed via `stock_commitment_overrides` is also excluded.

**This predicate is implemented ONCE**, as the SQL view `v_live_commitments`
(see §2). No route, no worker, no test may re-spell it inline.

---

## 1. Canonical SKU key (ST-R5.1) — the highest-risk contract

SO detail rows have `sn_fg = NULL`, so SO↔FG matching is **by product identity,
never by serial**. The key must be computed **identically in TypeScript and in
SQL** — the same discipline the repo already uses for company-name
normalization (`apps/server/src/util/company.ts` + its SQL twin).

**Composition (v1, pending ST-R5.2 validation):**

```
sku_key = [kode_barang, warna, th, p, l].map(normalizeSegment).join('|')
```

`normalizeSegment(v)`:
1. `null`/`undefined`/`''` → `'-'` (never drop a segment; positional integrity).
2. Strings: `trim()` → `toUpperCase()` → collapse internal whitespace to one
   space → strip everything outside `[A-Z0-9 .\-/]`.
3. Numerics (`th`, `p`, `l`): parse to number, **round to 2 dp**, render with no
   trailing zeros (`0.50` → `0.5`, `1220.00` → `1220`). Non-numeric → rule 2.

**Owner:** back-end. **File:** `apps/server/src/erp/sku.ts` (TS) and the
`erp_sku_key(...)` SQL function in `migrateErpStock.ts`. Both ship with a shared
fixture table in `apps/server/test/sku.test.ts` asserting **TS output === SQL
output** for every fixture. That parity test is non-negotiable.

> **ST-R5.2 gate:** the *exact* segment list above is provisional. It is tuned by
> the fill/overlap validation pass before go-live. Which is why the key lives in
> ONE function behind ONE config knob (`STOCK_SKU_KEY_SEGMENTS`), not sprinkled
> across queries.

**Unit consistency (ST-R5.4):** `on_hand` and `open_commitment` for a given SKU
must be in the same unit. v1 canonical unit is **lembar (`qty`)**. `qty_m2` is
carried for display only. If an SO line's UoM cannot be reconciled to lembar,
the line goes to the **exceptions tray**, not silently into the sum.

---

## 2. Database schema — `erp_*` mirror + LeadScout overrides

All created by `apps/server/src/db/migrateErpStock.ts`, idempotent, each block in
its own non-fatal try/catch (**match the house style of `migrateStock.ts`**).

### 2.1 Mirror tables (read-only from LeadScout's perspective)

```sql
-- tbl_1210_STLiveFGMX
create table if not exists erp_live_fg (
  sn_fg          text primary key,
  kode_barang    text,
  warna          text,
  th             numeric,
  p              numeric,
  l              numeric,
  qty            numeric not null default 0,
  qty_m2         numeric,
  buffer_qty     numeric,
  buffer_status  text,
  lokasi         text,
  sku_key        text not null,            -- generated via erp_sku_key(...)
  erp_updated_at timestamptz,
  synced_at      timestamptz not null default now()
);
create index if not exists erp_live_fg_sku_idx on erp_live_fg (sku_key);

-- tbl_1203_SOSalesOrderDetailNID
create table if not exists erp_so_line (
  id                text primary key,      -- ERP line PK
  so_id             text,                  -- FK → erp_so_header.id
  kode_barang       text,
  warna             text,
  th                numeric,
  p                 numeric,
  l                 numeric,
  qty_order         numeric,
  qty_delivered     numeric,
  qty_balance       numeric not null default 0,
  status_order      text,
  approval          text,
  auto_approval     text,
  estimate_delivery date,
  sn_fg             text,                  -- observed NULL in practice
  sku_key           text not null,
  erp_updated_at    timestamptz,
  synced_at         timestamptz not null default now()
);
create index if not exists erp_so_line_sku_idx  on erp_so_line (sku_key);
create index if not exists erp_so_line_live_idx on erp_so_line (approval, qty_balance, estimate_delivery);

-- tbl_1202_SOSalesOrderNID
create table if not exists erp_so_header (
  id                 text primary key,
  so_number          text,
  customer_name_text text,
  sales_name_text    text,
  po_date            date,
  status_order       text,
  erp_updated_at     timestamptz,
  synced_at          timestamptz not null default now()
);
```

### 2.2 LeadScout-owned tables

```sql
-- ST-R12 / ST-R20: physical opname corrections. Signed. Audited. Additive —
-- NEVER an update of erp_live_fg.
create table if not exists stock_adjustments (
  id         bigserial primary key,
  sku_key    text not null,
  qty_delta  numeric not null,          -- signed; 0 rejected
  reason     text not null,             -- required (ST-R12)
  actor      text not null,
  created_at timestamptz not null default now()
);
create index if not exists stock_adjustments_sku_idx on stock_adjustments (sku_key);

-- ST-R18 / ST-R21: confirm-close or reinstate one stale SO line. Reversible.
create table if not exists stock_commitment_overrides (
  so_line_id text primary key,
  state      text not null,             -- 'closed' | 'reinstated'
  reason     text,
  actor      text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Sync bookkeeping: the updated_at cursor per mirrored table (ST-R6).
create table if not exists erp_sync_state (
  table_name    text primary key,       -- 'live_fg' | 'so_line' | 'so_header'
  cursor_value  timestamptz,
  last_ok_at    timestamptz,
  last_error    text,
  last_error_at timestamptz,
  rows_synced   bigint not null default 0,
  running       boolean not null default false
);
```

### 2.3 The views — where the liveness rule lives, exactly once

```sql
create or replace view v_live_commitments as
  select l.*, h.customer_name_text, h.sales_name_text, h.so_number,
         (l.estimate_delivery is null) as undated     -- AMENDMENT 1
  from erp_so_line l
  left join erp_so_header h on h.id = l.so_id
  left join stock_commitment_overrides o on o.so_line_id = l.id
  where l.approval = 'Approved'
    and l.qty_balance > 0
    and coalesce(l.status_order,'') <> all (<cancelled set>)
    and (l.estimate_delivery >= current_date - <window_days>
         or l.estimate_delivery is null)              -- AMENDMENT 1
    and coalesce(o.state,'') <> 'closed';

create or replace view v_stale_commitments as  -- same, but ETA older than window
  ... and l.estimate_delivery < current_date - <window_days>   -- NULL excluded: NULLs are live
      and coalesce(o.state,'') <> 'closed';
```

> `<window_days>` and `<cancelled set>` are **config, not literals** (ST-R7b,
> OQ-1). They arrive from `config.stock.*`. Because a Postgres view cannot read
> process env, the views are **recreated on boot** by `migrateErpStock.ts` with
> the current config values interpolated — and that interpolation is the ONLY
> place those values are spliced into SQL. Parameterize or whitelist; never
> concatenate raw user input.

---

## 3. Config surface (`apps/server/src/config.ts`)

Extend the existing exported `config` object; keep the `int()`/env-var house style.

| Env var | Default | Meaning |
|---|---|---|
| `SELARAS_BASE_URL` | `""` | ERP REST mirror base. **Empty ⇒ ERP disabled.** |
| `SELARAS_TOKEN` | `""` | Bearer token. Never logged, never echoed to a response. |
| `SELARAS_TIMEOUT_MS` | `20000` | Per-request timeout. |
| `STOCK_SYNC_INTERVAL_MS` | `180000` | 3 min — inside PRD §4's 2–5 min band. |
| `STOCK_SYNC_PAGE_SIZE` | `1000` | `limit` query param. |
| `STOCK_STALE_WINDOW_DAYS` | `60` | ST-R17 liveness window. |
| `STOCK_CANCELLED_STATUSES` | `Cancelled,Void,Batal` | CSV; OQ-1, tune at validation. |
| `STOCK_SYNC_STALE_ALERT_INTERVALS` | `4` | ST-R7 stale-banner threshold. |
| `STOCK_ATP_SHADOW` | `false` | ST-R16 shadow mode. |

Export `hasErp = Boolean(config.selarasBaseUrl)`, mirroring the existing
`hasDatabase` pattern. **Everything must boot and serve with `hasErp === false`.**

---

## 4. HTTP API contract

Base `/api/stock`. JSON in/out. Bahasa Indonesia error messages (house style).
503 shape stays `{ error: "Database tidak tersedia." }`.

### 4.1 `GET /api/stock/summary` — ST-R15, the compatibility endpoint

Same URL as 1.0 so `/stock` migrates without a URL break. **New shape:**

```jsonc
{
  "freshness": {
    "last_ok_at": "2026-09-11T14:05:00Z",
    "stale": false,              // no successful sync in N intervals (ST-R7)
    "erp_connected": true        // false when SELARAS_BASE_URL unset
  },
  "totals": {
    "skus": 812, "tersedia": 640, "habis": 120, "kosong": 40,
    "perlu_produksi": 12, "stale_commitments": 4158, "exceptions": 31
  },
  "items": [{
    "sku_key": "ACP-4MM|004|0.3|4880|1220",
    "name": "ACP 4mm Black Galaxy 0.3 · 4880×1220",
    "kode_barang": "ACP-4MM", "warna": "004",
    "th": 0.3, "p": 4880, "l": 1220, "unit": "lembar",
    "on_hand": 4168,
    "committed": 319,
    "adjustment": 0,
    "atp": 3849,
    "atp_m2": 22921.1,
    "state": "tersedia",         // tersedia | habis | kosong | perlu_produksi
    "stale_committed": 1810,     // excluded from atp; shown as context
    "nearest_eta": "2026-09-20"
  }]
}
```

`state` derivation — **implement once, server-side** (ST-R10):

| state | condition |
|---|---|
| `kosong` | `on_hand + adjustment <= 0` |
| `perlu_produksi` | `atp < 0` |
| `habis` | `atp <= 0` and `on_hand > 0` |
| `tersedia` | `atp > 0` |

Evaluate in that order. `perlu_produksi` outranks `habis`.

### 4.2 New endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/stock/sku/:sku_key` | ST-R13 timeline: on-hand rows, the live SO lines committing against it (customer/rep/ETA), stale lines, adjustments. |
| `GET`  | `/api/stock/shortfall` | ST-R11 PPIC queue: `committed > on_hand`, ranked by deficit desc then nearest `estimate_delivery` asc. |
| `GET`  | `/api/stock/stale-commitments` | ST-R18 review queue. Filter/paginate. |
| `POST` | `/api/stock/stale-commitments/:so_line_id/close` | ST-R21 confirm-close. `{ actor, reason }`. |
| `POST` | `/api/stock/stale-commitments/:so_line_id/reinstate` | ST-R21 reverse. `{ actor }`. |
| `GET`  | `/api/stock/exceptions` | ST-R5.3 unmatched SO lines (demand with no FG SKU). |
| `POST` | `/api/stock/adjustments` | ST-R12. `{ sku_key, qty_delta, reason, actor }`. `reason` required; `qty_delta != 0`. |
| `GET`  | `/api/stock/adjustments` | Audit list. |
| `GET`  | `/api/stock/sync-status` | Freshness + per-table cursors + last error. |
| `POST` | `/api/stock/sync` | Manual kick. Idempotent. Returns immediately if a run is in flight. |

### 4.3 Retired (ST-R15) — respond **410 Gone**

`POST /api/stock/bookings`, `/bookings/:id/verify`, `/bookings/:id/cancel`,
`/bookings/:id/complete`, `/bookings/:id/fulfill`, `POST /api/stock/uploads`.

Body: `{ "error": "Booking sudah tidak digunakan. Stok kini mengikuti Sales Order dari ERP." }`

`GET /api/stock/uploads`, `/uploads/:id`, `/bookings`, `/items/:id/riwayat`,
`/rep-stats` stay **readable** (ST-R14 archive) — they serve frozen history only.

---

## 5. Sync worker contract (ST-R6, ST-R7)

`apps/server/src/erp/syncWorker.ts`

- `startErpSync()` — no-op + one `warn` log when `!hasErp || !hasDatabase`.
  Mirrors `startCadenceEngine()` registration in `index.ts`.
- One run = for each of `so_header`, `so_line`, `live_fg`, page through
  `?updated_at__gte=<cursor>&order_by=updated_at&order_dir=asc&limit=N&page=P`
  and **upsert by primary key** (`on conflict (pk) do update`).
- **Idempotency is the acceptance criterion**: running a sync once or ten times
  over the same window yields byte-identical mirror state and identical ATP.
  There is no "apply a delta" path anywhere.
- Cursor advances **only after a page batch commits**. On failure: record
  `last_error`, leave the cursor, keep the old mirror readable (ST-R7).
- A `running` guard prevents overlapping runs (crash-safe: also treat a
  `running` row older than 3× the interval as stale and reclaim it).
- Never throw out of the interval callback — the process must not die on an ERP
  outage.

`apps/server/src/erp/selarasClient.ts`

- `undici` (already a dep of `packages/core`; add to server deps if needed).
- Bearer auth from `config.selarasToken`. **Token never appears in logs or in
  any HTTP response.**
- Typed `fetchPage<T>(table, { since, page, limit })`, timeout, one retry with
  backoff on 5xx/network (match `packages/core/src/fetchPage.ts` posture).
- **Response shape is UNVERIFIED** (see HANDOVER §"Known unknowns"). Parsing goes
  through one `adaptRow()` per table so a shape correction is a one-file change.

---

## 6. Front-end contract

Vanilla HTML + inline `<style>` + inline `<script>`, single file per page, no
build step, no framework, Bahasa UI, mobile-first at 380px. **Reuse the existing
CSS token block from `stock.html` verbatim** (`--bg`, `--card`, `--ink`,
`--muted`, `--line`, `--accent`, `--danger`, `.card`, `.chip`, `.btn`, `#toast`,
modal system). Do not introduce a new design language.

- `/stock` — read-only. Headline number per row is **ATP**. No booking button,
  no booking modal, no rep picker for booking. Freshness line in the header
  ("Data ERP per 14:05"); amber stale banner when `freshness.stale`.
- `/stock-ppic` — tabs: **Shortfall** (ST-R11) · **Stale** (ST-R18, with
  confirm-close/reinstate) · **Exceptions** (ST-R5.3) · **Adjustments**
  (ST-R12, reason required) · **Sync status**.
- Both poll `/api/stock/summary`; keep the existing poll/toast/modal helpers.

---

## 7. Invariants — a change that violates any of these is rejected at review

1. ATP is never stored, never cached in a column, never mutated incrementally.
2. `erp_*` tables are written **only** by the sync worker. No route writes them.
3. The liveness predicate exists in exactly one place (`v_live_commitments`).
4. `sku_key` is produced by exactly one TS function and one SQL function, and a
   test asserts they agree.
5. Negative ATP is surfaced, never clamped.
6. An SO line is never silently dropped: it is live, stale-queued, or an
   exception. Those three sets partition every **approved, non-cancelled** line
   with `qty_balance > 0`. (Cancelled and unapproved lines are dead demand and
   correctly belong to none of the three — see AMENDMENT 2.)
7. The app boots and serves with no ERP and no database configured.
8. Every write endpoint records an actor; overrides and adjustments are audited
   and reversible.
9. No secret (`SELARAS_TOKEN`, `DATABASE_URL`) is logged or returned.


---

# AMENDMENTS

Ruled by the Lead Architect after a work package raised a `[CHALLENGE]`. These
are part of the frozen contract — implement them, do not re-litigate them.

## AMENDMENT 1 — an approved line with `estimate_delivery IS NULL` is LIVE

**Raised by WP-1.** Implemented verbatim, the original §2.3 view bodies matched a
NULL ETA against neither `>= current_date - N` nor `< current_date - N`. Such a
line appeared in **neither** view: it reserved nothing, surfaced in no queue, and
silently inflated ATP by its whole balance — the exact failure ST-R18 exists to
prevent, and a breach of invariant §7.6. Reproduced on seeded data.

**Ruling: undated approved lines count as LIVE and reserve stock.**

The reasoning matters, because the challenge proposed the opposite and called it
conservative. It is not. `open_commitment` is *subtracted*, so **excluding a
commitment raises ATP** — it promises more stock, not less. Routing undated lines
to the stale queue would have been the over-promising choice.

Excluding stale lines is nonetheless right, because an ETA from 2020 is positive
evidence of abandonment (PRD §5A). A NULL ETA is not that. It is an approved
order, with an undelivered balance, that nobody has scheduled yet — real demand,
merely undated. Absence of a date is not evidence of death.

And the two errors are not symmetric. Under-promising costs a conversation with a
customer; over-promising double-sells physical stock that is already owed to
someone else. For a stock system, reserving is the safe default.

Consequences, all required:

1. `v_live_commitments` carries a boolean `undated` column (above).
2. WP-3 exposes `undated` on every commitment it returns, and `/stale-commitments`
   accepts a filter that surfaces undated live lines for PPIC triage — they are
   reviewable exactly like stale lines.
3. ST-R21 confirm-close already covers the case where an undated line turns out to
   be a phantom. No new mechanism is needed.
4. WP-7 tests the NULL-ETA line explicitly: it reserves, it is flagged `undated`,
   it appears in the PPIC review surface, and confirm-closing it stops the
   reservation.

## AMENDMENT 2 — invariant §7.6 reworded to be checkable

Also from WP-1: cancelled and unapproved lines with `qty_balance > 0` land in no
set either. That is **correct** — they are dead demand and must not reserve — but
it made the invariant as written unsatisfiable. §7.6 now scopes the partition to
approved, non-cancelled lines. `/exceptions` keeps its §4.2 meaning (approved
demand with no matching FG SKU) and does not widen.

## Accepted from WP-1, no change required

- **A9–A14** in HANDOVER §7 are accepted as ruled.
- **A14 in particular** — `sku_key` as a plain `text not null` column rather than
  `GENERATED ALWAYS`, because `create or replace function` does not recheck
  generated-column dependents and a body change would silently desynchronise
  stored keys. The contract's §2.1 wording is superseded by this reasoning.
- The added index `erp_so_line_so_idx on (so_id)` is accepted.
- ASCII-only case folding and whitespace classes on **both** sides (never
  `upper()` / `\s`, which are collation-dependent). Do not "simplify" either side
  without changing the other; WP-7 keeps fixtures on this.


## AMENDMENT 3 — `GET /api/stock/sku/:sku_key` response body, frozen

**Raised by WP-5.** §4.2 described this endpoint's purpose in one line and never
gave it a body, while four sibling endpoints got JSON examples. The front-end
developer had to invent field names and then write alias-tolerant readers to
hedge against the back-end guessing differently — avoidable client work caused by
a gap in this document, not by the developer.

Frozen shape (shipped in `9b0d42f`, relayed to WP-3 in flight):

```jsonc
{
  "item": { /* the same item object as /summary's items[] */ },
  "live_commitments": [{
    "so_line_id": "…", "so_number": "…",
    "customer_name_text": "…", "sales_name_text": "…",
    "estimate_delivery": "2026-09-20",   // "YYYY-MM-DD" | null
    "qty_balance": 319, "status_order": "…",
    "undated": false                      // AMENDMENT 1
  }],
  "stale_commitments": [ /* same shape */ ],
  "adjustments": [{ "id": "…", "qty_delta": -12, "reason": "…", "actor": "…", "created_at": "…" }],
  "on_hand_rows": [{ "sn_fg": "…", "lokasi": "…", "qty": 120, "qty_m2": null }]
}
```

- Field names are the `erp_so_line` / `erp_so_header` column names from §2. No
  short aliases.
- Every array is **always present**, `[]` when empty — never null, never omitted.
- `item` is always present.
- Both commitment arrays come from the views. The liveness predicate is not
  re-spelled here (§7.3).

## AMENDMENT 4 — pagination on all four list endpoints

`/shortfall`, `/exceptions`, `/adjustments` and `/stale-commitments` all accept
`page`, `limit` and an optional free-text `q`, and all return a total (or
`has_more`) so a pager can render. §4.2 had spelled pagination out only for
`/stale-commitments`; both front-end pages assumed it uniformly, and they were
right to — the shortfall and exceptions lists are unbounded in exactly the same
way. `limit` is capped server-side; a client may not request 4,000 rows.

## AMENDMENT 5 — `sku_key` as a path segment

`sku_key` contains `|` and `.` (`ACP-4MM|004|0.3|4880|1220`). Clients send
`encodeURIComponent(sku_key)`. Fastify decodes path params, so the handler reads
the decoded value and must **not** decode a second time — that would corrupt any
SKU whose text legitimately contains `%`. WP-7 tests the round trip.

## Open — not resolved, carried to review

- **`coating` is absent from the §4.1 item.** The 1.0 page had a working coating
  filter and sort; both are dropped because the contract has no field for it. If
  coating matters to reps, it needs a field on `erp_live_fg` and in the item
  shape. Raised by WP-5; needs a product answer, not an engineering one.
- **`.fltchips` / `.fchip`** are defined independently in `stock.html` and
  `stock-ppic.html` (each agent was scoped to one file and could not see the
  other). They are not byte-identical. Reconcile.


## AMENDMENT 6 — the close button has two populations with opposite consequences

**Raised by UI/UX.** This is a safety problem AMENDMENT 1 created, and it cannot
be fixed in the UI alone.

Undated approved lines are now **live** — they reserve stock — yet they surface in
the same PPIC review queue as stale lines. So one `Tutup` button spans two
populations whose consequences are opposite:

| closing a… | effect on ATP |
|---|---|
| **stale** line | **zero** — it was already excluded from the sum |
| **undated** line | **+ its entire balance** — it was reserving |

An operator who learns "closing does nothing to the numbers" from the first
population would silently release reserved stock in the second. That is a route
to over-promising physical stock, which is the failure this whole module exists
to prevent.

Three required consequences:

**6a. `atp_delta` on close and reinstate responses.**
```jsonc
{ "ok": true, "so_line_id": "…", "sku_key": "…",
  "atp_delta": 1200, "atp_before": 3849, "atp_after": 5049 }
```
Computed server-side, never inferred by the client. The UI states the consequence
in the confirm and the toast, and it must be true. For a stale line it is
legitimately `0` — that is the point.

**6b. `POST /api/stock/stale-commitments/close-batch`.**
Request takes an **explicit** `so_line_ids` list (capped at 200), a **required**
`reason`, an `actor`, and an `expected_count` guard — mismatch ⇒ 409, nothing
written. One transaction, all-or-nothing. Returns `closed`, `skipped`, and
`atp_delta_by_sku`.

A filter-shaped "close everything matching X" is **forbidden**: the explicit id
list plus `expected_count` is what stops a mistyped filter closing thousands of
live commitments. Without a batch endpoint, the UI fires 50 sequential
un-transacted POSTs, and ST-R22's genuinely safe bulk case — `status_order='DO'`
with a balance, the known-dead phantoms — becomes ~84 pages of clicking that
nobody finishes.

**6c. `?segment=` on `/stale-commitments`**: `stale` (default), `undated`,
`closed`. `segment=closed` is **not optional** — a closed row leaves
`v_stale_commitments`, so without it the undo path dies on page reload and a
confirm-close becomes unrecoverable from the UI. `undated` rows carry
`qty_balance` and `sku_key` so the UI can preview the consequence.

The UI splits the queue into two labelled segments with different copy, a
different primary-button colour, a mandatory reason on the undated side, a
per-row "effect if closed" preview, and **no bulk close on the undated side at
all**.

## AMENDMENT 7 — accessibility corrections to the inherited palette

The inherited design system has two contrast failures and no focus style. Fixed
additively; no inherited rule is changed:

- `--muted` on `--bg` computes **4.39:1 — fails AA**. Binding rule: no `--muted`
  text on the page ground, only inside a white `.card`. `--ink-2` (7.58:1)
  carries secondary numerals.
- The inherited `.chip.age` is grey-on-grey at 4.39:1. A new `.chip.umur` uses a
  darkened `--neutral-ink` (6.87:1); `.chip.age` is left untouched.
- `--focus` added — the inherited CSS has no focus style at all.
- `--tap: 44px` added; `.btn` is 40px and `.mini` is 34px.

All 30 contrast pairs are computed in UX-SPEC §9.2, not asserted.

## Accepted limits — not defects, but know them

- **`/summary` returns every SKU unfiltered.** Fine at ~812 SKUs; it degrades
  silently the moment OQ-2 (per-warehouse split) or the RM phase multiplies the
  row count. Revisit with pagination at that point, not before — premature
  pagination here would complicate every caller for no present gain.
- **No brand field.** ST-R8 asks for filtering by brand, but the item shape has
  none and `kode_barang` conflates brand, line and panel thickness. The filter is
  labelled "Kode barang" rather than guessing a prefix rule. Same family as the
  missing `coating`: both need a column on the aggregate, and both are product
  questions. **Carried to review.**
- **Customer names are PPIC-only.** Nothing in the PRD says whether sales may see
  which customer holds a commitment. Withholding is the reversible default; that
  is a commercial call, not a UI one. **Carried to review.**
- **`nearest_eta` population is undefined** — if it ever comes to mean incoming
  supply rather than nearest commitment, the label must change, because the two
  mean opposite things to a rep.


## AMENDMENT 8 — list-endpoint parameters, ratified

Both front-end packages independently invented filter parameters because §4.2 said
only "Filter/paginate". Convergent invention is a warning, not a comfort: two
developers guessing the same thing still leaves the back end guessing a third.
Ratified names, final:

| param | endpoints | meaning |
|---|---|---|
| `page`, `limit` | all four lists | paging; `limit` capped server-side |
| `q` | all four lists | free-text, debounced client-side |
| `segment` | `/stale-commitments` | `stale` (default) · `undated` · `closed` |
| `min_age_days` | `/stale-commitments` | age tier filter |
| `status` | `/stale-commitments` | `status_order` filter |
| `only_do` | `/stale-commitments` | ST-R22: `status_order='DO'` with a balance |

`segment` **replaces** the `state=closed` and `undated=true` spellings one page
shipped with. A single enum beats two booleans that can contradict each other.

Response envelope for every list:

```jsonc
{ "rows": [...],
  "total": 1204,          // rows matching the current filter — drives the pager
  "grand_total": 4158,    // unfiltered, so the UI can say "filtered from 4,158"
  "status_facets": ["Waiting","DO"] }   // /stale-commitments only
```

`grand_total` and `status_facets` are **ratified** — without them the count line
degrades to a fallback and the status filter has to be honestly relabelled
"this page only", which is a worse product for no saving.

`POST /sync` returns **409** when a run is in flight. One signal, not three.
`reason` on close is **mandatory server-side**, not merely conventional.

## AMENDMENT 9 — where a list is ranked, the server ranks it

`/shortfall` arrives ranked (deficit desc, then nearest `estimate_delivery` asc)
and the client must not re-sort it or offer sortable headers. The ranking *is* the
production priority (ST-R11); a user-chosen sort silently replaces a deficit-and-
deadline ordering with something that looks equally authoritative and is not.


## AMENDMENT 10 — `perlu_produksi` outranks `kosong`

**Raised by WP-3**, which implemented my §4.1 table literally and then flagged
that it contradicts the PRD.

§4.1 listed `kosong` first, so a SKU with no stock and 120 lembar of demand
(`atp −120`) evaluated to **Kosong** — "nothing here" — while PRD ST-R5.3 and
ST-R10 both say unmatched demand must read **Perlu Produksi**. My ordering was
wrong, not the implementation.

The distinction is the entire reason ST-R4 insists negative ATP be surfaced
rather than clamped: `kosong` is an absence nobody is waiting on, and
`perlu_produksi` is an absence somebody has already ordered against. Collapsing
the second into the first hides the demand signal that feeds production
planning — in the one case where it is most urgent, because there is no stock
at all.

Corrected evaluation order:

| order | state | condition |
|---|---|---|
| 1 | `perlu_produksi` | `atp < 0` |
| 2 | `kosong` | `on_hand + adjustment <= 0` |
| 3 | `habis` | `atp <= 0` and `on_hand > 0` |
| 4 | `tersedia` | `atp > 0` |

Only a SKU with neither stock nor demand is `kosong`.

## Known gap — ST-R5.4 UoM exceptions are not implementable as specified

`erp_so_line` carries no unit-of-measure column, so the "UoM cannot be reconciled
to lembar" exception ST-R5.4 calls for cannot be detected. `/exceptions` ships
with one reason in v1, `sku_tidak_cocok` (no FG row for the SKU). If SO lines do
carry a UoM in the real ERP payload, it needs mirroring before ST-R5.4 can be
honoured — resolve during ST-R5.2 validation.
