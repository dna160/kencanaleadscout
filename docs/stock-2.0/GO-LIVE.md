# Stock 2.0 — GO-LIVE: the first live ERP connection

> **Owner:** QA & Deployment. **Status:** plan, not yet executed.
> **Executor:** the Lead Architect holds the deploy. Nothing in this file is run
> by its author.
>
> **Read `ROLLOUT.md` first.** That document is the release plan for the module.
> This one is narrower and sharper: it covers the **single event** `ROLLOUT.md`
> could not cover, because it was written before anybody had seen the Selaras
> API — **the first time this code talks to the real ERP, which will happen in
> production.**
>
> Division of labour, so neither document is read twice for the same answer:
>
> | Question | Document |
> |---|---|
> | Is the module ready to ship at all? | `ROLLOUT.md` §0 (G1–G11) |
> | Why is there no shadow cycle? | `ROLLOUT.md` §2 |
> | What SQL measures the SKU join? | `ROLLOUT.md` §3 — **but see §4.0 below: its SQL is now stale** |
> | What do we monitor forever? | `ROLLOUT.md` §6 |
> | What is untested, and what does that cost? | `ROLLOUT.md` §7 |
> | **What do I type, watch and grep on deploy day?** | **this file** |
> | **What breaks first, and which env var fixes it?** | **this file §3** |
> | **How do I get out of it in under a minute?** | **this file §5** |

**Why this file exists.** `ROLLOUT.md` §7 X1 calls first contact with the live
API "the single riskiest moment of this rollout" and says to treat it as a
change with a rollback ready. It does not say what that looks like. Since it was
written, four things changed that only a live-contact runbook can absorb:

1. The real API spec arrived. The endpoint path, the auth header names, the
   primary-key convention and — most seriously — **the SKU join key** were all
   wrong, and the SKU key was wrong in the silent, over-promising direction.
2. The SKU key is now **six** segments (`brand|warna|th|th_panel|p|l`), not the
   five ROLLOUT §3 was written against. Every query in ROLLOUT §3 calls
   `erp_sku_key(kode_barang, warna, th, p, l)`, a function signature that **no
   longer exists in the database**. See §4.0.
3. Credentials are staged in Railway with deploys skipped, so the deploy itself
   is the moment of first contact — there is no staging rehearsal, because
   nothing can reach `selaras2.io` from the sandbox or from CI.
4. Two new silent-catastrophe detectors were added. **One is wired. One is not.**
   See §1.7 and §3.7.

**The one sentence to keep in your head all day.** Every failure mode below
except the 404 has the same shape: *a commitment that does not match its stock
reserves nothing, so `open_commitment` is 0, ATP equals on-hand, and the entire
inventory reads as promiseable on a page that looks perfectly healthy.* Nobody
reports good news. If you only do one thing after the first sync, do §4.1.

---

## 1. Pre-flight — what must be true before the Architect deploys

Verified state is recorded as of **2026-09-11 09:13 UTC** on branch
`claude/vigilant-einstein-wuze2k`. Re-check every red item; the back-end package
was mid-edit when this was written.

### 1.1 P1 — build and tests green

```bash
pnpm -r build            # tsc -p apps/server
pnpm -r exec tsc --noEmit
pnpm -r test             # vitest
```

**Status at time of writing: ⛔ RED.** `pnpm -r exec tsc --noEmit` fails with
nine errors, all in `apps/server/src/erp/syncWorker.ts`. They are not cosmetic —
they are P2 below, surfacing as type errors. **Do not deploy on a red build.**
`railway.toml` builds from the Dockerfile, so a broken `tsc` fails the build and
the deploy never lands; the risk is not a bad deploy, it is a wasted window.

### 1.2 P2 — the client / worker / migration must agree (**BLOCKER**)

This is the gate `ROLLOUT.md` has no entry for, because in its world the three
files already agreed. They do not today. The SKU-key remap landed in
`config.ts`, `erp/sku.ts` and `db/migrateErpStock.ts`; `erp/selarasClient.ts`
followed; **`erp/syncWorker.ts` has not.** Concretely, verified:

| # | Disagreement | Consequence on the first sync |
|---|---|---|
| a | `migrateErpStock.ts` **drops** `erp_so_line.kode_barang`; `syncWorker.ts:205` still lists `"kode_barang"` in the `insert into erp_so_line` column list | **Every `so_line` page insert raises `42703 column "kode_barang" … does not exist`.** The cursor is never advanced, the mirror stays empty for demand, and ATP equals on-hand for the whole catalogue. This is the worst outcome in this document and it is **certain**, not probable. |
| b | `syncWorker.ts` writes neither `brand` nor `th_panel` on either table | Both key columns are NULL ⇒ `sku_key` normalizes both segments to `'-'` for every row ⇒ 0% match even if (a) is fixed |
| c | `selarasClient.ts` `SYNC_TABLES` now has **four** tables (`warna` first); `syncWorker.ts` `upsertPage()` has three `case` arms and no `default` | The colour master falls through to `undefined`; TS flags it as "function lacks ending return statement" |
| d | `SELARAS_KEY_FIELDS` in `selarasClient.ts` has no `warna` entry | The hourly reconciliation sweep cannot build a key set for it |

**Gate, executable:**

```bash
# All four must pass. Any failure ⇒ do not deploy.
! grep -n '"kode_barang"' apps/server/src/erp/syncWorker.ts           # (a)
grep -c '"brand"'   apps/server/src/erp/syncWorker.ts                  # (b) expect >= 2
grep -c '"th_panel"' apps/server/src/erp/syncWorker.ts                 # (b) expect >= 2
pnpm -r exec tsc --noEmit                                              # (c)(d)
```

Then prove it against a real Postgres rather than against the types — the
sandbox has one (`PROGRESS.md`, WP-1):

```bash
DATABASE_URL=postgres://kencana:kencana@localhost:5432/leadscout \
  pnpm --filter @kencana/server test
```

This is not belt-and-braces. The type checker cannot see a column list handed to
`postgres.js` as strings, which is exactly how (a) survived.

### 1.3 P3 — the contract-conformance suite must actually have run

`test/routes.test.ts` is the CONTRACTS §4 / AMENDMENTS suite — the file that
closed `ROLLOUT.md`'s G8 gap. It opens with:

```ts
describe.skipIf(!hasDb)("Stock 2.0 HTTP surface (CONTRACTS §4 · ROLLOUT G8/X3)", …)
```

**`--passWithNoTests` plus `skipIf` means a green run proves nothing on a machine
with no `DATABASE_URL`.** Green is not the check; *not skipped* is the check.

```bash
DATABASE_URL=postgres://kencana:kencana@localhost:5432/leadscout \
  pnpm --filter @kencana/server test 2>&1 | tee /tmp/preflight-tests.txt
grep -c "skipped" /tmp/preflight-tests.txt      # must be 0 for the stock suites
```

Record the passing test count in the deploy ticket. The last committed figure is
**315**; a materially lower number with a green result means suites skipped.

### 1.4 P4 — variables verified present, by name and by mode

Railway has these staged with deploys skipped. Confirm each is **present and
non-empty**, and confirm the two that decide behaviour:

| Variable | Required | Note |
|---|---|---|
| `SELARAS_BASE_URL` | yes | The API root. **Not** `https://selaras2.io/kencana/table_documentation` — that is the documentation SPA and is the documented wrong turn (`config.ts`). The client appends `/table/<tbl_name>`. |
| `SELARAS_AUTH_MODE` | yes | `header`. Anything else changes which variables matter — see §1.5. |
| `SELARAS_SECRET_KEY` | yes | secret |
| `SELARAS_SECRET_TOKEN` | yes | secret |
| `SELARAS_KEY_PARAM` | **yes, and read §1.5** | in `header` mode this is the **header name**, not the query param |
| `SELARAS_TOKEN_PARAM` | **yes, and read §1.5** | same |
| `DATABASE_URL` | yes | already set; without it the app boots and every surface 503s |
| `SELARAS_NUMBER_FORMAT` | leave unset | defaults to `auto` — refuses ambiguous numerics rather than guessing (A22). Do not set it to `id` or `en` until §3.5 has shown you a real body. |
| `STOCK_APPROVED_STATUSES` | leave unset for run 1 | defaults to `Approved`; §3.6 is how you learn the real value |
| `STOCK_SKU_KEY_SEGMENTS` | leave unset for run 1 | defaults to the v2 six; §4.4 is how you learn whether to shorten it |
| `STOCK_ATP_SHADOW` | **do not set** | inert, read by no code (`ROLLOUT.md` §5.1.1) |

**Do not pre-tune anything.** Every knob above has a log line in §3 that tells
you what to set it to. Setting them blind converts a diagnosable first run into
an undiagnosable one.

### 1.5 P5 — the header-name trap (**verified defect, config-fixable**)

`config.ts` defines four credential-name variables and documents them precisely:

```
selarasKeyHeader:  str("SELARAS_KEY_HEADER",  "x-secret-key")
selarasTokenHeader:str("SELARAS_TOKEN_HEADER","x-secret-token")
selarasKeyParam:   str("SELARAS_KEY_PARAM",   "secret_key")
selarasTokenParam: str("SELARAS_TOKEN_PARAM", "secret_token")
```

with the comment *"Each mode therefore carries its own default instead of one
name being lower-cased into the other's slot, which is how the header mode came
to send `secret_key:` and fail 401."*

**The client does not do that.** `selarasClient.ts:949-952`:

```ts
} else if (config.selarasAuthMode === "header") {
  if (config.selarasSecretKey)   headers[config.selarasKeyParam.toLowerCase()]   = config.selarasSecretKey;
  if (config.selarasSecretToken) headers[config.selarasTokenParam.toLowerCase()] = config.selarasSecretToken;
}
```

`selarasKeyHeader` / `selarasTokenHeader` appear in exactly one place in the
whole source tree — the redaction list at `selarasClient.ts:237-238`. **They are
never used as header names.** So in `header` mode the request carries
`secret_key:` and `secret_token:` — the exact bug the config comment says was
fixed.

```bash
# The check. Expect 2 (redaction list only). More than 2 ⇒ the defect is fixed.
grep -c "selarasKeyHeader\|selarasTokenHeader" apps/server/src/erp/selarasClient.ts
```

**Two ways out. Pick one before deploying, not during the incident:**

- **Config-only (works today, no code change):** set
  `SELARAS_KEY_PARAM=X-Secret-Key` and `SELARAS_TOKEN_PARAM=X-Secret-Token`.
  The client lower-cases them, so the wire carries `x-secret-key:` /
  `x-secret-token:`, which is correct. **Caveat, and write it in the ticket:**
  those same two variables are the **query-string** names in `query` mode
  (`applyQueryAuth`). This fix is correct only while `SELARAS_AUTH_MODE=header`,
  and it silently breaks any later switch to `query`.
- **Code fix (correct, WP-2's to make — needs a code change, not a config
  change):** two lines in `requestOnce()`, reading `selarasKeyHeader` /
  `selarasTokenHeader` in `header` mode. Then leave `SELARAS_KEY_PARAM` /
  `SELARAS_TOKEN_PARAM` at their documented query defaults.

Whichever is chosen, `curl` the ERP by hand from a machine that can reach it,
with both header spellings, before the deploy. That single 30-second test
removes the most likely first failure entirely.

### 1.6 P6 — the stated expectation for the first sync

Write these down **before** the deploy and compare after. A sync that "looks
fine" against no prior expectation is not evidence of anything.

| Mirror table | ERP source | Expected rows after a **full** backfill | Meaning if materially lower |
|---|---|---|---|
| `erp_warna` | `tbl_1228_DBRMWarnaID` | **273** | colour master truncated; display only, does not affect ATP |
| `erp_so_header` | `tbl_1202_SOSalesOrderNID` | **72,576** | headers truncated ⇒ commitments lose customer/sales/`po_date` (the join is `left join`, so ATP is unaffected but PPIC triage is blind) |
| `erp_so_line` | `tbl_1203_SOSalesOrderDetailNID` | **137,580** | **demand truncated ⇒ ATP reads high.** The number that matters most. |
| `erp_live_fg` | `tbl_1210_STLiveFGMX` | **1,464** | supply truncated ⇒ ATP reads low, and the unmatched rate (§4.1) spikes for the wrong reason |

Derived expectations:

- **Last month of SO: ~1,396 lines.** Useful as an *incremental* expectation:
  after the backfill, a subsequent run with a warm cursor should move a handful
  of rows per 3-minute tick, not thousands. A second full-size pull means the
  cursor is not persisting.
- **~4,376 open lines** (`qty_balance > 0`), of which **~218 are live** and
  ~4,158 stale — PRD §5A. So expect the stale queue to be large on day one;
  `ROLLOUT.md` §4 step 5 is explicit that stale residue does not block launch.
- **~95% stale** across the open set. A wildly different proportion means the
  liveness window or the approval enum is mis-tuned, not that the ERP changed.
- **Black Galaxy (`warna` id 4):** on-hand **4,168**, live commitment **319**,
  **ATP 3,849**, 1,810 quarantined as stale. This is the one end-to-end number
  the business has independently verified. §4.6 checks it.

Backfill volume: 137,580 lines at `STOCK_SYNC_PAGE_SIZE=1000` is ~138 pages, so
the first `so_line` pass is long. `MAX_PAGES_PER_TABLE` is 1,000, so the cap is
not in play, but the first run will overrun the 3-minute tick — that is expected
and safe (the in-process guard plus the DB `running` guard make the next tick a
no-op, logged as `another sync run holds the guard — skipping this tick`).

### 1.7 P7 — know which of the two detectors is actually wired

Both exist in `db/migrateErpStock.ts`. They are the two doors to the same
catastrophe and they are **not** in the same state:

| Detector | Function | Called from | Status |
|---|---|---|---|
| Commitment gate (approval enum wrong) | `checkCommitmentGate()` | `migrateErpStock.ts:516` (boot) and `syncWorker.ts:1161` (every run) | ✅ **wired** |
| SKU-key match (join key wrong) | `checkSkuKeyMatch()` | **nothing** | ⛔ **NOT WIRED — exported and never called** |

```bash
# Verified 2026-09-11. Expect exactly two hits: the definition, and a prose
# reference in erp/sku.ts. No call site.
grep -rn "checkSkuKeyMatch" apps/server/src apps/server/test
```

`config.ts` says of `STOCK_UNMATCHED_ALERT_RATIO`: *"after each sync the worker
measures what fraction of live commitments found no stock row … Above this
fraction it logs one loud error."* `erp/sku.ts:55-57` says *"the sync worker now
measures how much of the live demand actually matched stock and shouts when most
of it did not."* **Neither is true.** The worker calls `evaluateStaleAlert` and
`checkCommitmentGateAfterSync` at its tail and nothing else.

This is `ROLLOUT.md` §5.1.1's `STOCK_ATP_SHADOW` failure repeating inside the
same release: a flag defined, documented as load-bearing, and read by no code.
It is also `ROLLOUT.md` §1's lesson repeating — *an entry in an assumption log is
not evidence that the code implements it.*

**Consequence for deploy day, and it is the reason §4.1 is mandatory rather than
recommended:** the alarm for the single most expensive failure this module has
**will not fire on its own**. §3.7 gives the SQL to run it by hand. Wiring it is
one `try { await checkSkuKeyMatch(db, log) } catch {}` block beside the existing
two in `syncWorker.ts:1159-1163` — **a code change, and WP-2's to make.** It is
not on the critical path for the deploy if §4.1 is run manually, but it must
land before the Architect stops watching the logs by hand.

---

## 2. The deploy sequence

In order. Each step has one reason, and no step is optional.

| # | Action | Why this step exists |
|---|---|---|
| **D1** | Close §1.2 (P2) and §1.5 (P5). Re-run §1.1 and §1.3. | The two known-certain failures are in the build, not in the ERP. Deploying before they are closed spends the one first-contact window learning nothing. |
| **D2** | Record the deploy's **base commit SHA** in the ticket. | R2 (§5) is "revert to this SHA". Looking it up mid-incident costs the minutes the rung exists to save. |
| **D3** | Tell PPIC the window is open and that a rollback may ask them for a fresh Excel. | `ROLLOUT.md` §5.2: the rollback's time profile is dominated by PPIC's re-upload, not by the deploy. Telling them first is the difference between a 5-minute rollback and a next-day one. |
| **D4** | **Leave `SELARAS_BASE_URL` unset** and deploy the fixed build. | Decouples "does the new code boot and migrate cleanly?" from "does the ERP answer?". The migration drops `erp_so_line.kode_barang` and recreates both views — that is the step you want to observe alone, with no ERP traffic and no reachable failure mode beyond the DB. Expect `[erp-sync] disabled — SELARAS_BASE_URL not set` and both pages rendering "ERP tidak terhubung" (invariant §7.7). |
| **D5** | Confirm the migration log is clean: no `[migrateErpStock] … step failed (non-fatal)` line, and exactly one `[migrateErpStock] dropping erp_so_line.kode_barang` (first boot only, never again). | Every migration block is wrapped in a **non-fatal** try/catch, so a failed step does **not** fail the boot or the health check. A silent partial migration is entirely possible and this log line is the only place it appears. |
| **D6** | `GET /api/stock/sync-status` — confirm four rows (`warna`, `so_header`, `so_line`, `live_fg`), all `last_ok_at: null`, `running: false`. | Proves `erp_sync_state` seeded and the route is live, before any ERP variable can confuse the picture. |
| **D7** | Set `SELARAS_BASE_URL` (and the §1.5 credential-name decision). Deploy. **This is first contact.** | One variable, one redeploy, one thing changed. If the next five minutes go wrong, exactly one change is in flight and R1 (§5) reverses it in a minute. |
| **D8** | Watch the logs per **§3**, in the order §3 lists, without touching anything for a full tick (3 min). | The failures arrive in a fixed order and each masks the next. Changing a variable at the first red line means the second one is diagnosed on the following deploy instead of this one. |
| **D9** | Let the backfill complete. `erp_so_line` is ~138 pages; expect the first run to overrun the tick. Wait for `[erp-sync] run ok`. | §4 is explicit — and `ROLLOUT.md` §3 agrees — that the validation must run against a **fully backfilled** mirror. Run it against a partial pull and the fill rate is meaningless. |
| **D10** | Run **§4** end to end. | ST-R5.2, live, for the first time. |
| **D11** | Record the §4 numbers, `STOCK_SKU_KEY_SEGMENTS` (whether changed or not, and why), and the §4.7 PPIC sign-off in `PROGRESS.md`. Baseline `ROLLOUT.md` §6.3/§6.4 on the figures you just measured. | `ROLLOUT.md` §6 says an absolute threshold chosen before seeing real data is a guess. This is the only moment the real data is in front of someone who knows what it should say. |

**Do not announce the flip to sales between D7 and D10.** ATP is served the
moment the mirror has rows; §4.1 is what says whether those numbers are true.

---

## 3. The first-sync watch

The heart of this document. **In the order the lines will appear.** Every string
below was verified present in the source with `grep`; where a string is built by
interpolation the source template is given alongside the runtime text, so you
grep for the right thing.

All sync-worker lines carry the prefix `[erp-sync] ` (`syncWorker.ts:75-77`) and
are pushed through `redactSecrets()`. Client-side envelope notices carry
`[selaras] `. Migration and gate lines carry `[migrateErpStock] ` or `[stock] `.

Railway: `railway logs`, or the service's Deploy Logs pane.

### 3.0 Boot — the three lines that mean "we are live"

```
[erp-sync] started — every 180s, page size 1000
[erp-sync] mirror reconciliation started — every 60 min, abort floor 0.5 of mirrored rows
```

Source: `syncWorker.ts:1199` and `:1213`. If instead you see

```
[erp-sync] disabled — SELARAS_BASE_URL not set; the stock mirror will not refresh …
```

(`syncWorker.ts:1179`) then D7 did not take effect — the variable was staged but
the deploy was skipped again. That is also, deliberately, exactly what rung R1
(§5) produces.

### 3.1 A 401 — credentials or header names wrong · **most likely first failure**

```
grep -F "from ERP" | grep -F " 401 "
```

Runtime line (template: `` `${table}: page ${page} failed — ${res.error}; cursor left at …` ``
at `syncWorker.ts:464`, where `res.error` is `` `HTTP ${res.status} from ERP` ``
at `selarasClient.ts:947`):

```
[erp-sync] warna: page 1 failed — HTTP 401 from ERP; cursor left at null
```

**Meaning.** The credential pair was rejected. 4xx is terminal for the run — no
retry (`selarasClient.ts:923`: *"a 401/404 is a configuration fault and hammering
it twice fixes nothing"*). The cursor is untouched and the mirror keeps whatever
it had, so a 401 is **safe**: it produces an empty or frozen mirror behind the
stale banner, never wrong numbers.

Expect it on **all four tables**, in sync order `warna → so_header → so_line →
live_fg`. A 401 on one table only is not a credential fault — it is a
permissions grant that does not cover that table, which is a Selaras-side ask.

**Fix, in order of likelihood — all config:**

1. **The header names (§1.5).** Set `SELARAS_KEY_PARAM=X-Secret-Key` and
   `SELARAS_TOKEN_PARAM=X-Secret-Token`. This is the documented cause of this
   exact 401 and the client still has the defect.
2. **The mode.** `SELARAS_AUTH_MODE` must be `header`. If it is `bearer`, the
   client sends `Authorization: Bearer <SELARAS_TOKEN>` and ignores the key/token
   pair entirely — Selaras issues a pair, so bearer cannot authenticate at all.
3. **The secrets.** `SELARAS_SECRET_KEY` / `SELARAS_SECRET_TOKEN` present,
   non-empty, not swapped. A swap yields 401, not a distinct error.
4. **Fall back to `query`.** `SELARAS_AUTH_MODE=query` puts the credentials on
   the URL with the `SELARAS_KEY_PARAM` / `SELARAS_TOKEN_PARAM` names. Both
   placements are supported. Use this only if header mode cannot be made to work
   — a credential in a URL is the thing most likely to reach a log line, which is
   why `redactSecrets()` strips those parameter names by name.

**You will not see a "credentials missing" warning at boot.** `hasErpCredentials`
is exported from `config.ts:255` and read by nothing, so a base URL with no
secrets is indistinguishable at boot from a correct configuration; it presents
as this 401. Noted in §6.

### 3.2 A 404 — the endpoint path is still wrong

```
grep -F "from ERP" | grep -F " 404 "
```

```
[erp-sync] warna: page 1 failed — HTTP 404 from ERP; cursor left at null
```

**Meaning.** The URL the client built does not exist. The client composes
`<SELARAS_BASE_URL>/table/<erp_table_name>` (`selarasClient.ts`, `TABLE_PATH =
"table"`, `SELARAS_ENDPOINTS`), so a 404 means the **base URL** is wrong —
the path segment and table names were corrected against the real spec and are
not configurable.

**Fix — config, `SELARAS_BASE_URL` only:**

- The classic wrong value is the documentation SPA
  `https://selaras2.io/kencana/table_documentation`, flagged as the obvious wrong
  turn in `config.ts`. The API root is not that page.
- Trailing slashes are harmless (`buildPageUrl` strips them).
- Sanity-check by hand against the two sibling endpoints the sync does **not**
  use but which prove the root: `<base>/tables` and
  `<base>/table/tbl_1228_DBRMWarnaID/columns`.
- **404 on some tables but not others is not a base-URL problem** — it is a table
  name or a grant, and it needs a code change (`SELARAS_ENDPOINTS`) or a Selaras
  ask. Say which.

A 404 is as safe as a 401 and for the same reason: terminal, no retry, cursor
untouched, mirror unchanged.

### 3.3 The envelope-shape notice — `meta`/`data` are not what we assumed

```
grep -F "is NOT the assumed A1 shape"
```

Source `selarasClient.ts:297`, emitted **once per (table, shape) per process**:

```
[selaras] response envelope for 'so_line' is NOT the assumed A1 shape
{ data: [...], meta: { page, total_pages } } — observed: rows at 'records'; page count from 'total (rows → pages)'.
Parsing continued with the tolerated alternative. Fix A1 in erp/selarasClient.ts (readEnvelope) if this is the real shape.
```

**Meaning.** Assumption A1 (`HANDOVER.md` §7) was wrong, and `readEnvelope()`
fell back to a tolerated alternative rather than throwing. **This is a notice,
not a failure** — rows were parsed. Its value is that it prints the shape it
actually found, which is the thirty-second fix for A1.

**Read the `observed:` clause carefully, because one variant is dangerous:**

- `rows at 'X'; page count from 'Y'` — benign. Paging works. File the shape.
- `rows at 'X'; **no page/row count**` — paging now stops only on a short page
  (`rawCount < pageSize`). Correct, but it means the safety nets in §3.4 are the
  only thing bounding the run. Watch for the page-repeat line.
- `**no row array** (keys: …)` — nothing was parsed. The mirror stays empty and
  the run reports success with zero rows. **This is the one envelope outcome that
  looks like a clean sync and is not.** Cross-check against §1.6: `run ok — 0
  rows` after a full backfill window is this.

**Fix: none is config.** The endpoint map, the path shape and `readEnvelope()`
are code. Say so plainly: **this one needs a one-file diff in
`erp/selarasClient.ts`, by design** — `HANDOVER.md` §2 point 2 is that all
parsing funnels through this file precisely so that the correction is a
one-file diff rather than a hunt. The mitigation *is* working when you see this
line.

### 3.4 Pagination and adapter sanity — three lines that bound a bad run

Grep all three; each is a distinct fault.

```
grep -F "no usable primary key"     #  syncWorker.ts:476
grep -F "looks ignored"             #  syncWorker.ts:486
grep -F "safety cap"                #  syncWorker.ts:505
```

| Line (runtime) | Meaning | Action |
|---|---|---|
| `[erp-sync] so_line: dropped 1000 of 1000 rows on page 1 (no usable primary key)` | The adapter could not read `tbl_1203_SOSalesOrderDetailNID_id` on any row. Field casing or the PK convention is wrong. **Dropped rows are silently absent from the mirror** — the run still reports success. | **Code**, `selarasClient.ts` (`primaryKeyField()` / the adapters' `pick()` name lists). A partial drop (`dropped 3 of 1000`) is normal noise; a total drop is a shape fault. |
| `[erp-sync] so_line: page 7 repeated page 6 verbatim — the 'page' query param looks ignored (assumption A2). Stopping this table; rows already committed are intact.` | The ERP ignores `page`. A2 is wrong. Detected rather than spun on. | **Code**, `buildPageUrl()` — the real paging parameter (`offset`, `skip`, a cursor token) needs to replace `page`. Until then the mirror holds only page 1 × N, which is a **truncated demand side** ⇒ ATP high. Treat as a blocker, not a note. |
| `[erp-sync] so_line: hit the 1000-page safety cap — pagination (A2) is probably wrong` | 1,000 pages × 1,000 rows ≫ 137,580. The cursor or the paging is looping. | **Code.** Also check `STOCK_SYNC_PAGE_SIZE` was not set to something tiny. |

### 3.5 Ambiguous-number refusals — Indonesian-formatted numerics

Emitted **once per table per run**, at the end of the pass, only when something
was refused (`reportRefusals`, `syncWorker.ts:540` and `:547`).

```
grep -F "ambiguous numeric string"
grep -F "non-finite numeric"
```

```
[erp-sync] so_line: refused 8,412 ambiguous numeric string(s) e.g. "1.234", "0.350", "4.880" —
"1.234" is 1234 in id notation and 1.234 in en notation, so it was read as NULL/0 rather than
guessed (A22). Set SELARAS_NUMBER_FORMAT=id or =en once a real response body is known.
```

**Meaning.** Selaras sent numerics as **strings** in a format that is genuinely
ambiguous, and `SELARAS_NUMBER_FORMAT=auto` refused them rather than guessing
(A22, A30). JSON *numbers* are never affected. A refused value becomes NULL, or
`0` on a `not null` column — **`qty_balance` is `not null default 0`, so a
refused balance reserves nothing.** This under-promises rather than
over-promises, which is the deliberate trade: a guessed value can be wrong by
1000× silently.

**But a refused `th` / `p` / `l` becomes NULL, which normalizes to `'-'` in the
key — so a wave of refusals on the dimension columns will *also* show up as a
collapsed match rate in §4.1.** Diagnose this line before concluding the key
composition is wrong.

**Fix — config, one variable, no code change.** The samples in the line are the
evidence. Read them:

| What the samples look like | Set |
|---|---|
| `"4.880"`, `"1.220"` where you know the value is 4880 mm × 1220 mm | `SELARAS_NUMBER_FORMAT=id` |
| `"4,880"`, `"1,220"` for the same physical dimensions | `SELARAS_NUMBER_FORMAT=en` |
| Both shapes present in the same table | **Stop.** Do not set either — under a declared mode the reading is literal with no heuristic (A30), so one mode will silently corrupt the other shape. This needs a per-field decision and a code change. |

`HANDOVER.md` A22 says explicitly: *"A real response body decides the final
default."* This log line **is** the real response body. Set the variable, redeploy,
and confirm the refusal count drops to zero on the next run.

The sibling line — `refused N non-finite numeric(s) … NaN/Infinity` — is X11 and
should be **zero**. Non-zero means the ERP emits `NaN` in a thickness or
dimension column, which is an upstream computation fault. The guard is correct
(nothing was written); investigate upstream rather than tuning anything here.

### 3.6 The commitment gate — `approval` spelled differently

```
grep -F "COMMITMENT GATE MATCHES NOTHING"
```

Source `migrateErpStock.ts:605`. Fires from the boot check **and** from the tail
of every sync run (`checkCommitmentGateAfterSync`, latched so it speaks once):

```
[stock] COMMITMENT GATE MATCHES NOTHING — erp_so_line holds 137580 mirrored line(s)
(4376 with qty_balance > 0) but v_live_commitments is EMPTY. Every SKU's open_commitment is
therefore 0 and ATP equals on-hand: the whole inventory currently reads as promiseable.
Configured approved statuses: [Approved]. Distinct `approval` values actually in the mirror:
[APPROVED (4102), <null> (198), Approve (76)].
FIX: set STOCK_APPROVED_STATUSES to the value(s) the ERP really emits (CSV) and restart —
the views are rebuilt from it on every boot. ST-R7b / OQ-1.
```

**Meaning.** `STOCK_APPROVED_STATUSES` (default `Approved`, a guess — OQ-1)
does not match what the ERP emits. `v_live_commitments` is empty, every SKU's
`open_commitment` is 0, **ATP equals on-hand, and the entire inventory reads as
fully promiseable.** This is the failure mode nobody reports, because the screen
looks like good news.

**Fix — config, exact, no code change.** The line prints the observed values with
their counts. Set `STOCK_APPROVED_STATUSES` to the CSV of the ones that mean
approved, and **redeploy** — the views are recreated from config on every boot,
so a restart is required and a migration is not.

```
STOCK_APPROVED_STATUSES=APPROVED,Approve
```

Then confirm recovery:

```
grep -F "RECOVERED ST-R7b"     # syncWorker.ts:918
```

**Two traps on this line:**

- **It is latched and it is quiet in one legitimate case.** If every mirrored
  line has `qty_balance = 0` the check stays silent by design (warning there
  would fire on every boot forever). So **silence is not proof the gate matches**
  — §4.1 is.
- **An empty `STOCK_APPROVED_STATUSES` is never honoured.** A value that
  validates down to nothing falls back to `Approved` and logs
  `[migrateErpStock] STOCK_APPROVED_STATUSES validated down to an empty set`
  (`migrateErpStock.ts:182`). Grep for it: it means your CSV was rejected by the
  `^[A-Za-z0-9 _-]{1,40}$` whitelist — a status value with a quote, a comma
  inside a token, or a stray character. Fix the spelling, not the whitelist.

The cancelled set (`STOCK_CANCELLED_STATUSES`, A5) fails the **other** way — an
unmatched cancelled value keeps a cancelled line reserving, so ATP is
**understated** and somebody complains. There is no alarm for it and none is
needed; that is the safe direction.

### 3.7 The unmatched-rate alarm — the SKU key does not resolve on real data

**⛔ THIS ALARM WILL NOT FIRE. `checkSkuKeyMatch()` is exported and called by
nothing (§1.7). You must run it by hand.**

The log string is real and greppable — `migrateErpStock.ts:738` — so grep for it
anyway, in case WP-2 wires it before the deploy:

```
grep -F "SKU KEY MATCHES ALMOST NOTHING"
```

```
[stock] SKU KEY MATCHES ALMOST NOTHING — 4361 of 4376 live commitment line(s) (99.7%,
806 of 812 distinct sku_key(s)) match NO row in erp_live_fg. Those commitments reserve nothing,
so ATP equals on-hand for their SKUs and that stock reads as fully promiseable.
Demand-side keys e.g. [-|004|0.3|4|4880|1220 , …]; stock-side keys e.g. [ALUCOMAX|004|0.3|4|4880|1220 , …].
Compare them segment by segment: the knob is STOCK_SKU_KEY_SEGMENTS (current composition
brand|warna|th|th_panel|p|l), and the per-side column mapping is SKU_SEGMENT_SOURCES in erp/sku.ts.
Alert threshold 0.5 (STOCK_UNMATCHED_ALERT_RATIO). ST-R5.2 / ST-R5.3.
```

**Run it by hand instead — this is exactly the query inside the function:**

```sql
-- The unmatched-rate alarm, executed manually. Run it after EVERY sync on
-- deploy day, and after every STOCK_SKU_KEY_SEGMENTS change.
with live as (
  select v.sku_key,
         not exists (select 1 from erp_live_fg f where f.sku_key = v.sku_key) as unmatched
  from v_live_commitments v
)
select count(*)                                                       as live_lines,
       count(*) filter (where unmatched)                              as unmatched_lines,
       round(100.0 * count(*) filter (where unmatched)
             / nullif(count(*),0), 1)                                 as unmatched_pct,
       count(distinct sku_key)                                        as live_keys,
       count(distinct sku_key) filter (where unmatched)               as unmatched_keys
from live;

-- The two sample sets the log line would have printed. Compare SEGMENT BY SEGMENT.
select distinct v.sku_key as demand_side from v_live_commitments v
 where not exists (select 1 from erp_live_fg f where f.sku_key = v.sku_key)
 order by 1 limit 5;
select distinct sku_key as stock_side from erp_live_fg order by 1 limit 5;
```

**Meaning.** The demand side and the supply side compute different keys for the
same physical product. `open_commitment` is 0 for those SKUs, ATP equals
on-hand — **the same silent over-promise as §3.6, arriving through a different
door.** A few unmatched keys are normal and are what the ST-R5.3 exceptions tray
is for; a *majority* unmatched is what a broken key composition looks like.

**Read the two sample lists side by side. The segment that differs names the
fix:**

| Symptom in the samples | Cause | Fix |
|---|---|---|
| Demand side has `-` in segment 1, stock side has a brand | `brand` is not being read on the SO side (or not written — see §1.2b) | **Code**: `SKU_SEGMENT_SOURCES.brand.so_line` in `erp/sku.ts`, or the worker's insert list |
| Both sides populated but the values differ in spelling only | normalization gap | **Code**, both sides together (A10) — never one side alone |
| Sides agree on segments 1–4 and differ on `p` / `l` only | dimension precision or unit | **Config**: drop the segment via `STOCK_SKU_KEY_SEGMENTS` — see §4.4 |
| Demand side has `-` in `th` or `th_panel` and §3.5 fired | refused ambiguous numerics, not a key fault | **Config**: `SELARAS_NUMBER_FORMAT` (§3.5), then re-measure |

`STOCK_UNMATCHED_ALERT_RATIO` is the threshold the unwired function would have
used. It is inert today; do not set it expecting anything to happen.

### 3.8 Success — what a good first run looks like

```
grep -F "run ok"                # syncWorker.ts:1148
```

```
[erp-sync] run ok — 211893 rows across 4 tables in 412907ms
```

Partial success is a different line, and it is not a failure of the run —
degrade-don't-die (`ROLLOUT.md` §6.1: do not alert on a single failed poll):

```
[erp-sync] run finished with errors on so_line — 74313 rows in 380221ms    # syncWorker.ts:1150
```

Then check the HTTP view, which is more useful than the log because it shows the
cursors and the per-table last error:

```
GET /api/stock/sync-status
```

Expect four `tables` entries, each with a non-null `last_ok_at`, a non-null
`cursor_value`, `last_error: null`, and `rows_synced` at or near §1.6's figures.
`last_error` carries the redacted, 500-char-truncated worker error — so a 401 or
404 is visible here without log access.

The ST-R7 freshness alarm, if the sync then stops:

```
grep -F "ALERT ST-R7:"          # syncWorker.ts:876 — fires after 4 × 3 min = 12 min
grep -F "RECOVERED ST-R7"       # syncWorker.ts:885
```

The hourly reconciliation sweep has its own refusals, and they are **safe by
construction** — both leave the mirror exactly as it was:

```
grep -F "ABORTED"               # syncWorker.ts:774, :785, :744
```

`reconcile so_line: ABORTED — the ERP reported ZERO keys while the mirror holds
137580 row(s)…` means a truncating upstream bug and a genuinely emptied source
look identical from here, so the mirror was kept. Correct. Investigate upstream;
do not raise `STOCK_RECONCILE_MIN_RATIO` to make it go away.

---

## 4. Validation after the first successful sync — ST-R5.2, live

This has **never been run**. `ROLLOUT.md` §3 is the design; this is the live
version, against the schema that actually shipped.

**Run against a fully backfilled mirror (D9), not a partial pull.**

### 4.0 First: ROLLOUT §3's SQL will not execute — use these instead

`ROLLOUT.md` §3 and §6.2 call `erp_sku_key(kode_barang, warna, th, p, l)`.
That five-argument overload was **explicitly dropped** by the migration
(`RETIRED_SKU_KEY_SIGNATURES` in `migrateErpStock.ts`, and
`erp_so_line.kode_barang` is dropped with it). The live function is:

```sql
erp_sku_key(p_brand text, p_warna text, p_th numeric, p_th_panel numeric, p_p numeric, p_l numeric)
```

Every query below is ROLLOUT §3's, corrected to six segments. **The decision
tables and the thresholds in ROLLOUT §3 are unchanged and still authoritative** —
this is a signature correction, not a re-litigation. Confirm the signature before
you start:

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

**Live-specific expectation, which `ROLLOUT.md` could not give you.** With ~218
live lines against 1,464 FG rows and 812-ish SKUs, the live demand set is
**small**. So:

- `demand_skus` in the low hundreds is right. **`demand_skus` near zero means the
  commitment gate is wrong (§3.6), not that the key is wrong** — check that
  first, or you will re-compose a key that was fine.
- `qty_fill_pct` at or near **0%** is the §3.7 catastrophe. Stop and diagnose;
  do not tune.
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

`fg_rows_same_brand_warna > 0` is the smoking gun, and it is the v2 analogue of
ROLLOUT §3 Q2's `fg_rows_same_kode`: **the product exists in stock and only a
dimension segment is preventing the match.** That is a key-composition problem,
not make-to-order, and §4.4 is what fixes it.

Read the top 10 aloud with PPIC. "Is this something we actually stock?" is a
question they answer in seconds and no query answers at all.

### 4.3 V3 — projected exceptions-tray volume

```sql
select count(*)        as exception_lines,
       sum(qty_balance) as exception_qty,
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
**PPIC-reviewable list, not a firehose**. With ~218 live lines total, a healthy
tray is **single digits to low tens of lines**. If `exception_lines` is in the
hundreds, the arithmetic says the key is broken, whatever the percentage reads.

`/exceptions` ships with one reason in v1, `sku_tidak_cocok`. ST-R5.4's UoM
exception is not implementable — `erp_so_line` carries no unit column (CONTRACTS,
"Known gap"). **If the real SO payload turns out to carry a UoM, note it now:**
resolving that during ST-R5.2 is exactly what the contract asks for, and this is
ST-R5.2.

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
       count(*) filter (where variants > 1)                             as merged_keys,
       sum(qty) filter (where variants > 1)                             as merged_qty,
       round(100.0*sum(qty) filter (where variants > 1)/nullif(sum(qty),0),2) as merged_qty_pct
from (
  select erp_sku_key(brand, warna, null, null, null, null)              as k,
         count(distinct erp_sku_key(brand, warna, th, th_panel, p, l))  as variants,
         sum(qty)                                                       as qty
  from erp_live_fg group by 1
) t;
```

**The threshold, stated as a rule you can apply without judgement:**

> **Adopt the SHORTEST composition whose qty-weighted fill is ≥ 90% AND whose
> `merged_qty_pct` is < 1%. If no composition satisfies both, keep `k6` and take
> the exceptions.**

A false merge is strictly worse than an exception: an exception is a visible
queue entry a human works; a false merge is a wrong ATP nobody ever sees.
Visible under-matching beats invisible over-pooling.

**Applying a composition change — the full procedure, and the order is not
optional:**

1. Set `STOCK_SKU_KEY_SEGMENTS` (e.g. `brand,warna,th,th_panel`) and
   **redeploy**. Boot rebuilds `erp_sku_key()` and both views from the list.
2. **Backfill immediately.** Between the restart and this step, stored keys
   disagree with the function and **ATP is wrong in both directions**:
   ```sql
   update erp_live_fg set sku_key = erp_sku_key(brand, warna, th, th_panel, p, l);
   update erp_so_line  set sku_key = erp_sku_key(brand, warna, th, th_panel, p, l);
   ```
3. Re-run §4.5. Both counts must be zero.
4. Re-run §4.1 and §4.3 and confirm the predicted fill and tray volume actually
   materialised.

Do this in a maintenance window. Step 1 without step 2 is the one genuinely
non-reversible action in this release (`ROLLOUT.md` §5.4). The TypeScript side
needs no action — it reads the same config through `resolveSkuSegments()`, and
`test/sku.test.ts` proves the two stay byte-identical.

### 4.5 V5 — key drift and injection sanity

```sql
-- Both must be 0. Non-zero = config changed without a backfill, or a hand-edited row.
select count(*) from erp_live_fg where sku_key <> erp_sku_key(brand, warna, th, th_panel, p, l);
select count(*) from erp_so_line  where sku_key <> erp_sku_key(brand, warna, th, th_panel, p, l);

-- Must be 0: a separator surviving inside a segment means a forged key.
-- 6 segments now, not 5.
select count(*) from erp_live_fg where array_length(string_to_array(sku_key, '|'), 1) <> 6;
select count(*) from erp_so_line  where array_length(string_to_array(sku_key, '|'), 1) <> 6;
```

`ROLLOUT.md` §6.2 says any non-zero value is a page. That stands — and note the
`<> 5` in ROLLOUT §3 Q5 is now `<> 6`.

### 4.6 V6 — Black Galaxy, the one number the business has verified

PRD §5A, verified live 2026-09-11: **on-hand 4,168, live commitment 319,
ATP 3,849**, with 1,810 quarantined as stale. `test/atp.test.ts` reproduces it
from fixtures (`ROLLOUT.md` G4). This is the same arithmetic against the real
mirror.

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
select coalesce(sum(f.on_hand), 0)                                as on_hand,       -- expect 4168
       coalesce(sum(l.live),    0)                                as live,          -- expect  319
       coalesce(sum(s.stale),   0)                                as stale,         -- expect 1810
       coalesce(sum(f.on_hand),0) - coalesce(sum(l.live),0)
         + coalesce(sum(a.adj), 0)                                as atp            -- expect 3849
from bg_fg f
left join bg_live  l on l.sku_key = f.sku_key
left join bg_stale s on s.sku_key = f.sku_key
left join bg_adj   a on a.sku_key = f.sku_key;
```

**How to read a miss — the failure is diagnostic, not just a red light:**

| Result | Reading |
|---|---|
| `on_hand` ≈ 4,168, `live` = **0**, `atp` = 4,168 | The commitment gate or the SKU key matches nothing (§3.6 / §3.7). **The single most dangerous outcome** and it looks like a healthy, well-stocked SKU. |
| `on_hand` ≈ 4,168, `live` ≈ **2,129**, `atp` ≈ 2,039 | The naive figure. The liveness window is not being applied — stale lines back to 2020 are reserving. Check `STOCK_STALE_WINDOW_DAYS` and that `v_stale_commitments` is non-empty. |
| `on_hand` far below 4,168 | `erp_live_fg` truncated. Cross-check §1.6 (1,464 rows). |
| `live` materially **above** 319 | The cancelled set (`STOCK_CANCELLED_STATUSES`, A5) does not match — cancelled lines are reserving. Understates ATP; safe direction, but fix it. |
| All four within a few percent | **Ship.** This is the end-to-end proof the whole module was built to produce. |

### 4.7 V7 — PPIC's own expectation, on the top SKUs

`ROLLOUT.md` §2.0.2 gate B, run live. The procedure matters more than the query:

1. Two lists — **top 30 by on-hand** and **top 30 by live commitment**. The
   failure modes differ: the first catches a broken `erp_live_fg` pull, the
   second a broken commitment join.
2. **PPIC states their expectation first, before seeing the screen.** Then read
   them the ATP. Asking first is the entire method; a number shown first anchors
   the answer and the pass measures nothing.
3. Record `plausible` / `not plausible` **per SKU, in writing, with PPIC's name
   against it**. Anything `not plausible` is root-caused before the flip.
4. Cross-check the aggregate: **~95% of the open set should read stale.** A
   wildly different proportion means the window or the approval enum is
   mis-tuned, not that the ERP changed.
5. **Tune `STOCK_STALE_WINDOW_DAYS` once**, record the value and the reason, then
   leave it. Repeated tuning destroys the trust the stale queue depends on.

**Say this out loud when signing it**, because `ROLLOUT.md` §2.0.2 is right that
it is easy to oversell: this is a plausibility check by one team against their
own recollection, not a measured reconciliation against an independent system.
It catches order-of-magnitude errors, a dead join, a mis-tuned window, a
truncated mirror. **It will not catch a systematic few-percent bias.** ST-R16 was
specified to catch that class and was never built; that class of error ships
undetected. §4.3 and `ROLLOUT.md` §6.4 are the production substitute and they are
lagging indicators, not a gate.

---

## 5. Rollback, in rungs

**Fastest first**, which is the opposite of `ROLLOUT.md` §5.1's ordering — and
the difference is deliberate, not a contradiction. ROLLOUT orders by *what
actually reverses the flip*, because its scope is the whole module. This
document's scope is **one deploy that turned on one integration**, and for that
event the fastest lever really is the right first move. **Read the "Reverses
what" column before picking a rung.** Rungs are independent; you may take R1 and
then R2.

| Rung | Action | Time to effect | Blast radius | Reverses what |
|---|---|---|---|---|
| **R0** | Do nothing for one more tick (3 min) | 3 min | none | Nothing — but a 401, a 404, a failed page and an aborted reconcile are all **already safe**: cursor untouched, mirror unchanged, no wrong number served. Do not reach for a lever while the symptom is one the design already contains. |
| **R1** | **Unset `SELARAS_BASE_URL`, redeploy** | **~1 min** | ERP surfaces only | **Containment, not a rollback.** The fastest rung there is. |
| **R2** | Revert to the pre-deploy commit (D2's SHA), redeploy | ~5 min to deploy; **usable only after PPIC re-uploads** | whole app | All Stock 2.0 code. The real rollback. |
| **R3** | Drop the 2.0 schema | ~10 min + permanent data loss | destroys audited decisions | Last resort. Should essentially never happen. |

### R1 — unset `SELARAS_BASE_URL` (the fastest rung, and its honest limits)

```bash
railway variables --unset SELARAS_BASE_URL      # then redeploy
```

**What happens, exactly.** `hasErp` (`config.ts:249`) becomes false. The worker
never starts and logs one line:

```
[erp-sync] disabled — SELARAS_BASE_URL not set; the stock mirror will not refresh
and the ERP surfaces will show 'ERP tidak terhubung'.
```

`POST /api/stock/sync` answers **503 `{"error":"ERP tidak terhubung."}"`**
(`routes/stock-atp.ts:1671`). **The app still boots and still serves** — invariant
§7.7 — and this is a manual checklist item in `ROLLOUT.md` §8, so the behaviour
is confirmed rather than assumed. **No code change, no migration, no build.**

**What it does NOT do, and you must know this before you reach for it:**

- **The mirror is retained, readable and frozen.** `/stock` keeps serving ATP off
  the last-synced numbers behind the stale banner. If ATP is *wrong*, R1 freezes
  the wrong number in place — it does not remove it. **R1 is the right first move
  when the SYNC or the ERP is the problem** (401 storm, 404 storm, the ERP being
  hammered, a truncating pull mid-flight). **It is the wrong move when the
  numbers are wrong**; that is R2.
- **It does not bring 1.0 back.** Bookings stay 410, the booking UI stays out of
  the DOM.
- **It does not stop the 12-minute ST-R7 stale alert** from firing, since nothing
  is succeeding. That is correct and expected; do not chase it.

**`STOCK_ATP_SHADOW` is NOT a lever.** It is defined at `config.ts:222`
(`config.stock.atpShadow`) and **read by no other file in the repository**:

```bash
grep -rn "atpShadow\|STOCK_ATP_SHADOW" apps/server/src packages
# → exactly one hit: the definition in config.ts
```

Setting it to `true` and redeploying changes **nothing** — `/stock` still serves
ATP, the booking endpoints still answer 410, and `stock.html` has no booking UI
for a 1.0 number to appear in. `ROLLOUT.md` §5.1.1 documents this in full. **An
incident runbook whose first step is a no-op costs you the minutes you spend
believing it worked, at the moment those minutes are most expensive.** The same
now applies to `STOCK_UNMATCHED_ALERT_RATIO` (§1.7): a second defined-and-unread
knob. Treat both as documentation, not as controls.

### R1b — the config rungs that are not rollbacks but usually beat one

Every failure in §3 except the envelope shape and the pagination faults is fixed
by **one variable and a redeploy** — roughly two minutes, and it fixes the
problem rather than hiding it. In a live incident, work §3 top to bottom before
escalating to R2:

| Symptom | Variable | Rung cost |
|---|---|---|
| 401 | `SELARAS_KEY_PARAM` / `SELARAS_TOKEN_PARAM` / `SELARAS_AUTH_MODE` | ~2 min |
| 404 | `SELARAS_BASE_URL` | ~2 min |
| ATP = on-hand everywhere, gate line present | `STOCK_APPROVED_STATUSES` | ~2 min |
| ATP understated, cancelled lines reserving | `STOCK_CANCELLED_STATUSES` | ~2 min |
| Numerics refused | `SELARAS_NUMBER_FORMAT` | ~2 min |
| Fill rate below 75% on a dimension segment | `STOCK_SKU_KEY_SEGMENTS` **+ the §4.4 backfill** | ~10 min, maintenance window |
| Over-quarantining (PPIC insists old lines are real) | `STOCK_STALE_WINDOW_DAYS` | ~2 min, and **change it once** |

`STOCK_SKU_KEY_SEGMENTS` is the only one of these that is not freely reversible:
step 1 without step 2 leaves stored keys disagreeing with the function and serves
wrong ATP in both directions until the backfill runs. Never do the config change
and the backfill separately.

### R2 — revert the deploy (the real rollback for wrong numbers)

```bash
git revert --no-commit <D2 SHA>..HEAD    # or redeploy the previous Railway image
```

**~5 minutes to deploy — but not a working 1.0 until PPIC re-uploads a current
Excel, realistically the rest of the working day.** That re-upload dominates the
time profile. This is why D3 tells PPIC *before*, not after.

Why it is safe, and the property that makes it safe:

- **The 1.0 tables are intact.** `stock_uploads`, `stock_items`,
  `stock_bookings` were never altered or truncated — the 1.0 *write routes* were
  gutted to 410; the data was not touched.
- **Nothing was written to them while 2.0 was live**, because every booking and
  upload POST returned 410. 1.0 resumes precisely where it stopped: no gap to
  reconcile, no reverse migration.
- **`migrateErpStock.ts` is purely additive** — all new names, no `alter` on any
  1.0 table, no backfill, no rename. **Reverting after the migration has already
  run requires no schema action at all**; the new objects become inert and cost
  only disk. A reverted binary does not call `runErpStockMigrations()`, so the
  views simply stop being recreated and sit at their last definition.
- **2.0 data written during the window is retained, not lost.**
  `stock_adjustments` and `stock_commitment_overrides` keep every row with its
  actor and timestamp. Rolling forward again picks them straight back up.

**The one caveat this deploy adds, and `ROLLOUT.md` could not have known it:**
this release's migration **drops `erp_so_line.kode_barang`**. That is still
additive with respect to 1.0 — it touches only a 2.0 mirror table — but it means
a revert to a binary older than the v2 key remap will find a mirror whose shape
its worker does not expect. **The mirror is disposable** (it is a cache of the
ERP; a re-sync rebuilds it), so the recovery is `truncate erp_so_line;
erp_sync_state.cursor_value := null` and let it refill — **not** a schema
rollback. Write that line in the ticket, because under pressure "the migration
dropped a column" reads like a reason to reach for R3, and it is not.

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

Then views → functions → tables (full statement list in `ROLLOUT.md` §5.3, plus
`erp_warna` and `erp_num_or_null(text)`, which post-date it).

The `erp_*` mirror is disposable. `stock_adjustments` and
`stock_commitment_overrides` are **not** — they are LeadScout-owned decisions
that exist nowhere else. Export them or lose them.

### The rung that does not exist

**There is no one-minute lever that reverses the flip.** R1 is one minute and is
containment; R2 reverses the flip and is not one minute. That is the single most
important operational fact on this page, and it is the same fact
`ROLLOUT.md` §5.1 arrived at. Do not let the speed of R1 be mistaken for a
rollback in the incident channel.

---

## 6. What we still cannot verify — and what each one costs

Stated plainly. "Unverified" is a much better answer than a false claim.
These are **in addition to** `ROLLOUT.md` §7 X1–X12, which all still stand.

| # | Cannot verify | Why | Risk carried |
|---|---|---|---|
| **U1** | **Any of it, before production.** `selaras2.io` is unreachable from the sandbox and from CI by egress policy. No recorded response body exists. | Environmental. | **The premise of this document.** Everything in §3 is inference from source, not observation. The mitigations are real (one `adaptRow()` per table, one envelope reader, `hasErp` degradation) and the failure direction is mostly benign — an unparseable API yields an empty mirror and "ERP tidak terhubung", not wrong numbers. **The exception is anything that makes commitments not match stock**, which yields confident wrong numbers. §4.1 is the only thing standing between that and the sales floor. |
| **U2** | **The unmatched-rate alarm.** `checkSkuKeyMatch()` is exported and called by nothing (§1.7). | Found at audit; the call site was never written. | **High.** The alarm for the most expensive failure this module has does not fire. Mitigated **only** by running §3.7's SQL manually on deploy day. **The moment the Architect stops watching the logs by hand, this risk is uncovered again.** Fix: one wrapped call in `syncWorker.ts` beside the existing two — WP-2, code change, before the flip is announced. |
| **U3** | **That `STOCK_UNMATCHED_ALERT_RATIO` does anything.** | It is read only by the unwired U2 function. | **Low directly, high as a pattern.** Second defined-and-unread knob in one module (`STOCK_ATP_SHADOW` is the first). Either wire it or delete it; leaving it is the one option that should not survive review. |
| **U4** | **That missing credentials are detectable at boot.** `hasErpCredentials` (`config.ts:255`) is exported and read by nothing. | Never wired. | **Low.** The symptom is the §3.1 401, which is diagnosable. But the module's own comment says it is *"kept separate so an unauthenticated misconfiguration is a loud 401 in the sync log rather than a silently disabled integration"* — it is neither loud nor distinguishable from a wrong password. |
| **U5** | **That the worker and the client agree** (§1.2). | Two files, one package, mid-edit at the time of writing. | **Certain failure if unclosed.** This is a pre-flight gate, not a residual risk — but it is listed here because *nothing in CI catches the column-list half of it*: `postgres.js` takes column names as strings, so `tsc` cannot see them, and the DB-backed suites skip without `DATABASE_URL`. |
| **U6** | **`erp_warna` freshness.** `evaluateStaleAlert()` queries `table_name in ('so_header','so_line','live_fg')` — the colour master is excluded. | Deliberate-looking, undocumented. | **Low.** A stale colour master means PPIC reads a stale colour *name*; `warna` is matched by **id**, so ATP is unaffected. Confirm the exclusion is intended and write it down; an undocumented exclusion is how the next person concludes the alert is broken. |
| **U7** | **Load at real volume.** 137,580 SO lines against fixtures of tens of rows. | No representative dataset outside production. | **Medium.** `ROLLOUT.md` X12. Run `explain (analyze, buffers)` on the `/summary` aggregate against the backfilled mirror at D9, **before** §4.7, and record the timing. A sequential scan over 137k lines on every page poll is the predictable failure, and it will present as a slow page, not an error. |
| **U8** | **Concurrency at two Railway instances.** | Single-process assumption; the DB `running` guard is real but unproven at scale. | **Medium.** `ROLLOUT.md` X9. **Keep the service at one replica through the first sync.** A duplicated worker could double-page a 138-page backfill. This is a Railway setting, not a code risk — check it at D4. |
| **U9** | **That the first sync is atomic in any sense.** It is not. | By design: page-at-a-time commits, cursor advanced per committed page. | **Low, but it shapes the watch.** Between D7 and D9 the mirror is **partially populated**, so ATP is computable and wrong (supply loaded, demand not yet, or vice versa). The sync order — `warna → so_header → so_line → live_fg` — puts on-hand **last**, so the partial state reads ATP **low**, not high. That is the safe direction, and it is why §4 runs only after `run ok`. **Do not let anyone read `/stock` for a real decision during the backfill window.** |

---

## 7. Findings raised by this document

Each was verified against the source, not inferred. None is fixed here — this
package owns no source file.

| # | Finding | Owner | Blocking? |
|---|---|---|---|
| F1 | `syncWorker.ts` still writes `kode_barang` and writes neither `brand` nor `th_panel`; the migration drops `kode_barang`. Every `so_line` insert will raise `42703`. | WP-2 | **Yes — deploy blocker** |
| F2 | `checkSkuKeyMatch()` is exported and never called. `config.ts` and `erp/sku.ts` both document it as running on every sync. It does not. | WP-2 | **Yes — announce blocker** (deploy may proceed if §3.7 is run manually) |
| F3 | In `header` mode the client sends the **query-param** names as header names; `selarasKeyHeader` / `selarasTokenHeader` are read only by the redactor. The config comment says this exact bug was fixed. | WP-2 | No — config workaround in §1.5, but it is the most likely 401 |
| F4 | `ROLLOUT.md` §3 and §6.2 call a five-argument `erp_sku_key` that the migration explicitly drops. The documented validation runbook cannot execute. | WP-7 / this doc | No — §4 supersedes |
| F5 | `hasErpCredentials` exported, read by nothing. | WP-2 | No |
| F6 | `STOCK_UNMATCHED_ALERT_RATIO` is the second defined-and-unread knob in this module. | Architect | No — but decide: wire or delete |
| F7 | `evaluateStaleAlert()` excludes `erp_warna` from freshness. Undocumented. | WP-2 | No |

---

## 8. Change log

| Date | Change | By |
|---|---|---|
| 2026-09-11 | First draft. Live-contact runbook for the first real ERP connection: pre-flight gates (incl. the client/worker disagreement and the header-name defect), deploy sequence, the ordered first-sync log watch with verified grep strings, live ST-R5.2 validation corrected to the v2 six-segment key, rollback rungs ordered fastest-first for this event, and nine residual unverifiables. Seven findings raised; F1 and F2 are blockers. | QA & Deployment |
