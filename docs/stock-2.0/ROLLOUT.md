# Stock 2.0 — ROLLOUT, VALIDATION & ROLLBACK

> **Owner:** WP-7 (QA & Deployment). **Status:** plan, not yet executed.
> Read with `CONTRACTS.md` (the frozen blueprint) and `HANDOVER.md` §2
> (known unknowns). Everything here is written to be executed under pressure by
> somebody who did not write it — every step is a command or a query, and every
> query states the decision it drives.

---

## 0. Release gate — what must be true before anyone deploys

| # | Gate | How it is checked | Status |
|---|---|---|---|
| G1 | `pnpm -r build` clean | `tsc -p apps/server` | ✅ |
| G2 | `pnpm --filter @kencana/server test` green | 196 tests, 4 files | ✅ |
| G3 | TS↔SQL `sku_key` parity | `test/sku.test.ts` — 515 fixtures (115 hand-written + 400 seeded fuzz), compared against live `erp_sku_key()` output | ✅ |
| G4 | Black Galaxy worked example reproduces | `test/atp.test.ts` — 4,168 − 319 = **3,849**, 1,810 quarantined | ✅ |
| G5 | §7.6 partition holds on a seeded population | `test/atp.test.ts` — live/stale disjoint, residual empty, holds under confirm-close | ✅ |
| G6 | Boots with no `DATABASE_URL`, no `SELARAS_BASE_URL` | manual; both DB suites skip cleanly rather than fail | ✅ |
| G7 | Sync idempotency + cursor discipline (ST-R6/R7) | `test/erpSync.test.ts` (WP-2) | ✅ |
| G8 | Route-level behaviour (§4, AMENDMENTS 3–9) | **no test file exists** — see §7 X3 | ⛔ **gap** |
| G9 | ST-R5.2 fill/overlap validation against live ERP | §3 runbook — **cannot run yet** | ⛔ blocked on credentials |
| G10 | ~~ST-R16 shadow cycle reconciled and signed off~~ | §2 | 🚫 **NOT BUILT — cannot be run as specified.** Booking writes are retired and `STOCK_ATP_SHADOW` is inert, so there is no parallel path to run alongside. **Replaced by G9 + G11 (§2.0.2), which are now the go-live gate.** Costed in §2.6; recommendation is not to build it. |
| G11 | Cold-start calibration pass with PPIC | §4, procedure in §2.0.2 | ⛔ not started — **now gate-blocking**, since it absorbs G10's role |

**G9 and G11 are sequencing, not defects: they need credentials and a business
cycle. G10 is a defect in the plan, not in the sequencing — see §2.0.1. G8 is a
real hole and the only one that can be closed today** — see §7 X3.

---

## 1. Resolved during this cycle — AMENDMENT 1 was specified but not built

Recorded because the failure mode is instructive and the regression tests exist
to keep it closed.

WP-7 found that `migrateErpStock.ts` shipped the commitment views with the
**pre-amendment** ETA predicate and no `undated` column. `NULL >= x` and
`NULL < x` are both NULL, so an approved, undelivered, **undated** line matched
neither view: it reserved nothing, appeared in no queue, and silently inflated
ATP by its whole balance. Reproduced against the live database on the
pre-existing fixture line `L5` (`qty_balance = 700`, `estimate_delivery IS NULL`),
invisible to both views. A breach of AMENDMENT 1 and of invariant §7.6, in the
over-promising direction.

It was silent on every surface. WP-3 had implemented **its** half correctly —
`stock-atp.ts` reads `v_live_commitments … where estimate_delivery is null` for
the `segment=undated` filter — so the endpoint returned an empty list rather than
an error. Nothing logged, nothing 500'd, ATP simply read high.

WP-1 has since landed the fix (the `or l.estimate_delivery is null` arm and the
`undated` column). Seven tests in `test/atp.test.ts` now pin it, including the
§7.6 partition property, which caught the same defect **independently of the
amendment tests** — the case for asserting the partition as a property rather
than only by example.

**Lesson for the checklist: an entry in an assumption log is not evidence that
the code implements it.** Every amendment needs a test that fails before it lands.

---

## 2. ST-R16 — the shadow cycle was NOT BUILT, and cannot be run as specified

> **Status: not implemented. Not a scheduling slip — the design is unbuildable
> against the code that shipped.** Do not plan the go-live around it. The gate
> that replaces it is §2.0.2, and it is a real gate, not a downgrade dressed up
> as one.

### 2.0.1 Why the side-by-side cycle cannot be run

ST-R16 specifies running 1.0 and 2.0 **in parallel** for one business cycle:
compute ATP from SO **while bookings still run**, compare the two numbers daily,
reconcile, then flip. That requires two live systems. Only one exists.

1. **The booking write path is retired, not gated.** `POST /api/stock/bookings`
   and its four siblings answer **410 Gone** unconditionally (`routes/stock.ts`,
   CONTRACTS §4.3); `POST /api/stock/uploads` likewise. No flag re-opens them —
   the handlers contain no branch, only the tombstone.
2. **`stock.html` has no booking affordance left in the DOM** — no rep picker,
   no qty field, no book modal (§8 checks this deliberately). There is no surface
   on which a 1.0 number could be authoritative, and no way for a rep to create
   the booking that would make a 1.0 number move.
3. **`STOCK_ATP_SHADOW` is inert** — defined in `config.ts`, read by nothing
   (§5.1.1). The one lever the plan named does not exist in executable form.

So the 1.0 side of the comparison would be a **frozen Excel snapshot with a
frozen booking ledger**, aging by one day per day of the cycle. Comparing 2.0
against it does not measure 2.0; after five business days it mostly measures how
stale the snapshot has become. §2.4 already conceded the two numbers "are not
expected to be equal" — with writes retired, the gap is *guaranteed* to widen
monotonically for reasons that have nothing to do with ATP correctness. That is
not a reconciliation. It is a decaying baseline wearing one.

**The §2.1–2.5 material below is retained as a historical record of the intended
design and as the starting point if shadow mode is ever built for real (§2.6).
It is not a runbook. Nothing in it is executable today.**

### 2.0.2 What replaces it as the go-live gate

Two things that **do** exist and **can** be run, and they must both be signed off
before `/stock` is trusted:

| # | Gate | Where | What it proves |
|---|---|---|---|
| **A** | **ST-R5.2 validation runbook** — Q1 fill rate, Q2 unmatched tail, Q3 exceptions-tray volume, Q4 segment ablation, Q5 key-drift sanity | **§3** | That commitments actually *find* their stock. A wrong SKU key is the failure mode that produces confidently wrong ATP, and Q1/Q3 are its detector. Run it against a **fully backfilled** mirror, not a partial pull. Q1 or Q3 red ⇒ do not ship. |
| **B** | **Cold-start calibration pass against PPIC's expectations** — §4 step 3, widened | **§4** | That the numbers are *plausible to the people who know the stock*. This is the only check of ATP against reality that does not require a second system. |

**Gate B, stated precisely** (the §4 wording was one line; it is now load-bearing,
so it gets a procedure):

1. Take the **top 30 SKUs by on-hand** and the **top 30 by live commitment** —
   two lists, because the failure modes differ: the first catches a broken
   `erp_live_fg` pull, the second a broken commitment join.
2. For each, PPIC states **from their own knowledge, before seeing the screen**,
   roughly how much of it they believe is free to sell. Then read them the ATP.
   Asking first is the whole method — a number shown first anchors the answer and
   the pass measures nothing.
3. Record `plausible` / `not plausible` **per SKU, in writing, with PPIC's name
   against it**. Anything `not plausible` is root-caused before go-live; there is
   no accept-and-log class here, because unlike §2.4 there is no second system to
   attribute the gap to.
4. Sanity-check the two headline aggregates against PRD §5A's verified figures:
   the Black Galaxy worked example (4,168 − 319 = 3,849, 1,810 quarantined) and
   the ~95% stale rate across the open set. A wildly different stale proportion
   means the liveness window or the approval enum (OQ-1) is mis-tuned, not that
   the ERP changed.
5. **Tune `STOCK_STALE_WINDOW_DAYS` once**, per §4 step 4, and record the value
   and the reason. Repeated tuning destroys the trust the stale queue depends on.

**What this gate does NOT prove, and you must say so out loud when you sign it:**
it is a plausibility check by one team against their own recollection, not a
measured reconciliation against an independent system. It catches
order-of-magnitude errors, a dead join, a mis-tuned window, a truncated mirror.
It will **not** catch a systematic few-percent bias. ST-R16 was specified
precisely to catch that class, and with it unbuilt, **that class of error ships
undetected.** Run §6.4 (negative-ATP breadth) and §6.3 (exceptions volume) from
day one with a tight baseline; they are the production substitute, and they are
lagging indicators, not a gate.

The closest thing to a true A/B remains available at **zero build cost** and
should be used on day one: the §3 Q1 `qty_fill_pct` and §6.2 `key_drift` queries
run against production and answer "is the join sound?" — which is the question
the shadow cycle was mostly going to answer anyway.

### 2.6 What we would have to build to get real shadow mode

Costed, so the option is a decision rather than a thing nobody wrote down. Only
worth it if a stakeholder needs a *measured* pre-flip reconciliation rather than
gate B's plausibility pass.

| # | Work | Rough size | Note |
|---|---|---|---|
| 1 | Un-retire the 1.0 write path behind the flag: `POST /bookings` ×5 and `POST /uploads` serve their 1.0 handlers when `config.stock.atpShadow`, and the 410 otherwise. | ~1 day | The handlers were **gutted, not deleted** — §5.2, the git history has them. This is the smallest piece, and the only one that is mostly recovery rather than new code. |
| 2 | Restore the booking UI in `stock.html` behind the same flag: rep picker, qty field, book modal, and the 1.0 `available` column rendered **alongside** ATP. | ~2–3 days | The largest and most objectionable piece: it re-introduces, into a page that is now cleanly read-only, the exact affordances §8 exists to confirm are gone. It also needs `/summary` to serve both numbers, which means the 1.0 shape back in a contract that deliberately replaced it (ST-R15). |
| 3 | Actually read the flag: branch in `routes/stock-atp.ts` (or ahead of it) on which number is authoritative, and surface "mode bayangan" on both pages so nobody mistakes a shadow number for a real one. | ~0.5 day | Cheap in code, but it puts a mode switch into the one path CONTRACTS §0 insists has exactly one behaviour. Every route test then needs both modes. |
| 4 | The `shadow_sku_map` ops artifact and the daily reconciliation job (§2.2–2.3), plus PPIC's hand-mapping of the top 100 SKUs. | ~1 day build + **~1 week of PPIC's time** | The PPIC week is the real cost and it is not ours to spend. §2.2 already flags there is no automatic join between 1.0 `stock_items` and 2.0 `kode_barang`. |
| 5 | Run it: five consecutive business days, daily reconciliation, PPIC review of the top 20 (§2.4). | **≥ 1 business week, wall clock** | Cannot be compressed — §2.4 is right that one day cannot distinguish "the ERP is right" from "the ERP was mid-posting". |

**Total: roughly one engineer-week of build, a week of PPIC's time, and a further
week of elapsed cycle before anything can flip — to buy a reconciliation against
a snapshot that is itself aging.** The recommendation is **do not build it.**
Take gate §2.0.2, ship behind a fast L0 revert (§5.1) with the re-upload cost
understood in advance, and spend the week on the G8 route-test gap instead, which
is a real uncovered risk (§7 X3) rather than a hedge against a known-stale
baseline.

**If it is built anyway, item 3 is non-negotiable and must land first:** a flag
that nothing reads is how this section came to be wrong in the first place.

---

## 2.1–2.5 · HISTORICAL — the intended shadow design (not executable)

> Retained per §2.0.1. These sections describe a comparison that cannot be run
> against the shipped code. Do not follow them as a runbook; use them as the
> starting design if §2.6 is ever funded.

### 2.1 What was to be compared

Per SKU, once a day at 17:00 local (after the day's SO entry has settled):

| 1.0 side | 2.0 side |
|---|---|
| `available = qty_initial − Σ booking qty` on the **active** upload | `atp = on_hand − live commitment + adjustment` |

```sql
-- 1.0 booking-derived availability, active upload only (ST-R14 archive is frozen)
create temporary view shadow_10 as
with active as (
  select id from stock_uploads where status = 'active' order by created_at desc limit 1
), booked as (
  select b.item_id, sum(b.qty) as qty
  from stock_bookings b
  -- CONFIRM this status set against routes/stock.ts before the first run; it is
  -- the one place the 1.0 semantics are not written down in the schema.
  where b.status in ('confirmed','overbooked','approved','outstanding')
  group by 1
)
select i.id as item_id, i.name, i.product_line, i.warna, i.th, i.mm, i.p, i.l, i.unit,
       i.qty_initial,
       coalesce(bk.qty, 0)              as booked_10,
       i.qty_initial - coalesce(bk.qty, 0) as available_10
from stock_items i
join active a on a.id = i.upload_id
left join booked bk on bk.item_id = i.id;

-- 2.0 ATP, exactly the CONTRACTS §0 formula
create temporary view shadow_20 as
select f.sku_key,
       sum(f.qty)                                as on_hand,
       coalesce(max(c.committed), 0)             as committed_20,
       coalesce(max(s.stale), 0)                 as stale_20,
       coalesce(max(adj.delta), 0)               as adjustment,
       sum(f.qty) - coalesce(max(c.committed), 0) + coalesce(max(adj.delta), 0) as atp_20
from erp_live_fg f
left join (select sku_key, sum(qty_balance) committed from v_live_commitments  group by 1) c   on c.sku_key   = f.sku_key
left join (select sku_key, sum(qty_balance) stale     from v_stale_commitments group by 1) s   on s.sku_key   = f.sku_key
left join (select sku_key, sum(qty_delta)   delta     from stock_adjustments   group by 1) adj on adj.sku_key = f.sku_key
group by f.sku_key;
```

### 2.2 The mapping problem — solve it first, it is the long pole

**1.0 `stock_items` has no `kode_barang`.** It carries `product_line` (free-text
BRAND from the Excel), `warna`, `th` (aluminium thickness), `mm` (panel
thickness), `p`, `l`. 2.0 keys on ERP `kode_barang`. There is no automatic join.

Build the map once, by hand, as an **ops artifact** — not app schema, and it is
dropped before go-live:

```sql
create table if not exists shadow_sku_map (
  item_id    bigint primary key,
  sku_key    text,               -- null = deliberately unmapped
  mapped_by  text not null,
  note       text,
  created_at timestamptz not null default now()
);
```

Seed it with the **top 100 SKUs by 1.0 booking volume** (that is where the money
is; a full map is not worth the week it would cost):

```sql
select i.id, i.name, i.product_line, i.warna, i.th, i.mm, i.p, i.l, sum(b.qty) as booked
from stock_items i join stock_bookings b on b.item_id = i.id
group by 1,2,3,4,5,6,7,8 order by booked desc limit 100;
```

PPIC fills `sku_key` for each. An item PPIC cannot map is itself a finding — it
means a product line sales books against has no clean ERP identity.

### 2.3 The daily reconciliation

```sql
select m.item_id, s10.name, m.sku_key,
       s10.available_10, s20.atp_20,
       s20.atp_20 - s10.available_10                                   as delta,
       round(100.0 * (s20.atp_20 - s10.available_10)
             / nullif(s20.on_hand, 0), 1)                              as delta_pct_of_onhand,
       s20.on_hand, s10.qty_initial, s10.booked_10,
       s20.committed_20, s20.stale_20, s20.adjustment
from shadow_sku_map m
join shadow_10 s10 on s10.item_id = m.item_id
left join shadow_20 s20 on s20.sku_key = m.sku_key
where m.sku_key is not null
order by abs(coalesce(s20.atp_20, 0) - s10.available_10) desc;
```

### 2.4 What a tolerable discrepancy looks like

The two numbers **are not expected to be equal**, and a plan that demands
equality will never flip. 1.0 `available` descends from a hand-uploaded Excel
snapshot of unknown age; 2.0 descends from the ERP. The shadow is a
**reconciliation**, not an equality check: every material gap must land in a
named bucket.

| Class | Pattern | Verdict |
|---|---|---|
| **A — blocks the flip** | Gap with **no** explanation in classes B–D. Or a *state* disagreement (1.0 shows sellable, 2.0 shows `habis`/`perlu_produksi`, or the reverse) on any of the **top 20 by booking volume**. Or `on_hand` differing from `qty_initial` by >20% on a SKU PPIC asserts was counted this week. | Stop. Root-cause before flipping. |
| **B — explain and accept** | Gap ≈ `stale_20`. 2.0 is quarantining phantoms 1.0 never knew about. This is the product working. Record the number. | Accept, log. |
| **C — explain and accept** | Gap ≈ snapshot age: `qty_initial` is an old upload and `on_hand` has moved. Confirm with one ERP spot-check. | Accept, log. |
| **D — explain and accept** | Unit mismatch: 1.0 `unit <> 'lembar'`. 2.0 is lembar-canonical (ST-R5.4). Exclude from the numeric comparison and count separately. | Accept, exclude. |
| **E — ignore** | SKU present in only one system (`sku_key is null`, or no `erp_live_fg` row). Counted, not compared. | Ignore. |

**Flip criteria — all four, in writing, signed by PPIC:**

1. Zero Class A findings open.
2. ≥ 95% of mapped, comparable (non-D) SKUs are within ±2% of `on_hand`, **or**
   are classified B/C with a one-line reason recorded against the row.
3. The top 20 by booking volume are individually reviewed by PPIC and accepted.
4. At least **5 consecutive business days** of runs with no ST-R7 stale-sync
   alert and no unexplained day-over-day swing greater than 10% of `on_hand`.

One full cycle means five business days, not one run. A single day cannot
distinguish "the ERP is right" from "the ERP was mid-posting".

### 2.5 Flipping

> **Historical.** As shipped there is nothing to flip: `/stock` serves ATP from
> the moment 2.0 deploys, and `STOCK_ATP_SHADOW` is inert (§5.1.1). The go-live
> decision is the §2.0.2 sign-off, and the deploy itself is the flip. Reversing
> it is §5.1 L0 — a code revert, not a flag.

*As designed:* `STOCK_ATP_SHADOW=false`, redeploy, `/stock` serves ATP. Drop
`shadow_sku_map` and the temporary views. Keep the reconciliation output — it is
the audit trail for the decision.

---

## 3. ST-R5.2 — the validation runbook (**run the hour credentials land**)

This is the measurement `HANDOVER.md` §2 says could not be run. The canonical key
composition in `CONTRACTS.md` §1 is **provisional until this runs**. Run it
against a populated mirror — i.e. after the sync worker has completed at least
one full backfill of `erp_live_fg` and `erp_so_line`, not against a partial pull.

### Q1 — headline fill rate (the number that decides everything)

```sql
with demand as (
  select sku_key, sum(qty_balance) as qty, count(*) as lines
  from v_live_commitments group by 1
), supply as (
  select distinct sku_key from erp_live_fg
)
select
  count(*)                                                              as demand_skus,
  count(*) filter (where s.sku_key is not null)                         as matched_skus,
  round(100.0 * count(*) filter (where s.sku_key is not null)
        / nullif(count(*), 0), 2)                                       as sku_fill_pct,
  sum(d.qty)                                                            as demand_qty,
  sum(d.qty) filter (where s.sku_key is not null)                       as matched_qty,
  round(100.0 * sum(d.qty) filter (where s.sku_key is not null)
        / nullif(sum(d.qty), 0), 2)                                     as qty_fill_pct
from demand d left join supply s on s.sku_key = d.sku_key;
```

**`qty_fill_pct` is the number that matters**, not `sku_fill_pct` — a long tail of
one-off unmatched SKUs is harmless; an unmatched high-volume SKU is not.

**Decision:**

| `qty_fill_pct` | Decision |
|---|---|
| **≥ 90%** | Ship the v1 five-segment key unchanged. Go to Q3 to size the exceptions tray. |
| **75–90%** | Inspect the unmatched tail (Q2). If it is dominated by genuine make-to-order items that have *never* had an FG row, ship v1 — those belong in the exceptions tray by design (ST-R5.3). If it is dominated by items that obviously exist in stock under a slightly different spelling, run Q4. |
| **< 75%** | Do **not** ship v1. Run Q4 and change `STOCK_SKU_KEY_SEGMENTS`. |

### Q2 — who is missing, ranked by what it costs

```sql
select d.sku_key, d.lines, d.qty,
       (select count(*) from erp_live_fg f where f.kode_barang = l.kode_barang) as fg_rows_same_kode
from (select sku_key, count(*) lines, sum(qty_balance) qty
      from v_live_commitments group by 1) d
join lateral (select kode_barang from erp_so_line
              where sku_key = d.sku_key limit 1) l on true
where not exists (select 1 from erp_live_fg f where f.sku_key = d.sku_key)
order by d.qty desc limit 50;
```

`fg_rows_same_kode > 0` is the smoking gun: **the product exists in stock and only
a dimension segment is preventing the match.** That is a key-composition problem,
not make-to-order, and it is what Q4 fixes.

### Q3 — projected exceptions-tray volume

```sql
select count(*) as exception_lines,
       sum(qty_balance) as exception_qty,
       round(100.0 * sum(qty_balance)
             / nullif((select sum(qty_balance) from v_live_commitments), 0), 2) as pct_of_live_qty
from v_live_commitments c
where not exists (select 1 from erp_live_fg f where f.sku_key = c.sku_key);
```

**Expected shape.** PRD §5A measured 4,376 open lines of which ~218 are live, so
the live set is small. The exceptions tray should be a **PPIC-reviewable list, not
a firehose**.

| `pct_of_live_qty` | Reading | Action |
|---|---|---|
| **≤ 5%** | Healthy. Genuine make-to-order demand. | Ship. |
| **5–15%** | Watch. Review the top 20 with PPIC; if they are real make-to-order, ship and monitor. | Ship with the §6 alert baselined here. |
| **> 15%** | **The key composition is wrong.** This is the exact signal `HANDOVER.md` §2 says to expect — a bad key shows up as a flood of exceptions, not as wrong ATP. | Run Q4 before shipping. |

### Q4 — segment ablation (which composition to adopt)

No code change is needed to measure this: passing `NULL` for a segment pins it to
the constant `'-'`, which is exactly what dropping it would do.

```sql
with k as (
  select qty_balance, kode_barang, warna, th, p, l,
> ⚠️ **SUPERSEDED — this SQL will not execute.** It calls the v1 five-argument
> `erp_sku_key(kode_barang, warna, th, p, l)`. The verified Selaras schema showed
> the SO line table carries **no `kode_barang` and no `th`**, so the key moved to
> the six-argument form over `brand, warna, th, th_panel, p, l`, and the migration
> explicitly drops the old overload. **Use `docs/stock-2.0/GO-LIVE.md` §4 for the
> live ST-R5.2 ablation** — it is written against the current function. The block
> below is kept only so the reasoning behind the ablation is still readable.

    erp_sku_key(kode_barang, warna, th,   p,    l)    as k5,  -- v1
    erp_sku_key(kode_barang, warna, th,   p,    null) as k4,  -- drop l
    erp_sku_key(kode_barang, warna, th,   null, null) as k3,  -- drop p, l
    erp_sku_key(kode_barang, warna, null, null, null) as k2,  -- kode + warna
    erp_sku_key(kode_barang, null,  null, null, null) as k1   -- kode only
  from v_live_commitments
), fg as (
  select
    array_agg(distinct erp_sku_key(kode_barang, warna, th,   p,    l))    as f5,
    array_agg(distinct erp_sku_key(kode_barang, warna, th,   p,    null)) as f4,
    array_agg(distinct erp_sku_key(kode_barang, warna, th,   null, null)) as f3,
    array_agg(distinct erp_sku_key(kode_barang, warna, null, null, null)) as f2,
    array_agg(distinct erp_sku_key(kode_barang, null,  null, null, null)) as f1
  from erp_live_fg
)
select
  round(100.0*sum(k.qty_balance) filter (where k.k5 = any(fg.f5))/nullif(sum(k.qty_balance),0),2) as fill_k5,
  round(100.0*sum(k.qty_balance) filter (where k.k4 = any(fg.f4))/nullif(sum(k.qty_balance),0),2) as fill_k4,
  round(100.0*sum(k.qty_balance) filter (where k.k3 = any(fg.f3))/nullif(sum(k.qty_balance),0),2) as fill_k3,
  round(100.0*sum(k.qty_balance) filter (where k.k2 = any(fg.f2))/nullif(sum(k.qty_balance),0),2) as fill_k2,
  round(100.0*sum(k.qty_balance) filter (where k.k1 = any(fg.f1))/nullif(sum(k.qty_balance),0),2) as fill_k1
from k cross join fg;
```

Fill only ever rises as segments are dropped, so fill alone would always argue for
`k1`. The counter-pressure is **false merges** — distinct physical products
collapsing into one key and pooling their stock:

```sql
-- How many genuinely different products would a shorter key merge?
select 'k2' as composition,
       count(*) filter (where variants > 1) as merged_keys,
       sum(qty) filter (where variants > 1) as merged_qty,
       round(100.0 * sum(qty) filter (where variants > 1) / nullif(sum(qty),0), 2) as merged_qty_pct
from (
  select erp_sku_key(kode_barang, warna, null, null, null) as k,
         count(distinct erp_sku_key(kode_barang, warna, th, p, l)) as variants,
         sum(qty) as qty
  from erp_live_fg group by 1
) t;
-- repeat with the k3 / k4 expressions
```

**Adopt the SHORTEST composition whose qty-weighted fill ≥ 90% AND whose
`merged_qty_pct` < 1%.** A false merge is strictly worse than an exception: an
exception is a visible queue entry, a false merge is a wrong ATP that nobody sees.
If no composition satisfies both, keep `k5` and take the exceptions — visible
under-matching beats invisible over-pooling.

### Q5 — sanity: the key is stable and injection-proof on real data

```sql
-- must be zero: no stored key may disagree with the function (config drift,
-- or a backfill that was skipped after a composition change)
select count(*) from erp_live_fg where sku_key <> erp_sku_key(kode_barang, warna, th, p, l);
select count(*) from erp_so_line where sku_key <> erp_sku_key(kode_barang, warna, th, p, l);

-- must be zero: a separator surviving inside a segment means a forged key
select count(*) from erp_live_fg
where array_length(string_to_array(sku_key, '|'), 1) <> 5;
```

### Applying a composition change

`sku_key` is a plain `text` column, not `GENERATED ALWAYS` (assumption A14) — so
changing the composition does **not** update stored keys. The full procedure:

1. Set `STOCK_SKU_KEY_SEGMENTS` (e.g. `kode_barang,warna,th`) and redeploy.
   Boot rebuilds `erp_sku_key()` **and** both views from the new list.
2. Backfill immediately — between the restart and this step, ATP is wrong:
   ```sql
   update erp_live_fg set sku_key = erp_sku_key(kode_barang, warna, th, p, l);
   update erp_so_line set sku_key = erp_sku_key(kode_barang, warna, th, p, l);
   ```
3. Re-run Q5. Both counts must be zero.
4. Re-run Q1 and Q3 and confirm the predicted fill and tray volume materialised.

Do this in a maintenance window. The TypeScript side needs no action — it reads
the same config through `resolveSkuSegments()`, and `test/sku.test.ts` proves the
two stay byte-identical.

---

## 4. ST-R19 — cold start: snapshot, not replay

There is **no historical consolidation and no backfill of past bookings**. ATP is
recomputed from current physical + current live commitments on every read, so the
system has no history to reconstruct.

1. **Backfill the mirror.** Start the worker with the cursor unset so the first
   run pulls everything (`updated_at__gte` empty ⇒ full page-through). Expect
   ~1.5k FG rows and ~137k SO lines. Confirm `erp_sync_state.rows_synced` and
   `last_ok_at` for all three tables.
2. **Run §3 Q1–Q5.** Do not proceed past a Q1/Q3 red.
3. **One calibration pass — now a release gate, not a gut check.** Take the top
   30 SKUs by on-hand and the top 30 by live commitment. PPIC states their own
   expectation **first**, then reads the ATP figure, and says *plausible / not
   plausible*. **Follow the full procedure in §2.0.2 gate B and record the result
   per SKU with PPIC's name against it** — with ST-R16 unbuilt (§2.0.1), this is
   the only check of ATP against reality before go-live, so it carries weight it
   was not originally given. It still will not catch a systematic few-percent
   bias; §2.0.2 says so explicitly and names §6.3/§6.4 as the production
   substitute.
4. **Tune the window, once.** If calibration shows systematic over-quarantining
   (PPIC insists lines older than 60 days are real), widen
   `STOCK_STALE_WINDOW_DAYS` and re-check. Views rebuild on boot; no migration.
   Record the chosen value and the reason. Change it once, then leave it —
   repeated tuning destroys the trust the stale queue depends on.
5. **Go live.** **Stale residue does not block launch.** ~4,158 stale lines are
   expected on day one; they are handled by the ST-R18 review queue at PPIC's
   pace, never by holding the release. The queue *is* the plan.

---

## 5. Rollback

Two independent axes. **Roll back code freely; do not roll back schema.**

### 5.1 The ladder

> **Read the "Actually reverses" column before picking a rung.** The rungs are
> **not** ordered cheapest-first, because the cheapest lever does not reverse the
> flip. Pick by symptom, not by price.

| Level | Action | Time to a working system | Actually reverses |
|---|---|---|---|
| ~~**L−1**~~ | ~~`STOCK_ATP_SHADOW=true`, redeploy~~ | — | **NOT IMPLEMENTED — the flag is inert. Nothing happens. Do not reach for this.** See §5.1.1. |
| **L0** | Revert the deploy to the previous commit/image | **~5 min to deploy, but not usable until PPIC re-uploads the Excel — realistically the rest of the working day** | All 2.0 code: routes, pages, worker. Restores 1.0 bookings. §5.2. |
| **L1** | Unset `SELARAS_BASE_URL`, redeploy | ~1 min | **Containment, not a rollback.** `hasErp=false` ⇒ the worker never starts and every surface renders "ERP tidak terhubung"; **the app still boots and serves** (§7.7). The mirror is retained, readable and **frozen** — `/stock` keeps serving ATP off the last-synced numbers behind the stale banner. Use it when the *sync* or the *ERP* is the problem. It does **not** bring 1.0 back and it does **not** help when ATP itself is wrong. |
| **L2** | Drop the 2.0 schema | ~10 min + data loss | Last resort. See §5.3. |

**There is no one-minute rung that reverses the flip.** That is the single most
important operational fact on this page, and the previous version of this table
said the opposite. L0 (code revert) is the real first rung for any defect in the
numbers, and it carries a real cost — see §5.2. L1 is the right first move only
when the symptom is a failing sync, a hammered ERP, or bad mirror data, because
it stops the bleeding in a minute without touching the deploy. L2 should
essentially never happen.

#### 5.1.1 Why `STOCK_ATP_SHADOW` is not a rollback lever

`STOCK_ATP_SHADOW` is **defined and never read.** It exists at
`apps/server/src/config.ts` (`config.stock.atpShadow`) and **no other file in the
repository consults it** — verifiable in one command:

```bash
grep -rn "atpShadow\|STOCK_ATP_SHADOW" apps/server/src packages
# → exactly one hit: the definition in config.ts
```

Setting it to `true` and redeploying changes **nothing**:

- `/stock` still serves ATP — `routes/stock-atp.ts` has no branch on the flag.
- The booking write endpoints still answer **410 Gone** (`routes/stock.ts`);
  there is no code path left that accepts a booking.
- `stock.html` has **no booking UI in the DOM at all** — no rep picker, no qty
  field, no book modal. There is nothing for 1.0 numbers to be displayed in.

So the flag cannot make "1.0 numbers authoritative again", because 1.0's write
path and 1.0's UI are both gone. An incident runbook whose first step is a no-op
is worse than no runbook: it costs you the minutes you spend believing it worked,
and it costs them at the exact moment they are most expensive.

**Decision for whoever owns this next:** either delete the config entry so it
cannot mislead, or build shadow mode for real (§2.6 costs it). Leaving a defined
flag that nothing reads is the one option that should not survive review.

### 5.2 Code rollback (L0)

Reverting to the pre-Stock-2.0 commit restores `routes/stock.ts` in full, and
with it the 1.0 booking and upload write paths.

- **The 1.0 tables are intact.** `stock_uploads`, `stock_items`,
  `stock_bookings` were never altered or truncated — WP-4 only gutted the *write
  routes* to 410 and kept the archive reads (ST-R14). The data is exactly as it
  was at the moment of the flip.
- **Nothing was written to them while 2.0 was live**, because every booking and
  upload POST returned 410. So 1.0 resumes precisely where it stopped; there is
  no gap to reconcile and no reverse migration.
- **The Excel snapshot will be stale** by however long 2.0 ran. Before
  re-enabling sales bookings, PPIC must re-upload a current sheet. **This is the
  real cost of L0, and it dominates its time profile: the deploy takes five
  minutes, the re-upload takes as long as it takes PPIC to produce a current
  sheet.** The previous version of this document said a one-minute flag flip
  existed to avoid this cost. It does not (§5.1.1). Plan the rollback around the
  re-upload, and tell PPIC first, not after.
- **2.0 data written during the window is retained, not lost:**
  `stock_adjustments` and `stock_commitment_overrides` keep every row with its
  actor and timestamp. The reverted binary simply does not read them. Rolling
  forward again picks them straight back up.

### 5.3 Schema rollback (L2) — and why "the migration already ran" is fine

`migrateErpStock.ts` is **purely additive**:

- Adds `erp_live_fg`, `erp_so_line`, `erp_so_header`, `erp_sync_state`,
  `stock_adjustments`, `stock_commitment_overrides` — all new names.
- Adds `erp_sku_key()` and the two commitment views — all new names.
- Touches **no** 1.0 table: no `alter table`, no `drop`, no backfill, no rename,
  no data migration. `migrateStock.ts` is unchanged and still runs.

**Therefore: reverting a deploy after the migration has already run requires no
schema action at all.** The new objects become inert — nothing reads them,
nothing writes them, and they cost only disk. A reverted binary does not call
`runErpStockMigrations()`, so the views simply stop being recreated on boot and
sit at whatever definition they last had.

This is the property that makes the rollback safe, and it must be preserved: **if
a future change makes the 2.0 migration non-additive, this section is void and
the rollback plan has to be rewritten before that change ships.**

If the objects genuinely must be removed (a name collides with a later feature —
the only real reason), the order is views → function → tables, and **it destroys
audited data**:

```sql
-- DESTRUCTIVE. Loses every manual adjustment and every confirm-close decision.
-- Export first:
--   \copy stock_adjustments to 'adjustments.csv' csv header
--   \copy stock_commitment_overrides to 'overrides.csv' csv header
drop view if exists v_live_commitments cascade;
drop view if exists v_stale_commitments cascade;
drop function if exists erp_sku_key(text, text, numeric, numeric, numeric);
drop table if exists stock_commitment_overrides;
drop table if exists stock_adjustments;
drop table if exists erp_sync_state;
drop table if exists erp_so_line;
drop table if exists erp_so_header;
drop table if exists erp_live_fg;
```

The `erp_*` mirror itself is disposable — it is a cache of the ERP and a re-sync
rebuilds it. `stock_adjustments` and `stock_commitment_overrides` are **not**;
they are LeadScout-owned decisions that exist nowhere else. Export them or lose
them.

### 5.4 The one genuinely non-reversible step

Backfilling `sku_key` after a `STOCK_SKU_KEY_SEGMENTS` change (§3) overwrites the
previous keys in place. Rolling the config back **without re-running the backfill**
leaves stored keys disagreeing with `erp_sku_key()`, which silently breaks the
join in both directions.

- **Detect:** §3 Q5. Both counts must be zero. Wire it as an alert (§6).
- **Recover:** set the config back and re-run the two `update` statements. The
  keys are derived, so nothing is lost — but the window between the revert and
  the backfill serves wrong ATP. Do config changes and backfills together, in a
  maintenance window, never separately.

---

## 6. Monitoring

Everything here reads `erp_sync_state` or the mirror. Baseline each threshold
during the **cold-start calibration pass (§4 / §2.0.2 gate B)** — an absolute
number chosen before seeing real data is a guess. (The original text said "during
the shadow cycle"; there is no shadow cycle — §2.0.1. With ST-R16 unbuilt these
thresholds are load-bearing rather than supplementary: §6.3 and §6.4 are the only
things watching for the systematic bias the shadow cycle was meant to catch, so
baseline them on day one and treat a drift as a real signal.)

### 6.1 Sync liveness (ST-R7) — page

```sql
select table_name, last_ok_at, now() - last_ok_at as age, last_error, last_error_at, running
from erp_sync_state;
```

- **Alert:** any `now() - last_ok_at > STOCK_SYNC_STALE_ALERT_INTERVALS ×
  STOCK_SYNC_INTERVAL_MS` (default 4 × 3 min = **12 min**). Same threshold the
  `/stock` stale banner uses, so the alert and the UI never disagree.
- **Alert:** `running = true` for longer than 3× the interval ⇒ a crashed run
  left the guard set. The worker reclaims it, so a *repeating* one means crash
  looping.
- **Alert:** `last_error is not null and last_error_at > now() - interval '15 min'`.
- **Do not alert on a single failed poll.** The design is explicitly
  degrade-don't-die: the old mirror stays readable behind a banner.

### 6.2 SKU key health — page

```sql
-- both must be 0; non-zero = the TS and SQL sides have desynchronised
select (select count(*) from erp_live_fg where sku_key <> erp_sku_key(kode_barang,warna,th,p,l))
     + (select count(*) from erp_so_line where sku_key <> erp_sku_key(kode_barang,warna,th,p,l)) as key_drift;
```

This is the production twin of `test/sku.test.ts` and it catches what the test
cannot: a config change applied without a backfill (§5.4), or a hand-edited row.
**Any non-zero value is a page** — it means commitments are silently failing to
match stock, which is the highest-severity failure this system has.

### 6.3 Exceptions tray volume — the SKU-key smell detector

Run §3 Q3 hourly. Baseline `pct_of_live_qty` at go-live.

- **Warn:** > 1.5× baseline sustained for 6 h.
- **Alert:** > 2× baseline, or > 15% absolute.

A spike means demand has started arriving with SKUs the key cannot match — a new
product line, an ERP naming change, or a bad composition. Per `HANDOVER.md` §2,
this is the designed safety net: a bad key surfaces here, not as wrong ATP.

### 6.4 Negative ATP breadth (not depth)

```sql
with atp as (
  select f.sku_key,
         sum(f.qty)
         - coalesce((select sum(qty_balance) from v_live_commitments v where v.sku_key = f.sku_key), 0)
         + coalesce((select sum(qty_delta)   from stock_adjustments a where a.sku_key = f.sku_key), 0) as atp
  from erp_live_fg f group by f.sku_key
)
select count(*) filter (where atp < 0) as negative_skus,
       count(*)                        as total_skus,
       round(100.0 * count(*) filter (where atp < 0) / nullif(count(*),0), 2) as negative_pct
from atp;
```

A negative ATP on one SKU is a **feature** — it is the production trigger
(ST-R4/ST-R11) and must never be alerted on. Negative ATP across an *unusual
number* of SKUs is a defect signal (a sync that half-loaded `erp_live_fg`, a key
change without a backfill, a widened stale window).

- **Warn:** `negative_pct` > 1.5× the trailing 7-day median.
- **Alert:** `negative_pct` > 25%, or `total_skus` drops >20% day-over-day (the
  mirror is being truncated).

### 6.5 Stale queue trend — weekly, not an alert

Row count of `v_stale_commitments` and the count of overrides created per week.
Flat count with zero overrides means PPIC has abandoned the queue and ST-R18 is
not doing its job — a process signal for management (ST-R22), not a page.

### 6.6 Secrets (§7.9)

CI grep over the repo and over a sample of production logs for `SELARAS_TOKEN`,
`Bearer `, and the `DATABASE_URL` password. Cheap, and the failure mode is
permanent once it happens.

---

## 7. Deliberate exclusions — what is NOT tested, and the risk carried

Stated plainly. "Unverified" is a much better answer than a false claim.

| # | Not tested | Why | Risk carried |
|---|---|---|---|
| X1 | **The real Selaras API** — envelope shape, pagination, field casing, date format, whether `updated_at__gte` is real | No credentials, no base URL, no recorded response (`HANDOVER.md` §2). Everything is fixture-driven. | **High, but bounded.** If the shape is wrong the mirror stays empty and every surface reads "ERP tidak terhubung" — the app does not crash and does not serve wrong numbers. Mitigated by funnelling parsing through one `adaptRow()` per table. First contact with the live API is the single riskiest moment of this rollout; treat it as a change, with a rollback ready. |
| X2 | **ST-R5.2 fill/overlap on real data** | Same. §3 is the runbook for the moment it becomes possible. | **High.** The key composition is a guess (A3). A wrong key does not corrupt ATP silently — it floods the exceptions tray (§6.3). The measurement is a gate, not optional. |
| X3 | **HTTP route behaviour** — `/summary`, `/sku/:sku_key`, `/shortfall`, `/stale-commitments`, `/exceptions`, `/adjustments`, `/sync`, the 410s | WP-7's files are `sku.test.ts` and `atp.test.ts`; route tests belong to the route packages and **no route test file exists**. WP-7 proved the schema, the views and the formula the routes sit on. | **The largest remaining gap, and it grew.** The ATP *math* is proven; its *serialization* is not. Untested: the §4.1 `state` ladder (`perlu_produksi` must outrank `habis`), `atp_m2`, the 410 bodies, ST-R14 archive reads — plus everything the amendments added: **6a** `atp_delta`/`atp_before`/`atp_after` (the data-level consequence IS tested in `atp.test.ts`, the reported number is not), **6b** `close-batch` atomicity and the `expected_count` 409 guard, **6c** `segment=closed` (without which confirm-close is unrecoverable after a reload), **8** the `rows`/`total`/`grand_total`/`status_facets` envelope, `POST /sync` → 409, mandatory server-side `reason`, **9** `/shortfall` server-side ranking, **3** the frozen `/sku/:key` body, **4** pagination caps. **6b is the one to test first: an un-guarded batch close can release thousands of live commitments in one transaction.** Recommend WP-3/WP-4 add `test/stockAtpRoutes.test.ts` before the flip; treat G8 as blocking. |
| X4 | ~~The sync worker~~ — **now covered** | `test/erpSync.test.ts` (38 tests) landed after this document's first draft: fixture-driven idempotency, cursor-does-not-advance-on-first-page-failure, cursor holds at the last committed page, survives a total ERP outage without throwing, and `SELARAS_TOKEN` never reaches a log line on either path. | **Low, residual.** Still fixture-driven, so it proves the worker's *logic*, not the ERP's *shape* (X1). The suite also surfaced that the assumed A1 envelope is not the only shape the client tolerates — read its stderr warning during a real backfill. |
| X5 | **Both HTML pages** at 380px, in Bahasa, against empty/stale/populated ERP | Front-end packages; no browser harness in this repo. | **Medium.** Cosmetic and layout failures only — the pages are read-only over an API that is tested. The one substantive risk is a booking affordance surviving in the DOM; §8 makes that a manual checklist item. |
| X6 | **§7.2 "`erp_*` written only by the sync worker"** | Not expressible as a runtime test: any process with the connection string can write. | **Low.** Enforced by review and by the fact that no route imports the mirror for writing. A DB role with `select`-only on `erp_*` for the web process would make it structural; out of scope for v1. |
| X7 | **§7.7 "boots with no ERP and no database"** as an automated test | Config is a module-level singleton read once at import; faking it needs module-registry surgery that would make the suite fragile. Verified manually, and both suites demonstrably skip cleanly with `DATABASE_URL` unset. | **Low.** Regression would be caught on the first boot of any environment without a database. |
| X8 | **§7.9 "no secret is logged"** | Requires the client/worker and a log harness. | **Low-medium.** §6.6 covers it with a CI grep. |
| X9 | **Concurrency** — two syncs, or a sync and a read, racing | Single-process assumption; `running` guard untested (see X4). | **Medium.** A duplicated worker across two instances could double-page. Guard exists; unproven. |
| X10 | **Rule 3's "non-numeric → rule 2" fallthrough, TS↔SQL** | Unreachable by construction: `th`/`p`/`l` are `numeric` columns, so a non-numeric value can only exist on the TS side. `sku.test.ts` names each such fixture and asserts TS behaviour alone. | **Low.** Real only if a future change makes those columns `text`. |
| X11 | **Non-finite numerics (`NaN`, `±Infinity`) in a numeric segment** | A genuine parity hole, found and reported rather than fixed. `'NaN'::numeric` is legal in Postgres; `erp_sku_key` renders `'NaN'`/`'Infinity'` while the TS side renders `'-'` (number input) or `'NAN'` (string input). Nothing in the schema forbids storing one. | **Low likelihood, high impact.** Needs the sync worker to insert a non-finite value, which JSON cannot directly express. **Owner: WP-2** — reject non-finite numerics in `adaptRow()`. Alternatively add `check (th = th)` style guards to the mirror. §6.2's drift alert would not catch it (both sides are self-consistent); §6.3 would, as an exceptions spike. |
| X12 | **Load** — 137k SO lines, 4,376 open, the §4.1 grouped aggregate under real volume | Fixtures are tens of rows. | **Medium.** The indexes exist (`erp_so_line_live_idx`, both `sku_key` indexes). Run `explain (analyze, buffers)` on the `/summary` aggregate against the backfilled mirror during cold start (§4 step 2) **before** the calibration pass, and record the timing. A sequential scan over 137k lines on every page poll is the predictable failure. |

---

## 8. Manual pre-flip checklist

Things no automated test in this repo can cover.

- [ ] `/stock` at 380px: ATP is the headline number; **no** rep picker, **no**
      book modal, **no** qty field, **no** "Penuhi" hint anywhere in the DOM
      (`view-source`, not just visually).
- [ ] `/stock-ppic`: the Excel upload control is **removed from the DOM**, not
      hidden with CSS.
- [ ] All five PPIC tabs load against the real mirror; the stale queue pages and
      filters at ~4,158 rows without freezing.
- [ ] Confirm-close is one tap and the reinstate undo works (ST-R21).
- [ ] Freshness line shows a real timestamp; stop the worker and confirm the
      amber stale banner appears within the ST-R7 threshold.
- [ ] Unset `SELARAS_BASE_URL` in staging: both pages render "ERP tidak
      terhubung" and the app serves (§7.7, and the L0b rollback path).
- [ ] `POST /api/stock/bookings` returns **410** with the Bahasa body; `GET
      /api/stock/bookings` and `/uploads` still return frozen history (ST-R14).
- [ ] `explain (analyze)` on `/summary` against the full mirror — record it.
- [ ] Adjustment with no reason, and with `qty_delta = 0`, are both rejected.
- [ ] **AMENDMENT 6a:** close one *stale* line and one *undated* line from the
      UI and confirm the toast states the true consequence (`0` vs the whole
      balance). A wrong number here trains the operator to release stock.
- [ ] **AMENDMENT 6b:** a batch close with a deliberately wrong `expected_count`
      returns 409 and writes **nothing** — verify the rows are still open.
- [ ] **AMENDMENT 6c:** confirm-close a line, reload the page, and recover it via
      `segment=closed`. If reinstate is unreachable after a reload, do not flip.
- [ ] **AMENDMENT 5:** open `/api/stock/sku/:sku_key` for a SKU whose key contains
      a space and a `/`; confirm no double-decode and no 500 on a malformed
      escape (`%zz` must be 400).

---

## 9. Change log

| Date | Change | By |
|---|---|---|
| 2026-09-11 | First draft: shadow plan, ST-R5.2 runbook, cold start, rollback, monitoring, exclusions. Release blocker raised against WP-1 (AMENDMENT 1 unimplemented). | WP-7 |
| 2026-09-11 | WP-1 landed the AMENDMENT 1 fix; §1 rewritten as a resolved finding. `erpSync.test.ts` landed, closing X4. AMENDMENTS 3–9 folded into X3 and the §8 checklist. Suite green at 196 tests. | WP-7 |
| 2026-09-11 | **Traceability audit — two rollback/shadow claims in this document were false and are corrected.** (1) `STOCK_ATP_SHADOW` is defined in `config.ts` and read by no code: §5.1's L0 rung was a **no-op sold as the answer in almost every incident**. L0 is now the code revert with its real time profile (deploy is minutes; usability waits on PPIC's Excel re-upload), `SELARAS_BASE_URL` is demoted to L1 and relabelled containment-not-rollback, and §5.1.1 documents the inert flag with the `grep` that proves it. (2) ST-R16's side-by-side cycle **was never built and cannot be run as specified** — booking writes answer 410 unconditionally and the booking UI is out of the DOM, so there is no parallel path; §2 now says so, §2.0.2 promotes the ST-R5.2 runbook + a hardened PPIC calibration pass to the go-live gate, §2.6 costs real shadow mode (~1 engineer-week + ~1 PPIC-week + ≥1 week elapsed; recommendation: do not build), and G10 is marked NOT BUILT. §2.1–2.5 retained as historical design. | Traceability audit |
