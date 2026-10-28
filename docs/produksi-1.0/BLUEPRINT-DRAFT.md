# Produksi 1.0 — Blueprint (DRAFT — not yet frozen)

**Status: BLOCKED on ERP table documentation.** This document holds what is
decided independent of the ERP's shape, and names precisely what is missing.
It becomes the frozen Blueprint — the thing every work package compiles
against, as `docs/stock-2.0/CONTRACTS.md` was — once §0 is answered.

Nothing in here may be implemented against a guessed column name. The Stock 2.0
build lost two cycles to exactly that: `kode_barang` 42703 on every page, and a
SKU key that could never match, both from assuming a column existed because it
was plausible. See `docs/stock-2.0/HANDOVER.md` §7 A1–A31.

---

## 0 · What is missing (the blocker)

**Correction (2026-10-28).** An earlier draft of this section said neither table
"appears anywhere in this repo". That was wrong, and the owner was right to push
back. The original Stock 2.0 PRD already named several production-side tables;
they were carried into `GO-LIVE.md` and the stock contract as future work and
then forgotten. What follows is what is actually known.

### 0.0 Known table names (from the Stock 2.0 PRD, not yet verified against the ERP)

| Table | What it is | Why it matters here |
|---|---|---|
| `tbl_1236_DBRequestProduksiID` | **Request Produksi** | The owner's "tbl request produksi" |
| `tbl_1179_STMutasiFGMX` | **FG mutations** | Actual finished-goods movement. Likely the real "movement" source — more central than first credited |
| `tbl_1324_DBStockOpnameFG` | Stock opname / physical count | Reconciliation; may explain movements with no order behind them |
| `tbl_1328` | Internal transfers | Named in the PRD as possible demand outside SO (OQ-3) |
| `tbl_1235` | Samples / SPB | Same |

**Work Order is still unidentified.** It is the one name that genuinely has to
come out of `GET <base>/tables`.

None of these have **column lists**, and a name without columns is not enough to
build against — `tbl_1203` was correctly named from the start and still produced
a SKU key that could never match, because its columns were assumed rather than
read. Names narrow the probe; they do not replace it.

### 0.1 Still required before any work package opens:

| # | Needed | Why it blocks |
|---|---|---|
| 0.1 | The **Work Order** table name | The one name not already known; `SELARAS_ENDPOINTS` keys off the literal string, and a wrong one is a 404 per page |
| 0.2 | Their full column lists | Adapters, mirror DDL and every metric are column-level |
| 0.3 | The join between them | "could be matched to this" (owner) — the key is unknown; it may be a WO number, a request id, or an SO reference |
| 0.4 | How a row says *where it is* in the flow | Status enum? timestamps? separate rows per stage? Determines whether "movement" is derivable at all |
| 0.5 | Whether **raw-material** movement exists in a table at all | See §1 — this is the open product risk, not just a missing column |
| 0.6 | Whether these tables carry `updated_at` and `deleted_at` | The mirror's cursor and soft-delete handling both assume them; `so_line` taught us a large population can carry NULL `updated_at`, reachable only by full pull |

**Reachability — the actual blocker.** Credentials are not missing and the API
guide is not missing: auth (`X-Secret-Key` / `X-Secret-Token`), the endpoint
shapes (`<base>/tables`, `<base>/table/{t}/columns`, `<base>/table/{t}`) and
pagination are all documented in `docs/stock-2.0/GO-LIVE.md`. What is missing is
**network reach**: this environment's egress proxy refuses `selaras2.io` with
403 at CONNECT (verified 2026-10-26 and 2026-10-28), and refuses the Railway app
domain too.

Production reaches the ERP fine. Railway logs are readable from here. So the
schema comes back through a one-shot discovery probe run in production and read
out of the logs — not by asking the owner to transcribe documentation they have
already pointed at twice.

---

## 1 · The open product risk: "raw material" may not be in these two tables

The owner asked for *"movements from raw material to finished goods"* and named
Request Produksi and Work Order. Those two plausibly cover **demand → order →
output**. They do not obviously cover **material consumption**.

If raw-material issue lives in a separate table (a material-issue, BOM, or
warehouse-movement table), then with only these two we can show *production
orders moving*, not *material moving*. Those are different dashboards and the
difference is not cosmetic: a plant manager asking "where did my aluminium go"
cannot be answered by work-order status.

**This must be resolved before building, not discovered after.** Either:
- a raw-material movement table exists and is named here, or
- the dashboard's scope is explicitly narrowed to the order pipeline, and the
  page says so rather than implying coverage it does not have.

Carrying an unstated gap is the failure mode AMENDMENT 16 was ruled on: the
person harmed is the one reading the screen, not the one who knows the caveat.

---

## 2 · Decided, and independent of ERP shape

### 2.1 Derived, never stored
Every figure recomputes from the mirror on read. No incremental counters, no
materialised daily totals that drift. This is Stock 2.0 §3 carried over, and it
is carried over *because* the 1.0 stock module double-subtracted by mutating
incrementally.

A daily production total that is stored is a daily production total that will
disagree with its own source by month three.

### 2.2 One liveness/stage predicate, spelled once
Whatever decides "this WO is in progress", it is written **once**, as a SQL
view, and every surface reads that view. Stock 2.0 §7.3 (`v_live_commitments`)
exists because the same predicate written twice drifts.

### 2.3 Time bucketing is a contract, not a detail
`daily | weekly | monthly | custom` is the owner's explicit requirement. The
rules below hold regardless of which columns feed them:

- **One timezone, declared.** Asia/Jakarta (UTC+7). A "day" is a Jakarta day.
  Bucketing in UTC silently moves evening activity to the next day — a 7-hour
  shift that makes every daily figure wrong near the boundary, and wrong in a
  way nobody notices until a month is compared against a shift log.
- **Buckets are half-open** `[start, end)`. Adjacent buckets never double-count
  a row and never drop one.
- **Weeks start Monday** (ISO-8601), stated on the screen. A week that starts
  Sunday for one reader and Monday for another is two different numbers wearing
  one label.
- **Custom ranges are inclusive of both endpoints as the user reads them** and
  translated to half-open internally. The UI says the dates it used.
- **Empty buckets render as zero, not as absent.** A day with no production is a
  fact; a missing bar is a rendering accident. They must not look the same.
- **An out-of-range or inverted custom range is refused with a reason**, never
  silently clamped.

### 2.4 The date basis must be named on screen
"Movements per day" is ambiguous until it says *which date*. A work order
created on the 3rd, started on the 5th and finished on the 9th appears in a
different bucket under each basis. The dashboard names the basis it used, in
the UI, not only in the docs. Changing basis is a user-visible choice or a
stated constant — never an unlabelled default.

### 2.5 Mirror discipline, inherited
New tables join the existing sync machinery rather than growing a second one:
cursor + `resume_page`/`resume_cursor` (the fix for the 429 loop — see
`docs/stock-2.0/HANDOVER.md`), pacing via `STOCK_SYNC_PAGE_DELAY_MS`,
soft-delete via `deleted_at`, and a documented position in `SYNC_TABLES`.

**Pull-order warning.** `live_fg` is first deliberately: physical stock is the
freshest half of the ATP subtraction, and it starved when it ran last. Adding
two more tables to the same budget risks starving it again. Either the budget
grows or production pulls on its own schedule — decided before merge, with a
counter proving which tables actually completed per run.

### 2.6 Honest empty states
The mirror starts empty and backfills. Every panel must be correct and
unembarrassing with zero rows, and must distinguish **"no production that day"**
from **"not synced yet"**. Stock 2.0 shipped coating as a column of "belum
tercatat" chips standing down behind one sentence rather than 812 blanks; the
same discipline applies here.

---

## 2A · Ruled by the owner (2026-10-28)

### 2A.1 Date basis — **each stage on its own date**

A row contributes to **every** bucket its stages fall in: requested on the 3rd,
started on the 5th, finished on the 9th means three buckets, not one.

**Consequence, which must not be papered over:** there is no single "production
that day" number. Stage counts cannot be summed across stages — a row counted at
request and again at completion is the same physical work, and adding them
invents output that never existed. The dashboard therefore reports **per-stage
series**, never a blended total, and no panel may add two stages together.

This is the same class of error the 1.0 stock module made by mutating stock
incrementally and double-subtracting. The arithmetic is different; the failure —
one real thing counted twice — is identical.

### 2A.2 Audience — **management, "are we keeping up overall"**

Not the floor view. Trend and comparison lead; operational detail is available
but not the first thing on screen. Exception-led: the screen should make a bad
week obvious without the reader hunting for it.

**Tension to resolve in design, stated here so it is not resolved by accident:**
management wants a headline, and 2A.1 says there is no single headline number.
The resolution is that the headline is **flow**, not volume — how much entered
each stage versus how much left it, over the chosen period. A stage where intake
consistently exceeds output is the bottleneck, and that is the thing a manager
asking "are we keeping up" is actually asking. Reporting a single fabricated
"total production" to satisfy the wish for one number would be the wrong answer
to the right question.

### 2A.3 Raw material — **to be determined from the ERP itself**

The owner's answer: *"These are tables that are available in XTable/selaras. You
should have the credentials for it."*

Credentials are not the obstacle — this environment cannot reach `selaras2.io`
at all (403 at CONNECT from the egress proxy, verified 2026-10-26 and again
2026-10-28). Production can. So §0 and §1 are answered by a one-shot schema
discovery probe run in production and read back through Railway logs, rather
than by asking the owner to transcribe documentation.

**§1's risk stands until that probe reports.** If no raw-material movement table
exists, the dashboard's scope narrows to the order pipeline and the page must
say so on screen. That is a finding to report, not a gap to quietly absorb.

---

## 3 · Questions carried to the owner

1. Scope of "raw material" — §1 above.
2. Primary audience and the one question the dashboard must answer at a glance.
3. The date basis for "daily" — §2.4.
4. Whether the two named tables are the whole flow or the start of it.

---

## 4 · Not decided here

Metric definitions, the panel set, the page route, thresholds, and anything
naming a column. All of it waits on §0. Writing it now would be writing fiction
with the authority of a spec.
