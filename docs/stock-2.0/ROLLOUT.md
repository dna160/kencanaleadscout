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
| G1 | `pnpm -r build` clean | CI | ✅ |
| G2 | `pnpm --filter @kencana/server test` green | CI | ❌ **blocked — see §1** |
| G3 | TS↔SQL `sku_key` parity green | `test/sku.test.ts` (515 fixtures incl. 400 fuzz) | ✅ |
| G4 | Black Galaxy worked example reproduces | `test/atp.test.ts` | ✅ |
| G5 | §7.6 partition holds on a seeded population | `test/atp.test.ts` | ❌ **blocked — see §1** |
| G6 | Boots with no `DATABASE_URL`, no `SELARAS_BASE_URL` | manual, both suites skip cleanly | ✅ |
| G7 | ST-R5.2 fill/overlap validation run against live ERP | §3 runbook — **cannot run yet** | ⛔ blocked on credentials |
| G8 | ST-R16 shadow cycle reconciled and signed off | §2 | ⛔ not started |
| G9 | Cold-start calibration pass with PPIC | §4 | ⛔ not started |

**G2/G5 are release blockers, not flakes.** They are a single real defect,
described immediately below. Do not ship around them, and do not "fix" them by
weakening the test — the test is asserting the frozen contract.

---

## 1. Open release blocker (found by WP-7, owned by WP-1)

**`AMENDMENT 1` is specified in `CONTRACTS.md` but is not implemented in
`apps/server/src/db/migrateErpStock.ts`.** The commitment views still carry the
pre-amendment ETA predicate and no `undated` column:

```ts
// migrateErpStock.ts, current
["v_live_commitments",  spine(`l.estimate_delivery >= current_date - ${windowDays}`)],
["v_stale_commitments", spine(`l.estimate_delivery <  current_date - ${windowDays}`)],
```

A NULL `estimate_delivery` satisfies neither comparison, so an approved,
undelivered, undated line falls out of **both** views: it reserves nothing,
appears in no review queue, and silently inflates ATP by its whole balance.
Confirmed against the live database — the pre-existing fixture line `L5`
(`qty_balance = 700`, `estimate_delivery IS NULL`) is invisible to both views
today. That is a breach of invariant §7.6 and of the amendment itself, and it
over-promises stock, which is the failure direction AMENDMENT 1 exists to close.

`stock-atp.ts` (WP-3) **has** implemented its half — it reads
`v_live_commitments … where estimate_delivery is null` for the PPIC undated
filter — so the endpoint returns an empty list rather than an error. The defect
is silent on every surface.

**The fix is two edits in one file, and it is verified.** `create or replace
view` accepts an appended trailing column, so WP-1's drop-cascade fallback is not
even exercised:

```ts
const spine = (etaPredicate: string) => `
  select l.*, h.customer_name_text, h.sales_name_text, h.so_number,
         (l.estimate_delivery is null) as undated          -- AMENDMENT 1
  ...
`;
["v_live_commitments",  spine(`(l.estimate_delivery >= current_date - ${windowDays}
                                or l.estimate_delivery is null)`)],
["v_stale_commitments", spine(`l.estimate_delivery <  current_date - ${windowDays}`)],
```

(The stale predicate is already correct: `<` excludes NULL, so undated lines stay
out of the stale queue, exactly as the amendment requires.) Applying that view
body in a rolled-back transaction on the live database empties the §7.6 residual
and turns all seven failures green. **WP-1 owns the change; WP-7 does not write
feature code to make its own tests pass.**

---

## 2. ST-R16 — the shadow cycle

`STOCK_ATP_SHADOW` exists so 1.0 and 2.0 can be read side by side for one full
business cycle before `/stock` flips. Shadow mode computes ATP and records it;
**1.0 booking numbers stay authoritative on the sales page** for the duration.

### 2.1 What is compared

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

`STOCK_ATP_SHADOW=false`, redeploy, `/stock` serves ATP. Drop `shadow_sku_map`
and the temporary views. Keep the reconciliation output — it is the audit trail
for the decision.

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
3. **One calibration pass.** Take the top 30 SKUs by on-hand and by live
   commitment. PPIC reads the ATP figure and says *plausible / not plausible* from
   their own knowledge. This is a gut check, not an audit — it is looking for an
   order-of-magnitude error, not a unit discrepancy.
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

### 5.1 The ladder — cheapest first

| Level | Action | Time | Reverses |
|---|---|---|---|
| **L0** | `STOCK_ATP_SHADOW=true`, redeploy | ~1 min | The flip. 1.0 numbers authoritative again, 2.0 keeps computing silently. |
| **L0b** | Unset `SELARAS_BASE_URL`, redeploy | ~1 min | The ERP link. `hasErp=false` ⇒ worker never starts, every surface renders "ERP tidak terhubung", **the app still boots and serves** (§7.7). Mirror data is retained and readable. |
| **L1** | Revert the deploy to the previous commit/image | ~5 min | All 2.0 code: routes, pages, worker. Restores 1.0 bookings. |
| **L2** | Drop the 2.0 schema | ~10 min + data loss | Last resort. See §5.3. |

**L0/L0b are the answer in almost every incident.** Reach for L1 only for a
crash-looping or data-corrupting defect. L2 should essentially never happen.

### 5.2 Code rollback (L1)

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
  real cost of L1 and the reason L0 exists.**
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
during the shadow cycle (§2) — an absolute number chosen before seeing real data
is a guess.

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
| X3 | **HTTP route behaviour** — `/summary`, `/sku/:key`, `/shortfall`, `/stale-commitments`, `/exceptions`, `/adjustments`, the 410s, the `state` ladder | WP-7's files are `sku.test.ts` and `atp.test.ts`; route tests belong to the route packages and none were written. WP-7 tested the schema, views and formula the routes sit on. | **Medium-high.** The ATP *math* is proven; the *serialization* of it is not. Specifically untested: the §4.1 `state` derivation order (`perlu_produksi` must outrank `habis`), the 410 bodies, `atp_m2` conversion, the shortfall ranking, pagination. **Recommend WP-3/WP-4 add `test/stockAtpRoutes.test.ts` before the flip.** |
| X4 | **The sync worker** — idempotency, cursor discipline, the `running` guard, cursor-does-not-advance-on-failure | `test/erpSync.test.ts` is WP-7's package on paper but was assigned to another agent and has not landed. Nothing in this suite exercises `syncWorker.ts`. | **High.** ST-R6 idempotency is the acceptance criterion for the whole mirror design and is currently **unverified**. §2's five-day shadow window is the compensating control: a non-idempotent sync would show as day-over-day ATP drift. That is detection, not prevention. |
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

---

## 9. Change log

| Date | Change | By |
|---|---|---|
| 2026-09-11 | First draft: shadow plan, ST-R5.2 runbook, cold start, rollback, monitoring, exclusions. Release blocker §1 raised against WP-1. | WP-7 |
