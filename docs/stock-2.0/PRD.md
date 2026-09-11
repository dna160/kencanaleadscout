# Stock System 2.0 — SO-Driven Available-to-Promise (PRD update)

| | |
|---|---|
| **Status** | Draft v1.1 for review (v1.1 adds §5A commitment-liveness & cold-start after finding 95% of ERP "open" SO balances are stale) |
| **Date** | 2026-09-11 |
| **Supersedes** | The booking-driven stock module (1.0 `apps/server/src/routes/stock.ts`, `db/migrateStock.ts`) and PRD §9 "live stock" first-win |
| **Parent** | `claude/leadscout-2.0-prd.md` (this replaces the stock portion of phase B) |
| **Depends on** | Selaras REST mirror (see `claude/selaras-live-api-findings.md`, `claude/selaras-table-catalog.md`) |

---

## 1. Summary

Today the stock module is a **manual booking ledger**: PPIC uploads an Excel that *becomes* the inventory, sales place bookings that deduct it, and overbookings land in a PPIC verify queue. That whole apparatus existed only because LeadScout had no link to the ERP.

Now it does. This update **retires bookings and the Excel upload** and rebuilds the stock module on one principle:

> **The Sales Order is the north star of stock consumption.** Physical on-hand comes straight from the ERP; every approved, not-yet-delivered SO line reserves what it needs; what's left is what sales can still promise.

The number the app shows becomes **Available-to-Promise (ATP)**, derived — never stored — exactly as 1.0's `available` was derived, just from a better source:

```
ATP(sku)  =  on_hand(sku)            ← ERP Live FG (tbl_1210), physical truth
           − Σ open_commitment(sku)  ← approved SO lines, qty_balance (tbl_1203)
           ± manual_adjustment(sku)  ← rare corrections / stock opname
```

The stock system stops being a *system of record* and becomes a **tracker**: does inventory exist for this SKU, and is any of it still free to sell?

---

## 2. Decisions locked (2026-09-11, with Mechashock)

1. **Physical truth = ERP Live FG** (`tbl_1210_STLiveFGMX`), mirrored read-only. LeadScout does **not** keep its own opening balance. The PPIC Excel upload is retired.
2. **SO reserves as Available-to-Promise** — an approved SO line commits stock immediately, before shipment. ATP drops the moment the order is real, not when it ships.
3. **Commitment = `qty_balance`** (undelivered remainder). As the ERP posts deliveries, `qty_balance` falls and the commitment shrinks on its own; a fully delivered line commits nothing. Self-cleaning, no manual close.
4. **Approved SO lines only** commit (draft/waiting lines don't reserve).
5. **Bookings retired**, plus the overbooking/verify queue. A small **manual stock adjustment** remains for corrections and physical-count (opname) reconciliation.
6. **Live-commitment rule** (the key optimization — see §5A): a commitment reduces ATP only if `approval='Approved'` AND `qty_balance>0` AND `estimate_delivery ≥ today − 60 days`. Older balances are **stale** → excluded from ATP, sent to a review queue. (Verified: ~95% of ERP "open" balances are stale phantoms.)
7. **Physical is never overridden by SO.** On-hand (ERP Live FG, gross) and commitments are separate axes. Overrides are manual and per-axis: opname adjusts physical; confirm-close dismisses a phantom commitment. At first port there is **no historical consolidation** — ATP is a fresh snapshot each sync.

---

## 3. Why "reduce on new SO" must be *derived*, not *imperative*

The intuitive phrasing is "poll SO → when a new SO appears, subtract it from stock." Implemented literally that is a **double-subtraction bug waiting to happen**: polling re-sees the same SO line on the next tick, an SO line gets edited (qty changed), or a delivery posts — and an imperative "subtract X now" fires twice.

The robust equivalent, and what this PRD specifies: **never mutate a stored stock number. Recompute ATP from the current set of open SO commitments on every sync.** Idempotent by construction — running the sync once or ten times yields the same ATP. This is the same "derived, never stored" rule the 1.0 module already lived by (`available = qty_initial − Σ bookings`); we only swap the deduction source from `stock_bookings` to mirrored SO lines. The user's mental model is preserved; the implementation is made safe.

---

## 4. Data sources (all mirrored from Selaras, read-only)

| Purpose | ERP table | Key fields | Notes |
|---|---|---|---|
| Physical on-hand FG | `tbl_1210_STLiveFGMX` | `sn_fg`, `kode_barang`, `warna`, `qty`, `qty_m2`, `buffer_qty`, `buffer_status`, `lokasi` | 1,464 rows; the SKU-level truth. `qty_booking` exists but is unused in ERP (null) — we compute commitment ourselves. |
| Open SO commitments | `tbl_1203_SOSalesOrderDetailNID` | `kode_barang`, `warna`, `th`, `l`, `p`, `qty_order`, `qty_delivered`, **`qty_balance`**, `status_order`, `approval`, `auto_approval`, `estimate_delivery`, `sn_fg` | 137k lines; **4,376 with `qty_balance>0`** = the working commitment set. |
| SO context (customer/rep/date) | `tbl_1202_SOSalesOrderNID` | `customer_name_text`, `sales_name_text`, `po_date`, `status_order` | Join parent for display/attribution. |
| Incoming production (later) | `tbl_1179_STMutasiFGMX`, `tbl_1236_DBRequestProduksiID` | — | Optional "+ incoming" term (see §9, ties to F1). |

**Sync**: polling, not true streaming (the API has no webhooks). A worker pulls incrementally with `?updated_at__gte=<cursor>&order_by=updated_at&order_dir=asc&limit=1000&page=N` into local `erp_*` mirror tables, then ATP is recomputed. Default cadence **every 2–5 min** for SO + Live FG (both change intraday); tunable. Every stock screen shows freshness ("Data ERP per 14:05").

---

## 5. The join-key problem (the one real risk) and its resolution

**Finding (verified live):** SO detail rows have **`sn_fg` = null** (the FG serial is only assigned later, at production/allocation), while Live FG rows are keyed by `sn_fg`. So an SO line **cannot** be matched to a stock row by `sn_fg`. Matching must be by **product identity**.

- **ST-R5.1 — Canonical SKU key.** Define one canonical key derived on both sides from `kode_barang` + `warna` (+ `th`, panel thickness, `p`, `l` where they distinguish variants). Compute it identically in the sync (SO side) and the stock read (FG side) — the same discipline as 1.0's company-name normalization running in both JS and SQL.
- **ST-R5.2 — Validate fill/overlap first.** Before build, measure how cleanly open SO lines resolve to Live FG SKUs on the real data. This gate decides the exact key composition. (Prep work, not guesswork.)
- **ST-R5.3 — Unmatched → exceptions tray, never silent.** An SO line whose SKU has no Live FG row (make-to-order item, new SKU, dirty code) still counts as demand: it shows in a **shortfall/exceptions view** for PPIC and reads as ATP-negative / "produksi diperlukan" for that SKU, rather than vanishing. No commitment is ever dropped just because it didn't match.
- **ST-R5.4 — Unit consistency.** Reconcile UoM between SO line and FG stock (lembar vs m²; `qty` vs `qty_m2` both exist on Live FG). Commit and on-hand must be compared in the same unit per SKU.

---

## 5A. Commitment liveness & cold-start consolidation (the "Black Galaxy" problem)

**The problem, in real numbers (verified live 2026-09-11).** The ERP's `qty_balance` is *not* maintained as a true "currently outstanding" figure — fulfilled and abandoned SO lines keep a non-zero balance forever. Concretely, for **Black Galaxy** (warna code 004):

| Black Galaxy | units |
|---|---|
| Physical on-hand (ERP Live FG, 41 stock rows) | **4,168** |
| "Open" balance, naive (all `qty_balance>0`, 76 lines) | 2,129 |
| — stale (ETA older than 60d; oldest **2020-08-27**, some already status "DO") | 1,810 → review queue |
| — live (ETA within 60d) | 319 |
| **ATP = 4,168 − 319** | **3,849 promiseable** |

Naive ATP would read 4,168 − 2,129 = 2,039, wrongly suppressed by phantom orders back to 2020. And it's systemic: only **218 of 4,376** ERP "open" lines have a delivery date in the last ~2 months — **~95% are stale**.

**Why physical needs no override (verified).** ERP Live FG `qty` is **gross** — reduced only when goods ship (`qty_booking` is unused, 0/1,464 rows). So on-hand and open `qty_balance` are disjoint (a shipped unit leaves both simultaneously); there is no double-count from the ERP side, and the `100 physical − 100 live order = 0 ATP` case is *correct* (all stock promised; PPIC still sees 100 physical). The danger is never SO zeroing fresh stock — it is *stale* commitments dragging ATP down. Physical truth is authoritative and never written by SO.

**Rules (locked):**
- ST-R17. `open_commitment(sku)` counts a line only if `approval='Approved'` AND `qty_balance>0` AND `estimate_delivery ≥ today − 60 days`. The 60-day window is config (tunable per SKU class later).
- ST-R18. **Stale-commitment review queue.** Every excluded open line (SKU, customer, ETA, `qty_balance`, `status_order`) is listed for PPIC/sales to *confirm-close* or *reinstate*. Nothing is silently dropped, and nothing stale silently suppresses ATP.
- ST-R19. **Cold-start = snapshot, not replay.** No historical consolidation is needed: ATP is recomputed from current physical + current live commitments on every sync. First port = enable the rule, run one calibration pass (sanity-check ATP for top SKUs against PPIC's gut, tune the window), go live. Stale residue is handled by ST-R18, never by blocking launch.
- ST-R20. **Physical override** — PPIC opname adjustment corrects on-hand vs reality (breakage, unrecorded receipt); never touched by SO.
- ST-R21. **Commitment override** — confirm-close (or reinstate) a specific line from the review queue; a closed phantom stops reducing ATP even if the ERP still carries its balance. Reversible, audited.
- ST-R22. **Data-hygiene signal (bonus):** the stale queue is itself worth surfacing to management — thousands of never-closed SO lines is an ERP-discipline gap. Optionally cross-check `qty_balance` against `qty_order − qty_delivered` and against FG out-mutations (`tbl_1179`) to auto-flag "delivered but not closed" (the status="DO" + balance>0 rows).

---

## 6. Functional requirements

**Core computation**
- ST-R1. `on_hand(sku)` = ERP Live FG `qty` for that SKU (mirrored). Never edited in LeadScout.
- ST-R2. `open_commitment(sku)` = Σ `qty_balance` of **live** SO lines (approved + `qty_balance>0` + ETA within window — the liveness rule, §5A ST-R17), grouped by canonical SKU. Stale lines are excluded and quarantined, never summed.
- ST-R3. `ATP(sku)` = `on_hand − open_commitment ± manual_adjustment`. **Derived on every read, never stored** (grouped subtraction, never per-row mutation).
- ST-R4. ATP may go **negative** — that is a real, valuable signal (committed beyond stock ⇒ production needed), surfaced as a shortfall, not clamped to zero or blocked.

**Sync & idempotency**
- ST-R6. Incremental SO + Live FG sync on the `updated_at` cursor; re-running a sync is idempotent (upsert mirror rows by primary key; recompute ATP).
- ST-R7. A late/failed sync degrades gracefully: last-known mirror stays readable with a stale-data banner; alerts if a sync hasn't succeeded in N intervals.

**Sales-facing view (`/stock`)**
- ST-R8. Per SKU: name, on-hand, committed, **ATP (the headline number)**, ETA of nearest incoming (later), freshness. Search/filter by brand, warna, thickness, dimensions.
- ST-R9. Read-only for sales — no booking action. Selling happens by creating an SO in the ERP; the ATP simply reflects it on the next sync. (Optional low-priority: deep-link "buat SO" guidance.)
- ST-R10. Clear states: *Tersedia* (ATP>0), *Habis* (ATP≤0, on-hand>0 all committed), *Kosong* (on-hand=0), *Perlu Produksi* (ATP<0 / unmatched demand).

**PPIC-facing view (`/stock-ppic`)**
- ST-R11. Shortfall queue replaces the old verify queue: SKUs where committed > on-hand (+incoming), ranked by deficit and nearest `estimate_delivery`. This is the demand→production trigger (feeds F1 / production runs).
- ST-R12. **Manual adjustment**: PPIC can post a signed adjustment per SKU (reason required) for corrections and stock-opname reconciliation vs `tbl_1324 DBStockOpnameFG`. Adjustments are audited and shown separately from ERP on-hand; they never overwrite the mirror.
- ST-R13. Per-SKU history: on-hand trend, the open SO lines committing against it (with customer/rep/ETA from `tbl_1202`), recent FG mutations (`tbl_1179`), and manual adjustments — one timeline.

---

## 7. "Approved" — the commitment gate

SO detail carries **two** approval signals plus an order status: `approval` (e.g. `Waiting`/`Approved`), `auto_approval` (`Approved`/`Not Approved`), and `status_order` (e.g. `Waiting`/`Done`).

- ST-R7a. A line **commits** when it is approved for real — v1 rule: `approval = 'Approved'` **and** `qty_balance > 0` **and** `status_order` not in a cancelled/void state. `Done` lines have `qty_balance = 0` so they fall out naturally.
- ST-R7b. Finalize the exact enum values (approval states, cancelled/void status strings, deleted-line handling via `tbl_1359_SOSalesOrderDetailNDeletedID`) during ST-R5.2 validation — the rule is expressed as config, not hard-coded (OQ-1).

---

## 8. What's removed & migration

**Removed:** `stock_bookings` writes, the six booking statuses, overbooking detection, the PPIC verify/approve/reject/complete queue, LAMA long-booking tracker, and the `POST /uploads` Excel ingest with `stock_items`/`stock_uploads` as the inventory source.

**Migration:**
- ST-R14. Freeze bookings at cutover; archive `stock_bookings`/`stock_items`/`stock_uploads` read-only (data kept, not deleted) for audit and any in-flight reconciliation.
- ST-R15. Endpoint compatibility: `GET /api/stock/summary` keeps working but now returns ATP-shaped data (on_hand/committed/atp) instead of qty_initial/bookings, so the page migrates without a URL break; the booking POST endpoints are removed (410) — the sales page no longer calls them.
- ST-R16. Run old and new **side by side in shadow** for one cycle: compute ATP from SO while bookings still run, compare against booking-derived available, and reconcile discrepancies before flipping `/stock` to ATP. (Mirrors the auth `shadow` rollout pattern.)

---

## 9. Optional next term — incoming production

Once F1 production runs / `tbl_1236_DBRequestProduksiID` are mirrored, extend the formula to Available-to-Promise-with-supply:

```
ATP+(sku) = on_hand − open_commitment + incoming_production(within horizon) ± manual_adjustment
```

so a SKU that's committed-out but has a run landing before the SO's `estimate_delivery` reads as *promiseable with date*, not *habis*. This is the natural bridge from the stock tracker into F1 demand planning; specced there, flagged here.

---

## 10. Parity, non-goals, edge cases

- PAR. The `/stock` and `/stock-ppic` URLs, role gating (`stock-sales`, `stock-ppic`), and Bahasa UI survive; only the underlying model changes. Behavior parity is defined here as *correct ATP*, not preservation of booking mechanics (which are intentionally dropped).
- Non-goals v1: RM (raw material) ATP — FG only first (RM has its own Live RM / Mutasi RM tables; same pattern later). No pre-SO reservations for quotes (a deliberate rejection of dual commitment sources — SO is the single source). No multi-warehouse ATP split in v1 (aggregate on-hand; `lokasi`/`gudang` is a later dimension — OQ-2).
- Edge cases to honor: SO line **edited** (qty change) → next sync recomputes, no drift; SO line **cancelled/deleted** → drops out of commitment automatically; **partial delivery** → `qty_balance` already reflects it; **returns** → appear as ERP FG mutations raising on-hand; **negative ATP** → surfaced, never hidden; **unmatched SKU** → exceptions tray (ST-R5.3).

---

## 11. Open questions

- OQ-1. Exact SO approval/status enum values + cancelled/void handling + deleted-line table semantics (resolve in ST-R5.2 validation).
- OQ-2. Warehouse granularity: single aggregate ATP now, or per-`gudang` (Live FG has `lokasi`; there are per-warehouse Live FG tables)?
- OQ-3. Does any real demand live **outside** SO (internal transfers `tbl_1328`, samples/SPB `tbl_1235`)? If so, should those also reduce ATP, or only SO?
- OQ-4. Sync cadence vs load — is 2–5 min acceptable to sales, or is near-real-time (30–60s) wanted for hot SKUs?
- OQ-5. Should the ERP's own `buffer_qty`/`buffer_status` on Live FG factor into ATP (treat buffer as not-promiseable)?

---

*This PRD replaces the stock portion of the master PRD's phase B. Everything else in `leadscout-2.0-prd.md` stands.*
