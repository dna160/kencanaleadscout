# Stock 2.0 — HANDOVER / CONTEXT-RECOVERY

> **If you are an agent picking this up cold — read this file first, then
> `CONTRACTS.md`, then only the files listed in your own work package.**
> Do not read all 1,243 lines of `routes/stock.ts` unless your package says to.
> Budget your context: the contracts doc is the spec; the old code is reference.

---

## 1. What is being built, in one paragraph

LeadScout's stock module today is a **manual booking ledger**: PPIC uploads an
Excel that *becomes* the inventory, sales place bookings that deduct from it,
overbookings land in a PPIC verify queue. That existed only because there was no
ERP link. There is one now. We are **retiring bookings and the Excel upload** and
rebuilding on Available-to-Promise: physical on-hand comes straight from the ERP
mirror, every live (approved, undelivered, recently-dated) Sales Order line
reserves what it needs, and what remains is what sales can promise. The module
stops being a system of record and becomes a **tracker**.

```
ATP(sku) = on_hand(sku) − open_commitment(sku) ± manual_adjustment(sku)
```

Derived on every read. Never stored. See `CONTRACTS.md §0`.

---

## 2. ⚠️ Known unknowns — read before you trust the spec

**The PRD's dependency documents do not exist in this repository.** It cites
`claude/leadscout-2.0-prd.md`, `claude/selaras-live-api-findings.md` and
`claude/selaras-table-catalog.md`; there is no `claude/` directory, and
`grep -ri selaras` over the source tree returns **zero** hits. There is no ERP
client, no base URL, no credential, no recorded response body.

**Consequence:** the exact Selaras REST response envelope (pagination shape,
field casing, date format, whether `updated_at__gte` is the real filter syntax)
is **unverified**. We are building to the query pattern the PRD states in §4.

**The mitigation, and it is load-bearing:**

1. Everything ERP-facing is behind `SELARAS_BASE_URL`. Unset ⇒ `hasErp === false`
   ⇒ the sync worker never starts and every surface renders
   "ERP tidak terhubung" instead of crashing. The app boots either way.
2. All response parsing funnels through **one `adaptRow()` per table** in
   `selarasClient.ts`. When the real shape lands, it is a one-file diff — not a
   hunt through the worker and three routes.
3. The sync worker is tested against **recorded fixtures**, not the live API, so
   the test suite is green and meaningful before credentials ever arrive.

**Do not fabricate ERP behaviour beyond this.** If a decision needs the real API,
write the assumption down in §7 below rather than guessing silently.

Second unknown: **ST-R5.2 (SKU fill/overlap validation) cannot be run** — it
needs live data. The canonical key composition in `CONTRACTS.md §1` is therefore
**provisional**, which is exactly why it sits behind one function and one config
knob. Treat the exceptions tray (ST-R5.3) as the safety net it is: on real data,
a bad key composition shows up as a flood of exceptions, not as wrong ATP.

---

## 3. The repository, as it actually is

Monorepo, pnpm workspaces, no framework on the front end.

```
packages/core/            pure scraper IP — NOT touched by this work
apps/server/
  src/config.ts           env-driven config singleton  → EXTEND (§3 contracts)
  src/index.ts            Fastify bootstrap, 194 lines → EXTEND (register + start)
  src/db/client.ts        postgres.js singleton, returns null w/o DATABASE_URL
  src/db/migrate.ts       main migrations (1,267 lines) → do not touch
  src/db/migrateStock.ts  1.0 booking schema (172 lines) → keep, stops growing
  src/routes/stock.ts     1.0 booking routes (1,243 lines) → gutted, see WP-4
  public/stock.html       561 lines, sales page      → rewritten (WP-5)
  public/stock-ppic.html  841 lines, PPIC page       → rewritten (WP-6)
  test/io.test.ts         the only existing test file; vitest
```

**House style — match it, do not improve on it:**

- ESM, `.js` extensions on relative imports (NodeNext). `strict: true`,
  `noUncheckedIndexedAccess: true`. Both are on; your code must compile clean.
- `postgres.js` tagged templates. Interpolated values are parameterized
  automatically — use that, never string-concatenate SQL.
- **bigserial ids arrive as strings.** Compare with `String(a) === String(b)`.
  There is an `eqId()` helper in `routes/stock.ts` doing exactly this.
- Migrations are idempotent, run on every boot, and each block sits in its own
  **non-fatal** try/catch so a partial failure never blocks boot. Copy the shape
  of `migrateStock.ts` literally.
- Routes: `export async function xRoutes(app: FastifyInstance)`, registered in
  `index.ts`. DB-missing guard returns 503 with a Bahasa message.
- Front end: one self-contained HTML file per page, inline `<style>` + inline
  `<script>`, no bundler, no dependency. Bahasa UI copy. Mobile-first at 380px.
- Comments in this codebase explain **why** and cite the requirement id
  (`R17`, `§6.1`). Keep doing that with the new ids (`ST-R17`).

---

## 4. Work packages

Each package names its owner, the files it may touch, its done-criteria, and what
it must not touch. **Two agents must never edit the same file.** `index.ts` and
`config.ts` are shared-edit files: WP-1 lands them first, everyone else appends.

### WP-1 · Foundation (back-end) — **BLOCKS EVERYTHING, LAND FIRST**
Files: `src/config.ts`, `src/erp/sku.ts`, `src/db/migrateErpStock.ts`,
`src/index.ts` (registration only), `.env.example`
- Config surface per `CONTRACTS.md §3`, incl. `hasErp`.
- `sku.ts`: `canonicalSkuKey(parts)` + `normalizeSegment(v)`, exported, pure,
  no db/http imports.
- `migrateErpStock.ts`: every table in `CONTRACTS.md §2`, the `erp_sku_key(...)`
  SQL function, and `create or replace view` for both views with config values
  interpolated at boot.
- Wire `runErpStockMigrations(db)` into `bootDatabase()` after
  `runStockMigrations(db)`.
- **Done when:** `pnpm -r build` passes, boot succeeds with and without
  `DATABASE_URL`, and with and without `SELARAS_BASE_URL`.

### WP-2 · ERP client + sync worker (back-end)
Files: `src/erp/selarasClient.ts`, `src/erp/syncWorker.ts`, `src/index.ts` (one
`startErpSync()` line)
- Per `CONTRACTS.md §5`. Idempotent upserts, cursor discipline, `running` guard,
  never throws out of the interval, token never logged.
- **Done when:** fixture-driven test proves double-running one sync window
  produces identical mirror rows and identical ATP.

### WP-3 · ATP engine + read routes (back-end)
Files: `src/routes/stock-atp.ts` (new)
- `summary`, `sku/:sku_key`, `shortfall`, `stale-commitments`, `exceptions`,
  `sync-status` per `CONTRACTS.md §4`.
- ATP computed as **one grouped SQL aggregate** joined across mirror + views +
  adjustments. Never a per-row loop, never N+1.
- **Done when:** the Black Galaxy worked example (`PRD.md §5A`) reproduces from
  seeded fixtures: on_hand 4,168 − live 319 = **ATP 3,849**, with 1,810 stale
  quarantined — *not* the naive 2,039.

### WP-4 · Write routes + retirement (back-end)
Files: `src/routes/stock-atp.ts` (adjustments + overrides), `src/routes/stock.ts`
(gut to 410s + archive reads)
- `POST /adjustments` (reason required, delta ≠ 0), close/reinstate overrides.
- Booking/upload POSTs → **410** with the Bahasa body in `CONTRACTS.md §4.3`.
  Archive GETs keep working (ST-R14).
- **Done when:** no code path writes `stock_bookings` or `stock_items`; the
  archive reads still return their frozen history.

### WP-5 · `/stock` sales page (front-end + ui-ux)
Files: `public/stock.html`
- ATP as the headline number. Four states with clear Bahasa labels. Search and
  filter by brand/warna/thickness/dimensions (**port the existing filter UX —
  it already works, don't redesign it**). Freshness line + stale banner.
- **Every booking affordance removed**: the rep picker, the book modal, the
  qty field, the PPIC "Penuhi" hints.
- **Done when:** the page renders correctly against an empty ERP, a stale ERP,
  and a populated one, at 380px.

### WP-6 · `/stock-ppic` page (front-end + ui-ux)
Files: `public/stock-ppic.html`
- Five tabs per `CONTRACTS.md §6`. The stale queue is the centrepiece: ~4,158
  rows, so it needs filtering and paging, and confirm-close must be one tap with
  an undo path (reinstate).
- **Every verify-queue affordance removed** (approve/reject/complete/Penuhi,
  the LAMA tracker, the Excel upload control).
- **Done when:** all five tabs work against fixtures at 380px, and the upload
  control is gone from the DOM, not merely hidden.

### WP-7 · Tests + rollout (qa-deployment)
Files: `test/sku.test.ts`, `test/atp.test.ts`, `test/erpSync.test.ts`,
`docs/stock-2.0/ROLLOUT.md`
- **TS↔SQL `sku_key` parity** (the one test that most protects the build).
- ATP math incl. negative ATP, the liveness window boundary (exactly −60d and
  −61d), the Black Galaxy case, adjustment application.
- Sync idempotency from fixtures; cursor does not advance on failure.
- Shadow-mode plan (ST-R16) and the ST-R5.2 validation runbook for when
  credentials land.

---

## 5. Order of play

```
WP-1 ──┬── WP-2 ──┐
       ├── WP-3 ──┼── WP-4
       │          └── WP-5, WP-6 (can start on the §4 shapes as soon as WP-1 lands)
       └────────────── WP-7 (writes tests alongside, not after)
```

WP-5 and WP-6 code against `CONTRACTS.md §4` response shapes, so they do **not**
wait for WP-3 to finish — that is the point of freezing the contract first.

---

## 6. Definition of done for the whole change

- [ ] `pnpm -r build` clean; `pnpm typecheck` clean; `pnpm test` green.
- [ ] Boots with no `DATABASE_URL`. Boots with no `SELARAS_BASE_URL`.
- [ ] No stored ATP column anywhere. No incremental stock mutation anywhere.
- [ ] Liveness predicate spelled exactly once.
- [ ] `sku_key` TS/SQL parity test passing.
- [ ] Black Galaxy worked example reproduces from fixtures.
- [ ] Every `qty_balance > 0` line lands in exactly one of: live, stale, exception.
- [ ] Booking + upload writes return 410; archive reads still work.
- [ ] Both pages usable at 380px in Bahasa, with ERP connected and disconnected.
- [ ] All nine invariants in `CONTRACTS.md §7` hold.

---

## 7. Assumption log — append, never rewrite

Record every decision made in the absence of ground truth, so the human review
can audit it in one place.

| # | Assumption | Made by | Reversal cost |
|---|---|---|---|
| A1 | Selaras REST returns `{ data: [...], meta: { page, total_pages } }`; parsing isolated in `adaptRow()` | scaffold | low — one file |
| A2 | `updated_at__gte` + `order_by`/`order_dir`/`limit`/`page` work as PRD §4 states | scaffold | low — client only |
| A3 | Canonical SKU = `kode_barang|warna|th|p|l` (ST-R5.2 unvalidated) | scaffold | low — one function + config |
| A4 | Canonical unit is lembar (`qty`); `qty_m2` is display-only | scaffold | medium — touches ATP math |
| A5 | Cancelled/void `status_order` set is `Cancelled,Void,Batal` (OQ-1 open) | scaffold | low — config CSV |
| A6 | Aggregate ATP across warehouses; `lokasi` not a dimension in v1 (OQ-2) | PRD §10 | medium — schema keeps `lokasi` |
| A7 | `buffer_qty` does **not** reduce ATP in v1 (OQ-5 open) | scaffold | low — one term in the formula |
| A8 | Only SO reduces ATP; transfers/samples do not (OQ-3 open) | PRD §10 | medium |
| A9 | A segment normalizing to empty (e.g. `'###'`) becomes `'-'`, not `''` — positional integrity | WP-1 | low |
| A10 | ASCII-only case folding + whitespace on both sides; never `upper()`/`\s` (collation-dependent) | WP-1 | low, but must change both sides together |
| A11 | `STOCK_SKU_KEY_SEGMENTS` whitelisted against a 5-name registry; SQL signature fixed, only the body varies | WP-1 | low |
| A12 | Views use `create or replace` with `drop … cascade` fallback (`l.*` pins the column list) | WP-1 | low |
| A13 | `erp_sync_state` pre-seeded with the 3 table names so WP-2 can `update` a present row | WP-1 | low |
| A14 | `sku_key` is plain `text not null`, NOT `GENERATED ALWAYS` — a function-body change would silently desync stored keys | WP-1 | low — ruled, see CONTRACTS AMENDMENT block |
| A15 | Approved lines with `estimate_delivery IS NULL` are **live** and reserve stock, flagged `undated` | Architect ruling, AMENDMENT 1 | low — one view clause |

---

## 8. If you are running out of context

1. **Stop coding.** Do not start a file you cannot finish.
2. Append to `docs/stock-2.0/PROGRESS.md`: which WP, which files are complete,
   which are half-written and precisely where, what you learned that is not yet
   written down, and the single next action.
3. Add any new assumption to §7 above.
4. Commit what compiles. A clean partial commit is recoverable; an uncommitted
   half-file is not.
