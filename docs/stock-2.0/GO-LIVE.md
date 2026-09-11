# Stock 2.0 — GO-LIVE: the first live ERP connection

> **Owner:** QA & Deployment. **Status:** plan, not yet executed.
> **Executor:** the Lead Architect holds the deploy. Nothing in this file is run
> by its author.
>
> **Source state this was verified against:** branch
> `claude/vigilant-einstein-wuze2k`, **2026-09-11 09:25 UTC**, working tree
> (uncommitted). The ERP package was being actively edited while this was
> written; every log string below was re-verified with `grep` against that state.
> Re-run the checks in §1 before deploying — they are cheap and they are the
> point.
>
> **Read `ROLLOUT.md` first.** That document is the release plan for the module.
> This one is narrower and sharper: it covers the **single event**
> `ROLLOUT.md` could not cover, because it was written before anybody had seen
> the Selaras API — **the first time this code talks to the real ERP, which will
> happen in production.**
>
> | Question | Document |
> |---|---|
> | Is the module ready to ship at all? | `ROLLOUT.md` §0 (G1–G11) |
> | Why is there no shadow cycle? | `ROLLOUT.md` §2 |
> | What SQL measures the SKU join? | `ROLLOUT.md` §3 — **but see §4.0: its SQL no longer executes** |
> | What do we monitor forever? | `ROLLOUT.md` §6 |
> | What is untested, and what does that cost? | `ROLLOUT.md` §7 |
> | **What do I type, watch and grep on deploy day?** | **this file** |
> | **What breaks first, and which env var fixes it?** | **this file §3** |
> | **How do I get out of it in under a minute?** | **this file §5** |

**Why this file exists.** `ROLLOUT.md` §7 X1 calls first contact with the live
API *"the single riskiest moment of this rollout"* and says to treat it as a
change with a rollback ready. It does not say what that looks like. Since it was
written, four things changed that only a live-contact runbook can absorb:

1. **The real API spec arrived and the client was wrong in four ways.** The
   endpoint path (404 on every call), the auth header names, the primary-key
   convention, and — most seriously — **the SKU join key**, which was built from
   columns that do not exist on the SO line table. That last one would have made
   every commitment unmatched, ATP equal to on-hand, and the entire inventory
   read as promiseable.
2. **The SKU key is now six segments** (`brand|warna|th|th_panel|p|l`), not the
   five `ROLLOUT.md` §3 was written against. Every query in `ROLLOUT.md` §3 calls
   `erp_sku_key(kode_barang, warna, th, p, l)` — a function signature the
   migration now **explicitly drops**. See §4.0.
3. **Credentials are staged in Railway with deploys skipped**, so the deploy
   itself is the moment of first contact. There is no staging rehearsal:
   `selaras2.io` is unreachable from the sandbox and from CI by egress policy.
4. **The failure modes are now instrumented.** Every one of them has a dedicated
   log line that names the env var that fixes it. §3 is the index of those lines.

**The one sentence to keep in your head all day.** Every failure below except the
404 has the same shape: *a commitment that does not match its stock reserves
nothing, so `open_commitment` is 0, ATP equals on-hand, and the entire inventory
reads as promiseable on a page that looks perfectly healthy.* Nobody reports good
news. If you do one thing after the first sync, do §4.1.

---

## 1. Pre-flight — what must be true before the Architect deploys

### 1.1 P1 — build and tests green

```bash
pnpm -r build                                     # tsc -p apps/server
pnpm -r exec tsc --noEmit
DATABASE_URL=postgres://kencana:kencana@localhost:5432/leadscout \
  pnpm --filter @kencana/server test
```

**Status at 09:25 UTC:**

| Gate | State | Detail |
|---|---|---|
| `tsc --noEmit` | ✅ **green** | clean across the workspace |
| `vitest` | ⛔ **RED — 98 failed / 161 passed / 110 skipped** | **the test suites have not caught up with the v2 six-segment key.** `sku.test.ts` still asserts `resolveSkuSegments(["warna","kode_barang"])` returns `kode_barang`; `atp.test.ts` and `routes.test.ts` still seed `erp_so_line.kode_barang`, which the migration drops. |

**This is a test-suite lag, not a production defect** — the failures are fixtures
and assertions written against the retired five-segment key, not behaviour. It is
still a **hard deploy blocker**, and the reason is not bureaucratic: with the
suites red, *nothing* is guarding the v2 key, the ATP math or the HTTP contract.
`ROLLOUT.md` G2/G3/G4 are all currently unverified, and G3 (TS↔SQL `sku_key`
parity) is the single test that most protects this build.

**Do not deploy until this is green.** Record the passing count in the ticket;
the last committed figure was **315**.

### 1.2 P2 — the contract-conformance suite must have actually run

`test/selarasContract.test.ts` is the suite that matters most for this deploy,
and it is new since `ROLLOUT.md` was written. It drives the **real client**
end-to-end against a `MockAgent` built **from the verified specification, not
from our code**, with `disableNetConnect()` so a leaked real request fails
loudly. The mock is deliberately hostile:

- any path the spec does not define answers **404**;
- a request without `X-Secret-Key` / `X-Secret-Token` answers **401**;
- a filter on a column the documented schema lacks answers **400**.

**This is the only thing standing between us and discovering a wrong URL, a wrong
header name or a wrong primary key in production.** At 09:25 it passes
**44 tests, 1 skipped**.

```bash
pnpm --filter @kencana/server test -- selarasContract 2>&1 | tee /tmp/contract.txt
grep -E "Tests +[0-9]+ passed" /tmp/contract.txt
```

**The skip is the trap.** The suite's DB-backed block needs a real Postgres (an
upsert against a fake `Sql` proves nothing about `on conflict do update`) and
skips cleanly without one. So does `routes.test.ts`, which opens
`describe.skipIf(!hasDb)`. Combined with `vitest run --passWithNoTests`, **a green
run on a machine with no `DATABASE_URL` proves almost nothing.**

> **Green is not the check. *Not skipped* is the check.**

The sandbox has a Postgres for exactly this (`PROGRESS.md`, WP-1):
`postgres://kencana:kencana@localhost:5432/leadscout`. Always pass
`DATABASE_URL`, and confirm the skipped count is only the one known skip.

### 1.3 P3 — the worker, the client and the migration must agree

The v2 key remap touched four files. `tsc` **cannot** catch the most dangerous
half of a disagreement, because `postgres.js` takes column names as **strings**:
a column list that no longer matches the table compiles perfectly and raises
`42703` at runtime, on the first page of the first sync, with the cursor never
advancing and the demand side of ATP staying empty.

That exact defect existed in this tree at 09:12 and was fixed at 09:20. Keep the
gate — it is four greps:

```bash
# erp_so_line: the migration DROPS kode_barang, so the worker must not write it.
! grep -n 'insert into erp_so_line' -A 25 apps/server/src/erp/syncWorker.ts | grep -q '"kode_barang"'

# Both key columns must be written on BOTH tables (4 occurrences total: 2 inserts
# + 2 `on conflict do update` clauses each).
grep -c 'brand'    apps/server/src/erp/syncWorker.ts      # expect >= 4
grep -c 'th_panel' apps/server/src/erp/syncWorker.ts      # expect >= 4

pnpm -r exec tsc --noEmit
```

`erp_live_fg` **does** keep `kode_barang` (display only, not in the key), so a
hit there is correct. Only `erp_so_line` must be free of it.

Then prove it against real Postgres, not against the types — `pnpm test` with
`DATABASE_URL` set (P1). Nothing else catches this class.

### 1.4 P4 — variables verified present, by name and by mode

Staged in Railway with deploys skipped. Confirm each is present and non-empty.

| Variable | Value | Note |
|---|---|---|
| `SELARAS_BASE_URL` | **`https://selaras2.io/kencana/api`** | Verified 2026-09-11. The `/api` suffix belongs **in the variable**. **Not** `.../kencana/table_documentation` — that is the human-facing SPA and is the documented wrong turn. Trailing slash is fine, both forms work. |
| `SELARAS_AUTH_MODE` | `header` | Decides which of the two credential-name pairs is used. See the row below. |
| `SELARAS_SECRET_KEY` | secret | |
| `SELARAS_SECRET_TOKEN` | secret | |
| `SELARAS_KEY_PARAM` / `SELARAS_TOKEN_PARAM` | `secret_key` / `secret_token` | **Query-string names. Read only in `query` mode.** Staging them does nothing in `header` mode — see §1.5. |
| `SELARAS_KEY_HEADER` / `SELARAS_TOKEN_HEADER` | `x-secret-key` / `x-secret-token` | **Header names. These are what `header` mode actually sends.** The defaults are correct; leave unset. |
| `DATABASE_URL` | already set | Without it the app boots and every stock surface 503s |
| `SELARAS_NUMBER_FORMAT` | **leave unset** | Defaults to `auto` — refuses ambiguous numerics rather than guessing (A22). Do not set `id` or `en` until §3.5 shows you a real body. |
| `STOCK_APPROVED_STATUSES` | **leave unset for run 1** | Defaults to `Approved`, a guess (OQ-1). §3.6 is how you learn the real value. |
| `STOCK_SKU_KEY_SEGMENTS` | **leave unset for run 1** | Defaults to the v2 six. §4.4 is how you learn whether to shorten it. |
| `STOCK_ATP_SHADOW` | **do not set** | Inert, read by no code (`ROLLOUT.md` §5.1.1). |

**Do not pre-tune anything.** Every knob above has a log line in §3 that tells
you what to set it to. Setting them blind converts a diagnosable first run into
an undiagnosable one.

### 1.5 P5 — know which credential-name pair your mode reads

This caused a 401 once already and the shape of the trap survives the fix.
`config.ts` defines **four** credential-name variables, and the mode picks the
pair:

| `SELARAS_AUTH_MODE` | Reads | Sends |
|---|---|---|
| `header` (ours) | `SELARAS_KEY_HEADER` / `SELARAS_TOKEN_HEADER` | headers `x-secret-key:` / `x-secret-token:` |
| `query` | `SELARAS_KEY_PARAM` / `SELARAS_TOKEN_PARAM` | `?secret_key=&secret_token=` |
| `bearer` (legacy) | `SELARAS_TOKEN` | `Authorization: Bearer …` — **cannot authenticate against Selaras at all**, which issues a *pair* |

```bash
# Verify header mode reads the HEADER names, not the query names.
grep -n 'selarasAuthMode === "header"' -A 8 apps/server/src/erp/selarasClient.ts
# Expect `config.selarasKeyHeader` / `config.selarasTokenHeader` in that block.
# `config.selarasKeyParam` appearing there is the defect described below.
```

**The failure this prevents:** if `header` mode reads the *query* names, the wire
carries `secret_key:` instead of `X-Secret-Key:` and every call 401s. Verified
fixed at 09:20; the check is one grep and belongs in the pre-flight forever,
because the four variables are easy to cross-wire and the symptom is
indistinguishable from a wrong password.

If it can be reached at all, `curl` the ERP by hand once before the deploy. Thirty
seconds removes the most likely first failure entirely.

### 1.6 P6 — the stated expectation for the first sync

Write these down **before** the deploy. A sync that "looks fine" against no prior
expectation is not evidence of anything.

| Mirror table | ERP source | Expected rows after a **full** backfill | Meaning if materially lower |
|---|---|---|---|
| `erp_warna` | `tbl_1228_DBRMWarnaID` | **273** | Colour master truncated. Display only — `warna` is matched by **id**, so ATP is unaffected. |
| `erp_so_header` | `tbl_1202_SOSalesOrderNID` | **72,576** | Headers truncated ⇒ commitments lose customer / sales / `po_date`. The join is a `left join`, so ATP is unaffected but PPIC triage goes blind. |
| `erp_so_line` | `tbl_1203_SOSalesOrderDetailNID` | **137,580** | **Demand truncated ⇒ ATP reads HIGH.** The number that matters most. |
| `erp_live_fg` | `tbl_1210_STLiveFGMX` | **1,464** | Supply truncated ⇒ ATP reads low, and §4.1's unmatched rate spikes for the wrong reason. |

Derived expectations:

- **Last month of SO: ~1,396 lines.** This is the *incremental* expectation: once
  the backfill is done, a tick with a warm cursor should move tens of rows, not
  thousands. A second full-size pull means the cursor is not persisting.
- **~4,376 open lines** (`qty_balance > 0`), of which **~218 are live** and
  ~4,158 stale (PRD §5A). The stale queue is large on day one; `ROLLOUT.md` §4
  step 5 is explicit that stale residue does not block launch — the ST-R18 queue
  *is* the plan.
- **~95% stale** across the open set. A wildly different proportion means the
  liveness window or the approval enum is mis-tuned, not that the ERP changed.
- **Black Galaxy (`warna` id 4):** on-hand **4,168**, live **319**, **ATP 3,849**,
  1,810 quarantined. The one end-to-end number the business has independently
  verified. §4.6 checks it.

**Backfill shape.** 137,580 lines at `STOCK_SYNC_PAGE_SIZE=1000` is ~138 pages,
so the first `so_line` pass will overrun the 3-minute tick. That is expected and
safe: the in-process guard and the DB `running` guard make the next tick a no-op,
logged as `another sync run holds the guard — skipping this tick`. The
`MAX_PAGES_PER_TABLE` cap is 1,000, so it is not in play.

### 1.7 P7 — confirm both silent-catastrophe detectors are wired

Two functions in `db/migrateErpStock.ts` guard the two doors to the same
catastrophe. **Both must have call sites.** One of them did not, three minutes
before this was written.

```bash
grep -rn "checkCommitmentGate\|checkSkuKeyMatch" apps/server/src
```

| Detector | Catches | Wired at | State 09:25 |
|---|---|---|---|
| `checkCommitmentGate()` | `STOCK_APPROVED_STATUSES` does not match the ERP's `approval` enum | boot (`migrateErpStock`) **and** every sync tail (`syncWorker`) | ✅ |
| `checkSkuKeyMatch()` | demand and supply compute different `sku_key`s | every sync tail (`checkSkuKeyMatchAfterSync`) | ✅ **(wired 09:20; it was exported and never called at 09:12)** |

Both are **warn-only, latched** (they speak once, then stay quiet until they
recover) and both are wrapped so a diagnostic can never abort a sync run. If
either grep returns a definition with no call site, **the alarm for the most
expensive failure this module has will not fire**, and §3.7's SQL must be run by
hand after every sync on deploy day.

This is `ROLLOUT.md` §5.1.1's lesson (`STOCK_ATP_SHADOW`: defined, documented as
load-bearing, read by nothing) and §1's lesson (*an entry in an assumption log is
not evidence that the code implements it*) applied as a pre-flight check rather
than as a post-mortem.

---

## 2. The deploy sequence

In order. Each step has one reason. No step is optional.

| # | Action | Why this step exists |
|---|---|---|
| **D1** | Close §1.1 (tests green), then re-run §1.2, §1.3, §1.5, §1.7. | The known failures are in the build, not in the ERP. Deploying before they are closed spends the one first-contact window learning nothing. |
| **D2** | Record the deploy's **base commit SHA** in the ticket. | R2 (§5) is "revert to this SHA". Looking it up mid-incident costs the minutes the rung exists to save. |
| **D3** | Tell PPIC the window is open, and that a rollback may ask them for a fresh Excel. | `ROLLOUT.md` §5.2: the rollback's time profile is dominated by PPIC's re-upload, not by the deploy. Telling them first is the difference between a 5-minute rollback and a next-day one. |
| **D4** | Confirm the service is at **one replica**. | The `running` guard is real but unproven across processes (`ROLLOUT.md` X9). A duplicated worker could double-page a 138-page backfill. Railway setting, not a code risk. |
| **D5** | **Leave `SELARAS_BASE_URL` unset** and deploy the fixed build. | Separates "does the new code boot and migrate cleanly?" from "does the ERP answer?". This migration drops `erp_so_line.kode_barang` and recreates both views — observe that alone, with no ERP traffic. Expect `[erp-sync] disabled — SELARAS_BASE_URL not set` and both pages showing "ERP tidak terhubung" (invariant §7.7). |
| **D6** | Confirm the migration log is clean: **no** `step failed (non-fatal)` line, and exactly one `dropping erp_so_line.kode_barang` (first boot only, never again). | Every migration block is wrapped in a **non-fatal** try/catch, so a failed step does **not** fail the boot or the health check. A silent partial migration is entirely possible and this log is the only place it appears. |
| **D7** | `GET /api/stock/sync-status` — expect four rows (`warna`, `so_header`, `so_line`, `live_fg`), all `last_ok_at: null`, `running: false`. | Proves `erp_sync_state` seeded and the route is live, before any ERP variable can muddy the picture. |
| **D8** | Set `SELARAS_BASE_URL`. Deploy. **This is first contact.** | One variable, one redeploy, one thing in flight. If the next five minutes go wrong, R1 (§5) reverses it in a minute. |
| **D9** | Watch per **§3**, in the order §3 lists, **without touching anything for a full tick (3 min)**. | The failures arrive in a fixed order and each masks the next. Changing a variable at the first red line means the second is diagnosed on the *following* deploy instead of this one. |
| **D10** | Let the backfill complete (~138 pages on `so_line`). Wait for `[erp-sync] run ok`. | §4 — and `ROLLOUT.md` §3 — require a **fully backfilled** mirror. Run the validation against a partial pull and the fill rate is meaningless. |
| **D11** | `explain (analyze, buffers)` on the `/summary` aggregate against the full mirror. Record the timing. | `ROLLOUT.md` X12. A sequential scan over 137k lines on every page poll is the predictable failure, and it presents as a slow page, not an error. Do it **before** the PPIC pass, not after. |
| **D12** | Run **§4** end to end. | ST-R5.2, live, for the first time ever. |
| **D13** | Record the §4 numbers, the `STOCK_SKU_KEY_SEGMENTS` decision (**including "unchanged, because…"**), and the §4.7 PPIC sign-off in `PROGRESS.md`. Baseline `ROLLOUT.md` §6.3 / §6.4 on the figures you just measured. | `ROLLOUT.md` §6: a threshold chosen before seeing real data is a guess. This is the only moment the real data is in front of someone who knows what it should say. |

**Do not announce the flip to sales between D8 and D12.** ATP is served the moment
the mirror has rows; §4.1 is what says whether those numbers are *true*.

---

## 3. The first-sync watch

The heart of this document, **in the order the lines will appear.** Every string
below was verified present in the source with `grep` at 09:25. Where a string is
built by interpolation, the source template is given alongside the runtime text
so you grep for the part that is literal.

Prefixes: sync-worker lines carry `[erp-sync] ` and are pushed through
`redactSecrets()`; client lines carry `[selaras] `; migration and gate lines
carry `[migrateErpStock] ` or `[stock] `.

Railway: `railway logs`, or the service's Deploy Logs pane.

### 3.0 Boot — the lines that mean "we are live"

```
[erp-sync] started — every 180s, page size 1000
[erp-sync] mirror reconciliation started — every 60 min, abort floor 0.5 of mirrored rows (STOCK_RECONCILE_MIN_RATIO). …
```

If instead:

```
[erp-sync] disabled — SELARAS_BASE_URL not set; the stock mirror will not refresh and the ERP surfaces will show 'ERP tidak terhubung'.
```

…then D8 did not take effect — the variable is staged but the deploy was skipped
again. This line is also, deliberately, exactly what rung R1 (§5) produces.

### 3.1 A 401 — credentials or header names wrong · **most likely first failure**

```bash
grep -F "ERP REJECTED OUR CREDENTIALS"
```

Once per process per table, with its own unmistakable line — a 401 buried inside
a generic transport error reads like a hiccup and the sync merely looks stale:

```
[selaras] ERP REJECTED OUR CREDENTIALS — HTTP 401 on 'warna'. NOTHING will sync until this is
fixed: the mirror keeps serving whatever it already holds and every stock figure ages from here.
Auth mode 'header' is sending x-secret-key / x-secret-token (headers). Verified 2026-09-11:
Selaras wants X-Secret-Key + X-Secret-Token as headers, or ?secret_key= + ?secret_token= as query
params. Check SELARAS_SECRET_KEY / SELARAS_SECRET_TOKEN are both set (values never logged), that
SELARAS_AUTH_MODE matches how they were issued, and that SELARAS_BASE_URL is the API root
(…/kencana/api) and not the table_documentation page.
```

Alongside it, the per-page failure (template
`` `${table}: page ${page} failed — ${res.error}; cursor left at …` ``):

```
[erp-sync] warna: page 1 failed — HTTP 401 from ERP — credentials rejected (auth mode 'header'); see the [selaras] line above; cursor left at null
```

**Meaning.** The credential pair was rejected. 4xx is terminal for the run — no
retry, by design: *"a 401/404 is a configuration fault and hammering it twice
fixes nothing."* **The cursor is untouched and the mirror keeps whatever it had,
so a 401 is safe:** it yields an empty or frozen mirror behind the stale banner,
never a wrong number.

Expect it on **all four tables**, in sync order `warna → so_header → so_line →
live_fg`. **A 401 on one table only is not a credential fault** — it is a grant
that does not cover that table, and it is a Selaras-side ask.

**Fix — all config, in order of likelihood:**

1. **The mode/name pair (§1.5).** The line prints what it is sending. If it says
   `secret_key / secret_token (query params)` while `SELARAS_AUTH_MODE=header`,
   the mode is not what you think it is. If it says the header names and they are
   not `x-secret-key` / `x-secret-token`, set `SELARAS_KEY_HEADER` /
   `SELARAS_TOKEN_HEADER` back to the defaults.
2. **The secrets.** `SELARAS_SECRET_KEY` / `SELARAS_SECRET_TOKEN` present,
   non-empty, **not swapped**. A swap yields 401, not a distinct error.
3. **Not `bearer`.** In `bearer` mode the client sends `Authorization: Bearer
   <SELARAS_TOKEN>` and ignores the pair entirely. Selaras issues a pair, so
   bearer cannot authenticate at all.
4. **Fall back to `query`.** `SELARAS_AUTH_MODE=query` moves the credentials onto
   the URL under `SELARAS_KEY_PARAM` / `SELARAS_TOKEN_PARAM`. Both placements are
   documented and supported. Use this only if header mode cannot be made to work
   — a credential in a URL is the thing most likely to reach a log line, which is
   why `redactSecrets()` strips those parameter names by name.

**You will get no boot-time warning that credentials are missing.**
`hasErpCredentials` is exported from `config.ts` and read by nothing, so a base
URL with no secrets is indistinguishable at boot from a correct configuration. It
presents as this 401. See §6 U3.

### 3.2 A 404 — the endpoint path is still wrong

```bash
grep -F "no such endpoint. Rows come from"
```

```
[erp-sync] so_line: page 1 failed — HTTP 404 from ERP — no such endpoint. Rows come from
<base>/table/tbl_1203_SOSalesOrderDetailNID; check SELARAS_BASE_URL ends at /api; cursor left at null
```

**Meaning.** The URL does not exist. The client composes
`<SELARAS_BASE_URL>/table/<erp_table_name>`; the path segment and the table names
were corrected against the verified spec and are **not configurable**. So a 404
means the **base URL** is wrong.

**Fix — config, `SELARAS_BASE_URL` only:**

- The correct value is **`https://selaras2.io/kencana/api`**. The `/api` suffix
  belongs in the variable.
- The classic wrong value is the documentation SPA
  `https://selaras2.io/kencana/table_documentation`.
- Trailing slashes are harmless — both `…/api` and `…/api/` work.
- Prove the root by hand against the two sibling endpoints the sync does **not**
  use: `GET <base>/tables` and
  `GET <base>/table/tbl_1228_DBRMWarnaID/columns`.
- **404 on some tables but not all is not a base-URL problem** — it is a table
  name or a grant, and the table name needs a **code** change
  (`SELARAS_ENDPOINTS` in `erp/selarasClient.ts`). Say which.

A 404 is as safe as a 401, and for the same reason.

### 3.2b A 400 — an unknown filter or `order_by` column

```bash
grep -F "most likely an unknown filter or order_by column"
```

```
[erp-sync] so_line: page 1 failed — HTTP 400 from ERP — the request was refused, most likely an
unknown filter or order_by column for 'tbl_1203_SOSalesOrderDetailNID'
(GET <base>/table/tbl_1203_SOSalesOrderDetailNID/columns lists them); cursor left at null
```

**Meaning.** Auth and path are fine; the **query** is wrong. The sync sends
`updated_at__gte` + `order_by=updated_at`, so a 400 most likely means that table
does not have an `updated_at` column under that spelling.

**Fix: code**, not config. `buildPageUrl()` in `erp/selarasClient.ts` is the only
place the cursor column is named. Run the `/columns` endpoint the error names, and
say plainly that this one needs a one-file diff.

### 3.3 The envelope-shape notice — `meta` / `data` differ from the spec

```bash
grep -F "is NOT the assumed A1 shape"
```

```
[selaras] response envelope for 'so_line' is NOT the assumed A1 shape
{ data: [...], meta: { page, total_pages } } — observed: rows at 'records'; page count from 'total (rows → pages)'.
Parsing continued with the tolerated alternative. Fix A1 in erp/selarasClient.ts (readEnvelope) if this is the real shape.
```

**Meaning, and it has changed since `ROLLOUT.md`.** Assumption A1 turned out to
be **right**: the verified envelope is

```
{ success, table, meta: { count, total, total_pages, page, limit, offset, order_by, order_dir, filters }, data: [...] }
```

which matches A1 with extra fields. So this notice **should not fire at all**. If
it does, the spec we were given and the API we reached disagree — which is a
bigger finding than a parsing detail. The notice is emitted **once per (table,
shape) per process**; it is a notice, not a failure — rows were still parsed.

**Read the `observed:` clause. One variant is dangerous:**

| Observed | Reading |
|---|---|
| `rows at 'X'; page count from 'Y'` | Benign. Paging works. File the shape. |
| `rows at 'X'; **no page/row count**` | Paging now stops only on a short page (`rawCount < pageSize`). Correct, but §3.4's safety nets become the only bound on the run. |
| `**no row array** (keys: …)` | **Nothing was parsed.** The mirror stays empty and the run reports success with zero rows. **The one envelope outcome that looks like a clean sync and is not.** Cross-check §1.6: `run ok — 0 rows` after a full backfill window is this. |

**Fix: none is config, and that is by design.** `HANDOVER.md` §2 point 2 is that
all parsing funnels through one file precisely so the correction is a **one-file
diff in `erp/selarasClient.ts` (`readEnvelope`)** rather than a hunt. When you see
this line, the mitigation is working.

### 3.3b `success: false` under a 200

```bash
grep -F "with success=false for"
```

```
[erp-sync] so_line: page 4 failed — ERP answered 200 with success=false for
'tbl_1203_SOSalesOrderDetailNID' — the page was refused, so the cursor stays put and nothing was
mirrored from it (observed envelope: rows at 'data'; page count from 'total_pages'); cursor left at 2026-07-14T…
```

**Meaning.** The verified envelope carries a top-level `success`. A `false` is
treated as a **failed** page, never an empty one — an empty page would advance the
cursor past rows nobody ever saw, and the mirror would hold a stale commitment
forever with nothing in the log. **This is the correct, safe handling**; the
cursor stays put and the previous pages remain committed.

Recurring on the same page ⇒ a server-side fault on that page's range. Escalate
to Selaras rather than tuning anything. `STOCK_SYNC_PAGE_SIZE` can be lowered to
narrow the range and identify the offending rows.

### 3.4 Pagination and adapter sanity — three lines that bound a bad run

```bash
grep -F "no usable primary key"
grep -F "looks ignored"
grep -F "safety cap"
```

| Runtime line | Meaning | Action |
|---|---|---|
| `[erp-sync] so_line: dropped 1000 of 1000 rows on page 1 (no usable primary key)` | The adapter could not read `tbl_1203_SOSalesOrderDetailNID_id` on any row — field casing or the PK convention is wrong. **Dropped rows are silently absent and the run still reports success.** | **Code**: `primaryKeyField()` / the adapters' `pick()` name lists. A partial drop (`dropped 3 of 1000`) is normal noise; a **total** drop is a shape fault. |
| `[erp-sync] so_line: page 7 repeated page 6 verbatim — the 'page' query param looks ignored (assumption A2). Stopping this table; rows already committed are intact.` | The ERP ignores `page`. Detected rather than spun on. | **Code**: `buildPageUrl()` — the real paging parameter (`offset`, a cursor token) must replace `page`. Until then the mirror holds only page 1, i.e. a **truncated demand side ⇒ ATP high**. Treat as a blocker, not a note. |
| `[erp-sync] so_line: hit the 1000-page safety cap — pagination (A2) is probably wrong` | 1,000 × 1,000 ≫ 137,580 — the cursor or the paging is looping. | **Code.** Also check `STOCK_SYNC_PAGE_SIZE` was not set to something tiny. |

One more, and it is **informational, not a fault**:

```
[erp-sync] so_line: 12 row(s) on page 3 carry deleted_at — 12 removed from the mirror, none written
```

Every Selaras table carries a soft-delete marker; a non-null `deleted_at` means
the row is deleted upstream and it is removed from the mirror rather than
mirrored. This is the routine deletion path. A *large* count on the first
backfill is normal (history); a large count on a warm incremental run is worth a
question.

### 3.5 Ambiguous-number refusals — Indonesian-formatted numerics

Once per table per run, at the end of the pass, only when something was refused:

```bash
grep -F "ambiguous numeric string(s)"
grep -F "non-finite numeric(s)"
```

```
[erp-sync] so_line: refused 8412 ambiguous numeric string(s) e.g. "1.234", "0.350", "4.880" —
"1.234" is 1234 in id notation and 1.234 in en notation, so it was read as NULL/0 rather than
guessed (A22). Set SELARAS_NUMBER_FORMAT=id or =en once a real response body is known.
```

**Meaning.** Selaras sent numerics as **strings** in a genuinely ambiguous format,
and `SELARAS_NUMBER_FORMAT=auto` refused rather than guessed (A22, A30). JSON
*numbers* are never affected. A refused value becomes NULL, or `0` on a `not null`
column — and `qty_balance` is `not null default 0`, so **a refused balance
reserves nothing.** That under-promises rather than over-promises, which is the
deliberate trade: a guessed value can be wrong by 1000× silently.

**But a refused `th` / `th_panel` / `p` / `l` becomes NULL, which normalizes to
`'-'` in the key.** A wave of refusals on dimension columns therefore *also*
presents as a collapsed match rate in §4.1. **Diagnose this line before concluding
the key composition is wrong.**

**Fix — config, one variable, no code change.** The samples are the evidence:

| Samples look like | Set |
|---|---|
| `"4.880"`, `"1.220"` where the values are 4880 mm × 1220 mm | `SELARAS_NUMBER_FORMAT=id` |
| `"4,880"`, `"1,220"` for the same dimensions | `SELARAS_NUMBER_FORMAT=en` |
| **Both shapes in the same table** | **Stop.** Under a declared mode the reading is literal, with no heuristic (A30) — one mode will silently corrupt the other shape. Needs a per-field decision and a code change. |

`HANDOVER.md` A22 says *"A real response body decides the final default."* **This
log line is that response body.** Set the variable, redeploy, confirm the refusal
count drops to zero on the next run.

The sibling line — `refused N non-finite numeric(s)` — is X11 and should be
**zero**. Non-zero means the ERP emits `NaN` / `Infinity` in a thickness or
dimension column, which is an upstream computation fault. The guard is correct
(nothing was written); investigate upstream rather than tuning here.

### 3.6 The commitment gate — `approval` spelled differently

```bash
grep -F "COMMITMENT GATE MATCHES NOTHING"
```

Fires from the boot check **and** from the tail of every sync run, latched so it
speaks once:

```
[stock] COMMITMENT GATE MATCHES NOTHING — erp_so_line holds 137580 mirrored line(s) (4376 with
qty_balance > 0) but v_live_commitments is EMPTY. Every SKU's open_commitment is therefore 0 and
ATP equals on-hand: the whole inventory currently reads as promiseable. Configured approved
statuses: [Approved]. Distinct `approval` values actually in the mirror:
[APPROVED (4102), <null> (198), Approve (76)]. FIX: set STOCK_APPROVED_STATUSES to the value(s)
the ERP really emits (CSV) and restart — the views are rebuilt from it on every boot. ST-R7b / OQ-1.
```

**Meaning.** `STOCK_APPROVED_STATUSES` (default `Approved`, a guess — OQ-1) does
not match what the ERP emits. `v_live_commitments` is empty, `open_commitment` is
0 for every SKU, **ATP equals on-hand, and the whole inventory reads as fully
promiseable.** The failure nobody reports, because the screen looks like good
news.

**Fix — config, exact, no code change.** The line prints the observed values with
counts. Set the CSV of the ones that mean approved and **redeploy** — the views
are recreated from config on every boot, so a restart is required and a migration
is not:

```
STOCK_APPROVED_STATUSES=APPROVED,Approve
```

Confirm recovery:

```bash
grep -F "RECOVERED ST-R7b"
```

**Two traps on this line:**

- **It is latched, and it is legitimately silent in one case.** If every mirrored
  line has `qty_balance = 0`, the check stays quiet by design (warning there would
  fire on every boot forever and train people to ignore it). **Silence is not
  proof the gate matches — §4.1 is.**
- **An empty `STOCK_APPROVED_STATUSES` is never honoured.** A value that validates
  down to nothing falls back to `Approved` and logs
  `[migrateErpStock] STOCK_APPROVED_STATUSES validated down to an empty set`.
  Grep for it: it means your CSV was rejected by the `^[A-Za-z0-9 _-]{1,40}$`
  whitelist — a quote, a comma inside a token, a stray character. Fix the
  spelling, not the whitelist.

The cancelled set (`STOCK_CANCELLED_STATUSES`, A5) fails the **other** way: an
unmatched cancelled value keeps a cancelled line reserving, so ATP is
**understated** and somebody complains. There is no alarm for it and none is
needed — that is the safe direction.

### 3.7 The unmatched-rate alarm — the SKU key does not resolve on real data

```bash
grep -F "SKU KEY MATCHES ALMOST NOTHING"
```

Fires from the tail of every sync run, latched, at `log.error` rather than `warn`
because a 100% unmatched rate means ATP silently equals on-hand across the
catalogue:

```
[erp-sync] [stock] SKU KEY MATCHES ALMOST NOTHING — 4361 of 4376 live commitment line(s) (99.7%,
806 of 812 distinct sku_key(s)) match NO row in erp_live_fg. Those commitments reserve nothing, so
ATP equals on-hand for their SKUs and that stock reads as fully promiseable. Demand-side keys e.g.
[-|004|0.3|4|4880|1220 , …]; stock-side keys e.g. [ALUCOMAX|004|0.3|4|4880|1220 , …]. Compare them
segment by segment: the knob is STOCK_SKU_KEY_SEGMENTS (current composition
brand|warna|th|th_panel|p|l), and the per-side column mapping is SKU_SEGMENT_SOURCES in erp/sku.ts.
Alert threshold 0.5 (STOCK_UNMATCHED_ALERT_RATIO). ST-R5.2 / ST-R5.3.
```

**Meaning.** Demand and supply compute different keys for the same physical
product. **The same silent over-promise as §3.6, arriving through a different
door.** A few unmatched keys are normal — that is what the ST-R5.3 exceptions tray
is for. A *majority* unmatched is what a broken key composition looks like.

**Run it by hand too, at least on deploy day** — it is latched, so it speaks once,
and §1.7's wiring check is a grep rather than a guarantee. This is the same query
the function runs:

```sql
with live as (
  select v.sku_key,
         not exists (select 1 from erp_live_fg f where f.sku_key = v.sku_key) as unmatched
  from v_live_commitments v
)
select count(*)                                                 as live_lines,
       count(*) filter (where unmatched)                        as unmatched_lines,
       round(100.0 * count(*) filter (where unmatched)
             / nullif(count(*),0), 1)                           as unmatched_pct,
       count(distinct sku_key)                                  as live_keys,
       count(distinct sku_key) filter (where unmatched)         as unmatched_keys
from live;

-- The two sample sets the log line prints. Compare SEGMENT BY SEGMENT.
select distinct v.sku_key as demand_side from v_live_commitments v
 where not exists (select 1 from erp_live_fg f where f.sku_key = v.sku_key)
 order by 1 limit 5;
select distinct sku_key as stock_side from erp_live_fg order by 1 limit 5;
```

**The segment that differs names the fix:**

| Symptom in the samples | Cause | Fix |
|---|---|---|
| Demand side `-` in segment 1, stock side has a brand | `brand` not read on the SO side, or not written | **Code**: `SKU_SEGMENT_SOURCES.brand.so_line` in `erp/sku.ts`, or the worker's insert list (§1.3) |
| Both populated, values differ in spelling only | normalization gap | **Code**, and **both sides in the same change** (A10) — never one alone |
| Agree on segments 1–4, differ on `p` / `l` only | dimension precision or unit | **Config**: drop the segment via `STOCK_SKU_KEY_SEGMENTS` — §4.4 |
| Demand side `-` in `th`/`th_panel` **and** §3.5 fired | refused ambiguous numerics, not a key fault | **Config**: `SELARAS_NUMBER_FORMAT` (§3.5), then re-measure |

Recovery line:

```bash
grep -F "RECOVERED ST-R5.2"
```

`STOCK_UNMATCHED_ALERT_RATIO` (default `0.5`) is the threshold. Lowering it makes
the alarm more sensitive; it does **not** change any behaviour except when the
line fires. Do not raise it to silence the alarm.

### 3.8 Success — what a good first run looks like

```bash
grep -F "run ok"                    # full success
grep -F "run finished with errors"  # partial — NOT a failure of the run
```

```
[erp-sync] run ok — 211893 rows across 4 tables in 412907ms
[erp-sync] run finished with errors on so_line — 74313 rows in 380221ms
```

Partial success is degrade-don't-die (`ROLLOUT.md` §6.1: do not alert on a single
failed poll). Then check the HTTP view, which is more useful than the log because
it shows the cursors and the per-table last error:

```
GET /api/stock/sync-status
```

Expect four `tables` entries, each with non-null `last_ok_at`, non-null
`cursor_value`, `last_error: null`, and `rows_synced` at or near §1.6's figures.
`last_error` carries the redacted, 500-char-truncated worker error, **so a 401 or
404 is visible here without log access** — useful when handing the incident on.

Freshness alarm, if the sync then stops (4 × 3 min = 12 min):

```bash
grep -F "ALERT ST-R7:"
grep -F "RECOVERED ST-R7"
```

The hourly reconciliation sweep has its own refusals, and both are **safe by
construction** — both leave the mirror exactly as it was:

```bash
grep -F "ABORTED"
grep -F "reconcile ok — removed"
```

`reconcile so_line: ABORTED — the ERP reported ZERO keys while the mirror holds
137580 row(s)…` means a truncating upstream bug and a genuinely emptied source
look identical from here, so the mirror was kept. **Correct.** Investigate
upstream; do **not** raise `STOCK_RECONCILE_MIN_RATIO` to make it go away.

---

## 4. Validation after the first successful sync — ST-R5.2, live

This has **never been run**. `ROLLOUT.md` §3 is the design; this is the live
version against the schema that actually shipped. **Run against a fully
backfilled mirror (D10), not a partial pull.**

### 4.0 First: `ROLLOUT.md` §3's SQL will not execute

`ROLLOUT.md` §3 and §6.2 call `erp_sku_key(kode_barang, warna, th, p, l)`. That
five-argument overload is **explicitly dropped** by the migration
(`RETIRED_SKU_KEY_SIGNATURES`), and `erp_so_line.kode_barang` is dropped with it —
deliberately, so that no future query can quietly join on a column that is NULL
for every row. The live function is:

```sql
erp_sku_key(p_brand text, p_warna text, p_th numeric, p_th_panel numeric, p_p numeric, p_l numeric)
```

Every query below is `ROLLOUT.md` §3's, corrected to six segments. **The decision
tables and thresholds there are unchanged and still authoritative** — this is a
signature correction, not a re-litigation. Confirm before you start:

```sql
select pg_get_functiondef(oid) from pg_proc where proname = 'erp_sku_key';
-- exactly one row; six parameters
```

### 4.1 V1 — headline fill rate · **the number that decides everything**

```sql
with demand as (
  select sku_key, sum(qty_balance) as qty, count(*) as lines
  from v_live_commitments group by 1
), supply as (
  select distinct sku_key from erp_live_fg
)
select count(*)                                                       as demand_skus,
       count(*) filter (where s.sku_key is not null)                  as matched_skus,
       round(100.0 * count(*) filter (where s.sku_key is not null)
             / nullif(count(*),0), 2)                                 as sku_fill_pct,
       sum(d.qty)                                                     as demand_qty,
       sum(d.qty) filter (where s.sku_key is not null)                as matched_qty,
       round(100.0 * sum(d.qty) filter (where s.sku_key is not null)
             / nullif(sum(d.qty),0), 2)                               as qty_fill_pct
from demand d left join supply s on s.sku_key = d.sku_key;
```

**`qty_fill_pct` is the decision, not `sku_fill_pct`** — a long tail of one-off
unmatched SKUs is harmless; one unmatched high-volume SKU is not.

| `qty_fill_pct` | Decision (unchanged from `ROLLOUT.md` §3) |
|---|---|
| **≥ 90%** | Ship the v2 six-segment key unchanged. Go to §4.3. |
| **75–90%** | Inspect the tail (§4.2). Dominated by genuine make-to-order items that never had an FG row ⇒ ship; that is what the exceptions tray is for (ST-R5.3). Dominated by items that plainly exist under a slightly different spelling ⇒ §4.4. |
| **< 75%** | **Do not announce the flip.** Run §4.4 and change `STOCK_SKU_KEY_SEGMENTS`. |

**Live-specific expectations `ROLLOUT.md` could not give you.** With ~218 live
lines against 1,464 FG rows and ~812 SKUs, the live demand set is **small**:

- `demand_skus` in the low hundreds is right.
- **`demand_skus` near zero means the commitment gate is wrong (§3.6), not the
  key.** Check that first, or you will re-compose a key that was fine.
- `qty_fill_pct` at or near **0%** is the §3.7 catastrophe. Stop and diagnose; do
  not tune.
- `qty_fill_pct` at exactly **100%** with a plausible `demand_skus` is good, not
  suspicious — the FG catalogue is broad and the live set is narrow.

### 4.2 V2 — who is missing, ranked by what it costs

```sql
select d.sku_key, d.lines, d.qty,
       (select count(*) from erp_live_fg f
         where f.brand is not distinct from l.brand
           and f.warna is not distinct from l.warna)                  as fg_rows_same_brand_warna
from (select sku_key, count(*) lines, sum(qty_balance) qty
      from v_live_commitments group by 1) d
join lateral (select brand, warna from erp_so_line
              where sku_key = d.sku_key limit 1) l on true
where not exists (select 1 from erp_live_fg f where f.sku_key = d.sku_key)
order by d.qty desc limit 50;
```

`fg_rows_same_brand_warna > 0` is the smoking gun — the v2 analogue of
`ROLLOUT.md` §3 Q2's `fg_rows_same_kode`: **the product exists in stock and only a
dimension segment is preventing the match.** That is a key-composition problem,
not make-to-order, and §4.4 is what fixes it.

Read the top 10 aloud with PPIC. *"Is this something we actually stock?"* is a
question they answer in seconds and no query answers at all.

### 4.3 V3 — projected exceptions-tray volume

```sql
select count(*)                                                       as exception_lines,
       sum(qty_balance)                                               as exception_qty,
       round(100.0 * sum(qty_balance)
             / nullif((select sum(qty_balance) from v_live_commitments),0), 2) as pct_of_live_qty
from v_live_commitments c
where not exists (select 1 from erp_live_fg f where f.sku_key = c.sku_key);
```

| `pct_of_live_qty` | Reading | Action |
|---|---|---|
| **≤ 5%** | Healthy — genuine make-to-order demand | Ship |
| **5–15%** | Watch. Review the top 20 with PPIC. | Ship, and baseline `ROLLOUT.md` §6.3 **here** |
| **> 15%** | **The key composition is wrong.** `HANDOVER.md` §2 predicts exactly this: a bad key surfaces as a flood of exceptions, not as wrong ATP. | §4.4 before announcing |

**The live expectation `ROLLOUT.md` could not state:** the tray must be a
**PPIC-reviewable list, not a firehose**. With ~218 live lines in total, a healthy
tray is **single digits to low tens of lines**. If `exception_lines` is in the
hundreds, the arithmetic says the key is broken whatever the percentage reads.

`/exceptions` ships with one reason in v1, `sku_tidak_cocok`. ST-R5.4's UoM
exception is not implementable — `erp_so_line` carries no unit column (CONTRACTS,
"Known gap"). **If the real SO payload turns out to carry a UoM, record it now:**
the contract says to resolve that during ST-R5.2, and this is ST-R5.2.

### 4.4 V4 — segment ablation, and the threshold at which the key must change

No code change is needed to measure a shorter key: passing `NULL` for a segment
pins it to `'-'`, which is exactly what dropping it would do.

```sql
with k as (
  select qty_balance, brand, warna, th, th_panel, p, l,
    erp_sku_key(brand, warna, th,   th_panel, p,    l)    as k6,  -- v2, shipped
    erp_sku_key(brand, warna, th,   th_panel, p,    null) as k5,  -- drop l
    erp_sku_key(brand, warna, th,   th_panel, null, null) as k4,  -- drop p, l
    erp_sku_key(brand, warna, th,   null,     null, null) as k3,  -- drop th_panel, p, l
    erp_sku_key(brand, warna, null, null,     null, null) as k2   -- brand + warna
  from v_live_commitments
), fg as (
  select
    array_agg(distinct erp_sku_key(brand, warna, th,   th_panel, p,    l))    as f6,
    array_agg(distinct erp_sku_key(brand, warna, th,   th_panel, p,    null)) as f5,
    array_agg(distinct erp_sku_key(brand, warna, th,   th_panel, null, null)) as f4,
    array_agg(distinct erp_sku_key(brand, warna, th,   null,     null, null)) as f3,
    array_agg(distinct erp_sku_key(brand, warna, null, null,     null, null)) as f2
  from erp_live_fg
)
select
  round(100.0*sum(k.qty_balance) filter (where k.k6 = any(fg.f6))/nullif(sum(k.qty_balance),0),2) as fill_k6,
  round(100.0*sum(k.qty_balance) filter (where k.k5 = any(fg.f5))/nullif(sum(k.qty_balance),0),2) as fill_k5,
  round(100.0*sum(k.qty_balance) filter (where k.k4 = any(fg.f4))/nullif(sum(k.qty_balance),0),2) as fill_k4,
  round(100.0*sum(k.qty_balance) filter (where k.k3 = any(fg.f3))/nullif(sum(k.qty_balance),0),2) as fill_k3,
  round(100.0*sum(k.qty_balance) filter (where k.k2 = any(fg.f2))/nullif(sum(k.qty_balance),0),2) as fill_k2
from k cross join fg;
```

Fill only ever rises as segments drop, so fill alone would always argue for the
shortest key. The counter-pressure is **false merges** — distinct physical
products collapsing into one key and pooling their stock:

```sql
-- Repeat with the k3 / k4 / k5 expressions.
select 'k2' as composition,
       count(*) filter (where variants > 1)                                    as merged_keys,
       sum(qty) filter (where variants > 1)                                    as merged_qty,
       round(100.0*sum(qty) filter (where variants > 1)/nullif(sum(qty),0),2)  as merged_qty_pct
from (
  select erp_sku_key(brand, warna, null, null, null, null)                     as k,
         count(distinct erp_sku_key(brand, warna, th, th_panel, p, l))         as variants,
         sum(qty)                                                              as qty
  from erp_live_fg group by 1
) t;
```

**The threshold, stated so it can be applied without judgement:**

> **Adopt the SHORTEST composition whose qty-weighted fill is ≥ 90% AND whose
> `merged_qty_pct` is < 1%. If none satisfies both, keep `k6` and take the
> exceptions.**

A false merge is strictly worse than an exception: an exception is a visible queue
entry a human works; a false merge is a wrong ATP nobody ever sees. Visible
under-matching beats invisible over-pooling.

**Applying a composition change — the order is not optional:**

1. Set `STOCK_SKU_KEY_SEGMENTS` (e.g. `brand,warna,th,th_panel`) and **redeploy**.
   Boot rebuilds `erp_sku_key()` **and** both views from the list.
2. **Backfill immediately.** Between the restart and this step, stored keys
   disagree with the function and **ATP is wrong in both directions**:
   ```sql
   update erp_live_fg set sku_key = erp_sku_key(brand, warna, th, th_panel, p, l);
   update erp_so_line  set sku_key = erp_sku_key(brand, warna, th, th_panel, p, l);
   ```
3. Re-run §4.5. Both counts must be zero.
4. Re-run §4.1 and §4.3 and confirm the predicted fill and tray volume actually
   materialised.

Do this in a maintenance window. **Step 1 without step 2 is the one genuinely
non-reversible action in this release** (`ROLLOUT.md` §5.4). The TypeScript side
needs no action — it reads the same config through `resolveSkuSegments()`, and
`test/sku.test.ts` proves the two stay byte-identical.

### 4.5 V5 — key drift and injection sanity

```sql
-- Both must be 0. Non-zero = config changed without a backfill, or a hand-edited row.
select count(*) from erp_live_fg where sku_key <> erp_sku_key(brand, warna, th, th_panel, p, l);
select count(*) from erp_so_line  where sku_key <> erp_sku_key(brand, warna, th, th_panel, p, l);

-- Must be 0: a separator surviving inside a segment means a forged key.
-- SIX segments now, not five — ROLLOUT §3 Q5's `<> 5` is stale.
select count(*) from erp_live_fg where array_length(string_to_array(sku_key, '|'), 1) <> 6;
select count(*) from erp_so_line  where array_length(string_to_array(sku_key, '|'), 1) <> 6;
```

`ROLLOUT.md` §6.2 says any non-zero value is a page. That stands.

### 4.6 V6 — Black Galaxy, the one number the business has verified

PRD §5A, verified live 2026-09-11: **on-hand 4,168, live 319, ATP 3,849**, 1,810
quarantined as stale. `test/atp.test.ts` reproduces it from fixtures
(`ROLLOUT.md` G4). Same arithmetic, against the real mirror:

```sql
-- warna is an ID, not a name: id 4 = BLACK GALAXY (erp_warna, 273 rows).
-- erp_num_or_null() exists precisely so a mirrored '004' still finds id '4'.
with bg_fg as (
  select sku_key, sum(qty) as on_hand
  from erp_live_fg where erp_num_or_null(warna) = 4 group by 1
), bg_live as (
  select sku_key, sum(qty_balance) as live
  from v_live_commitments where erp_num_or_null(warna) = 4 group by 1
), bg_stale as (
  select sku_key, sum(qty_balance) as stale
  from v_stale_commitments where erp_num_or_null(warna) = 4 group by 1
), bg_adj as (
  select sku_key, sum(qty_delta) as adj from stock_adjustments group by 1
)
select coalesce(sum(f.on_hand), 0)                                     as on_hand,  -- expect 4168
       coalesce(sum(l.live),    0)                                     as live,     -- expect  319
       coalesce(sum(s.stale),   0)                                     as stale,    -- expect 1810
       coalesce(sum(f.on_hand),0) - coalesce(sum(l.live),0)
         + coalesce(sum(a.adj), 0)                                     as atp       -- expect 3849
from bg_fg f
left join bg_live  l on l.sku_key = f.sku_key
left join bg_stale s on s.sku_key = f.sku_key
left join bg_adj   a on a.sku_key = f.sku_key;
```

**A miss is diagnostic, not just a red light:**

| Result | Reading |
|---|---|
| `on_hand` ≈ 4,168, `live` = **0**, `atp` = 4,168 | The commitment gate or the SKU key matches nothing (§3.6 / §3.7). **The most dangerous outcome, and it looks like a healthy, well-stocked SKU.** |
| `on_hand` ≈ 4,168, `live` ≈ **2,129**, `atp` ≈ 2,039 | The naive figure. The liveness window is not being applied — stale lines back to 2020 are reserving. Check `STOCK_STALE_WINDOW_DAYS` and that `v_stale_commitments` is non-empty. |
| `on_hand` far below 4,168 | `erp_live_fg` truncated. Cross-check §1.6 (1,464 rows). |
| `live` materially **above** 319 | `STOCK_CANCELLED_STATUSES` (A5) does not match — cancelled lines are reserving. Understates ATP; safe direction, but fix it. |
| All four within a few percent | **Ship.** This is the end-to-end proof the whole module was built to produce. |

### 4.7 V7 — PPIC's own expectation, on the top SKUs

`ROLLOUT.md` §2.0.2 gate B, run live. **The procedure matters more than the
query:**

1. Two lists — **top 30 by on-hand** and **top 30 by live commitment**. The
   failure modes differ: the first catches a broken `erp_live_fg` pull, the second
   a broken commitment join.
2. **PPIC states their expectation first, before seeing the screen.** Then read
   them the ATP. Asking first is the entire method; a number shown first anchors
   the answer and the pass measures nothing.
3. Record `plausible` / `not plausible` **per SKU, in writing, with PPIC's name
   against it**. Anything `not plausible` is root-caused before the flip — there
   is no accept-and-log class here, because there is no second system to
   attribute a gap to.
4. Cross-check the aggregate: **~95% of the open set should read stale.** A wildly
   different proportion means the window or the approval enum is mis-tuned, not
   that the ERP changed.
5. **Tune `STOCK_STALE_WINDOW_DAYS` once**, record the value and the reason, then
   leave it. Repeated tuning destroys the trust the stale queue depends on.

**Say this out loud when signing it.** This is a plausibility check by one team
against their own recollection, not a measured reconciliation against an
independent system. It catches order-of-magnitude errors, a dead join, a mis-tuned
window, a truncated mirror. **It will not catch a systematic few-percent bias.**
ST-R16 was specified to catch that class and was never built, so that class ships
undetected. §4.3 and `ROLLOUT.md` §6.4 are the production substitute, and they are
lagging indicators, not a gate.

---

## 5. Rollback, in rungs

**Fastest first**, which is the opposite of `ROLLOUT.md` §5.1's ordering — and the
difference is deliberate, not a contradiction. ROLLOUT orders by *what actually
reverses the flip*, because its scope is the whole module. This document's scope
is **one deploy that turned on one integration**, and for that event the fastest
lever is genuinely the right first move. **Read the "Reverses what" column before
picking a rung.** Rungs are independent; you may take R1 and then R2.

| Rung | Action | Time to effect | Blast radius | Reverses what |
|---|---|---|---|---|
| **R0** | Wait one more tick (3 min) | 3 min | none | Nothing — but a 401, a 404, a 400, a `success=false`, a failed page and an aborted reconcile are **all already safe**: cursor untouched, mirror unchanged, no wrong number served. Do not pull a lever while the symptom is one the design already contains. |
| **R1** | **Unset `SELARAS_BASE_URL`, redeploy** | **~1 min** | ERP surfaces only | **Containment, not a rollback.** The fastest rung there is. |
| **R1b** | One env var from §3, redeploy | ~2 min | config only | **Usually better than a rollback** — it fixes the fault instead of hiding it. |
| **R2** | Revert to the pre-deploy commit (D2's SHA), redeploy | ~5 min to deploy; **usable only after PPIC re-uploads** | whole app | All Stock 2.0 code. The real rollback. |
| **R3** | Drop the 2.0 schema | ~10 min + permanent data loss | destroys audited decisions | Last resort. Should essentially never happen. |

### R1 — unset `SELARAS_BASE_URL` (the fastest rung, and its honest limits)

```bash
railway variables --unset SELARAS_BASE_URL      # then redeploy
```

**What happens, exactly.** `hasErp` becomes false. The worker never starts and
logs one line:

```
[erp-sync] disabled — SELARAS_BASE_URL not set; the stock mirror will not refresh and the ERP surfaces will show 'ERP tidak terhubung'.
```

`POST /api/stock/sync` answers **503 `{"error":"ERP tidak terhubung."}`**. **The
app still boots and still serves** — invariant §7.7 — and this is a manual
checklist item in `ROLLOUT.md` §8, so the behaviour is confirmed rather than
assumed. **No code change, no migration, no rebuild.**

**What it does NOT do, and you must know this before reaching for it:**

- **The mirror is retained, readable and frozen.** `/stock` keeps serving ATP off
  the last-synced numbers behind the stale banner. **If ATP is *wrong*, R1 freezes
  the wrong number in place.** R1 is the right first move when the **sync** or the
  **ERP** is the problem — a 401 storm, a 404 storm, a hammered ERP, a truncating
  pull mid-flight. **It is the wrong move when the numbers are wrong**; that is R2.
- **It does not bring 1.0 back.** Bookings stay 410; the booking UI stays out of
  the DOM.
- **It does not stop the 12-minute ST-R7 stale alert** from firing, since nothing
  is succeeding. Expected. Do not chase it.

**`STOCK_ATP_SHADOW` is NOT a lever.** Defined in `config.ts`
(`config.stock.atpShadow`) and **read by no other file**:

```bash
grep -rn "atpShadow\|STOCK_ATP_SHADOW" apps/server/src packages
# → exactly one hit: the definition in config.ts
```

Setting it `true` and redeploying changes **nothing** — `/stock` still serves ATP,
the booking endpoints still answer 410, and `stock.html` has no booking UI for a
1.0 number to appear in. `ROLLOUT.md` §5.1.1 documents this in full. **An incident
runbook whose first step is a no-op costs you the minutes you spend believing it
worked, at the moment those minutes are most expensive.**

### R1b — the config rungs that are not rollbacks but usually beat one

Every failure in §3 except the envelope shape, the 400 and the pagination faults
is fixed by **one variable and a redeploy** — roughly two minutes, and it fixes
the problem rather than hiding it. In a live incident, work §3 top to bottom
before escalating to R2:

| Symptom | Variable | Cost |
|---|---|---|
| 401 | `SELARAS_KEY_HEADER` / `SELARAS_TOKEN_HEADER` / `SELARAS_AUTH_MODE` / the two secrets | ~2 min |
| 404 | `SELARAS_BASE_URL` (must end `/api`) | ~2 min |
| ATP = on-hand everywhere, gate line present | `STOCK_APPROVED_STATUSES` | ~2 min |
| ATP understated, cancelled lines reserving | `STOCK_CANCELLED_STATUSES` | ~2 min |
| Numerics refused | `SELARAS_NUMBER_FORMAT` | ~2 min |
| Fill rate < 75% on a dimension segment | `STOCK_SKU_KEY_SEGMENTS` **+ the §4.4 backfill** | ~10 min, maintenance window |
| Over-quarantining (PPIC insists old lines are real) | `STOCK_STALE_WINDOW_DAYS` | ~2 min, and **change it once** |
| `success=false` on one page range | `STOCK_SYNC_PAGE_SIZE` (to narrow and identify) | ~2 min — diagnostic, not a fix |

`STOCK_SKU_KEY_SEGMENTS` is the only one of these that is **not freely
reversible**: step 1 without step 2 leaves stored keys disagreeing with the
function and serves wrong ATP in both directions until the backfill runs. Never do
the config change and the backfill separately.

### R2 — revert the deploy (the real rollback for wrong numbers)

```bash
git revert --no-commit <D2 SHA>..HEAD    # or redeploy the previous Railway image
```

**~5 minutes to deploy — but not a working 1.0 until PPIC re-uploads a current
Excel, realistically the rest of the working day.** That re-upload dominates the
time profile. This is why D3 tells PPIC *before*, not after.

Why it is safe:

- **The 1.0 tables are intact.** `stock_uploads`, `stock_items`, `stock_bookings`
  were never altered or truncated — the 1.0 *write routes* were gutted to 410; the
  data was not touched.
- **Nothing was written to them while 2.0 was live**, because every booking and
  upload POST returned 410. 1.0 resumes precisely where it stopped: no gap to
  reconcile, no reverse migration.
- **`migrateErpStock.ts` is purely additive with respect to 1.0** — all new names,
  no `alter` on any 1.0 table, no backfill, no rename. **Reverting after the
  migration has already run requires no schema action at all**; the new objects go
  inert and cost only disk. A reverted binary does not call
  `runErpStockMigrations()`, so the views stop being recreated and sit at their
  last definition.
- **2.0 data written during the window is retained, not lost.**
  `stock_adjustments` and `stock_commitment_overrides` keep every row with its
  actor and timestamp. Rolling forward again picks them straight back up.

**The one caveat this deploy adds, which `ROLLOUT.md` could not have known.** This
release's migration **drops `erp_so_line.kode_barang`**. That is still additive
with respect to 1.0 — it touches only a 2.0 mirror table — but a revert to a
binary older than the v2 key remap will find a mirror whose shape its worker does
not expect. **The mirror is disposable** (it is a cache of the ERP; a re-sync
rebuilds it), so the recovery is:

```sql
truncate erp_so_line;
update erp_sync_state set cursor_value = null where table_name = 'so_line';
```

…and let it refill. **This is not a reason to reach for R3.** Write that in the
ticket, because under pressure *"the migration dropped a column"* reads like a
schema problem and it is not.

**If a future change makes the 2.0 migration non-additive with respect to a 1.0
table, this rung is void and the rollback plan must be rewritten before that
change ships.**

### R3 — drop the 2.0 schema (last resort)

Only when a name genuinely collides with a later feature. **It destroys audited
data.** Export first:

```sql
\copy stock_adjustments to 'adjustments.csv' csv header
\copy stock_commitment_overrides to 'overrides.csv' csv header
```

Then views → functions → tables (full statement list in `ROLLOUT.md` §5.3, **plus
`erp_warna` and `erp_num_or_null(text)`, which post-date it**, and note
`erp_sku_key` now has the six-argument signature).

The `erp_*` mirror is disposable. `stock_adjustments` and
`stock_commitment_overrides` are **not** — they are LeadScout-owned decisions that
exist nowhere else. Export them or lose them.

### The rung that does not exist

**There is no one-minute lever that reverses the flip.** R1 is one minute and is
containment; R2 reverses the flip and is not one minute. That is the single most
important operational fact on this page, and it is the same conclusion
`ROLLOUT.md` §5.1 reached. Do not let the speed of R1 be mistaken for a rollback
in the incident channel.

---

## 6. What we still cannot verify — and what each one costs

Stated plainly. "Unverified" is a much better answer than a false claim. These are
**in addition to** `ROLLOUT.md` §7 X1–X12, which all still stand.

| # | Cannot verify | Why | Risk carried |
|---|---|---|---|
| **U1** | **Any of it against the real endpoint, before production.** `selaras2.io` is unreachable from the sandbox and from CI by egress policy. | Environmental. | **The premise of this document.** Mitigated better than `ROLLOUT.md` X1 assumed: `test/selarasContract.test.ts` drives the real client against a strict mock built from the **verified spec**, so a wrong URL, header name or primary key now fails in CI rather than in production. What it cannot prove is that the spec matches the deployed API. The failure direction is mostly benign — an unparseable API yields an empty mirror and "ERP tidak terhubung", not wrong numbers. **The exception is anything that makes commitments not match stock**, which yields confident wrong numbers; §4.1 is the only thing between that and the sales floor. |
| **U2** | **That the mock matches the real server's *behaviour*, not just its shape.** | The spec documents status codes and an envelope; it does not document rate limits, partial pages, or when `success:false` is returned. | **Medium.** There is no 429 retry (A24). A rate-limited backfill would present as a wave of 4xx page failures with the cursor stuck — safe, but it stalls. If the first backfill stalls repeatedly at the same page count, suspect throttling and lower `STOCK_SYNC_PAGE_SIZE`. |
| **U3** | **That missing credentials are detectable at boot.** `hasErpCredentials` (`config.ts`) is exported and read by nothing. | Never wired. | **Low.** The symptom is §3.1's 401, which is now loud and self-describing. But the module's own comment says it is *"kept separate so an unauthenticated misconfiguration is a loud 401 in the sync log rather than a silently disabled integration"* — the 401 is loud, so the gap costs little; it is listed because a defined-and-unread export is how `STOCK_ATP_SHADOW` happened. |
| **U4** | **That the detectors stay wired.** `checkSkuKeyMatch()` was exported and uncalled for part of this same release. | Caught at audit, fixed the same hour. | **Low now, high as a pattern.** §1.7 is a permanent pre-flight grep for exactly this. Both detectors are latched, so a regression is silent by construction. |
| **U5** | **That the worker's column lists match the tables.** | `postgres.js` takes column names as strings; `tsc` cannot see them. | **High if unchecked.** This defect existed in this tree at 09:12 (`insert into erp_so_line … "kode_barang"` against a column the migration drops) and would have raised `42703` on every demand page, leaving ATP = on-hand catalogue-wide. §1.3 is the gate; **only the DB-backed suites catch it**, and those skip silently without `DATABASE_URL`. |
| **U6** | ~~**`erp_warna` excluded from freshness.**~~ | `evaluateStaleAlert()` now scopes to `table_name = any(SYNC_TABLES)`, so all four tables count. | ✅ **Closed.** One consequence to know on deploy day: a `warna` sync failure now contributes to the 12-minute ST-R7 stale alert and to the `/stock` stale banner, even though the colour master is **display only** (`warna` is matched by id, so ATP is unaffected). A stale banner whose sole cause is `erp_warna` is cosmetic — check `/api/stock/sync-status` per table before treating it as an ATP problem. |
| **U7** | **Load at real volume.** 137,580 SO lines against fixtures of tens of rows. | No representative dataset outside production. | **Medium.** `ROLLOUT.md` X12. D11 makes the `explain (analyze, buffers)` a deploy step rather than a good intention. A sequential scan over 137k lines on every page poll presents as a slow page, not an error. |
| **U8** | **Concurrency across two Railway instances.** | Single-process assumption; the DB `running` guard is real but unproven at scale. | **Medium.** `ROLLOUT.md` X9. D4 pins the service to one replica through the first sync. |
| **U9** | **That the first sync is atomic in any sense.** It is not. | By design: page-at-a-time commits, cursor advanced per committed page. | **Low, but it shapes the watch.** Between D8 and D10 the mirror is **partially populated**, so ATP is computable and wrong. The sync order — `warna → so_header → so_line → live_fg` — puts on-hand **last**, so the partial state reads ATP **low**, not high. That is the safe direction, and it is why §4 runs only after `run ok`. **Nobody should read `/stock` for a real decision during the backfill window.** |
| **U10** | **The test suites themselves, right now.** 98 failing at 09:25. | The suites lag the v2 key remap. | **Blocking, and it is the live pre-flight state.** Until they are green, `ROLLOUT.md` G2/G3/G4 are unverified — including G3, the TS↔SQL parity test that most protects this build. §1.1. |

---

## 7. Findings raised by this document

Verified against source, not inferred. This package owns no source file, so none
is fixed here.

| # | Finding | Owner | State at 09:25 |
|---|---|---|---|
| **F1** | `syncWorker.ts` wrote `kode_barang` into `erp_so_line` after the migration dropped it, and wrote neither `brand` nor `th_panel`. Every demand-side insert would have raised `42703`. | WP-2 | ✅ **fixed 09:20.** Retained as pre-flight gate §1.3 — `tsc` cannot catch this class. |
| **F2** | `checkSkuKeyMatch()` — the alarm for the highest-severity failure this module has — was exported and called by nothing, while `config.ts` and `erp/sku.ts` both documented it as running on every sync. | WP-2 | ✅ **wired 09:20.** Retained as pre-flight gate §1.7. |
| **F3** | In `header` mode the client sent the **query-param** names as header names, the exact 401 the config comment said was fixed. | WP-2 | ✅ **fixed 09:20.** Retained as pre-flight gate §1.5. |
| **F4** | `ROLLOUT.md` §3 and §6.2 call a five-argument `erp_sku_key` that the migration explicitly drops, and §3 Q5 asserts `<> 5` segments. **The documented validation runbook cannot execute.** | WP-7 | ⛔ **open.** §4 supersedes it. `ROLLOUT.md` §3/§6.2 should carry a pointer here. |
| **F5** | `hasErpCredentials` is exported and read by nothing. | WP-2 | ⛔ open — low cost, listed as U3 |
| **F6** | `evaluateStaleAlert()` excluded `erp_warna` from freshness, undocumented. | WP-2 | ✅ **fixed** — now scopes to all of `SYNC_TABLES`. See U6 for the one deploy-day consequence. |
| **F7** | **The test suites are red (98 failed / 161 passed / 110 skipped)**, lagging the v2 key remap. `sku.test.ts`, `atp.test.ts` and `routes.test.ts` still assume the five-segment key and `erp_so_line.kode_barang`. | WP-7 | ⛔ **open — deploy blocker.** §1.1 |
| **F8** | `vitest run --passWithNoTests` + `describe.skipIf(!hasDb)` means a green run without `DATABASE_URL` proves almost nothing. The stock suites are the ones that skip. | WP-7 | ⛔ open — mitigated by §1.2's "not skipped is the check" |

---

## 8. Change log

| Date | Change | By |
|---|---|---|
| 2026-09-11 | First draft (09:12 source state). Live-contact runbook: pre-flight gates, deploy sequence, ordered first-sync log watch with grep-verified strings, live ST-R5.2 validation corrected to the v2 six-segment key, rollback rungs ordered fastest-first for this event, residual unverifiables. Findings F1–F3 raised as blockers. | QA & Deployment |
| 2026-09-11 | Re-verified a third time against `d7f1be6`. **F6 fixed** (freshness now covers all four tables); U6 rewritten as the one consequence that survives. §1.5's grep pattern corrected. All 26 log strings in §3 re-confirmed present. | QA & Deployment |
| 2026-09-11 | Re-verified against the 09:25 source state after WP-2 landed the ERP fixes. **F1, F2 and F3 are fixed**; all three retained as permanent pre-flight gates, since each was invisible to `tsc` and to a green test run. §3 rewritten around the newly-added dedicated log lines (`ERP REJECTED OUR CREDENTIALS`, the 400/404 explainers, `success=false`, `deleted_at`, `RECOVERED ST-R5.2`). §1.2 added for `test/selarasContract.test.ts`, the strict spec-driven conformance suite. §1.4 corrected: `header` mode reads `SELARAS_KEY_HEADER`/`SELARAS_TOKEN_HEADER`, **not** the `_PARAM` pair. **F7 raised: the test suites are red and it is a deploy blocker.** | QA & Deployment |
