# Stock 2.0 — PROGRESS LOG

Append-only. Newest entry at the bottom. One entry per agent handoff or
context-exhaustion event. Format:

```
## <WP-n> · <agent> · <UTC timestamp>
**Complete:** files fully done
**In flight:** file + exactly where it stops
**Learned:** anything not yet in HANDOVER/CONTRACTS
**Next action:** the single next thing
```

---

## WP-0 · scaffold · 2026-09-11
**Complete:** `docs/stock-2.0/{PRD,CONTRACTS,HANDOVER,PROGRESS}.md`, `src/erp/`
directory created, codebase surveyed.
**In flight:** none.
**Learned:** No Selaras ERP integration exists anywhere in the repo — the PRD's
three dependency docs are absent and `grep -ri selaras` over source returns zero
hits. All ERP response shapes are therefore unverified; see HANDOVER §2.
Existing stock module: `routes/stock.ts` 1,243 lines, `db/migrateStock.ts` 172,
`public/stock.html` 561, `public/stock-ppic.html` 841.
**Next action:** WP-1 (foundation) — config, `sku.ts`, `migrateErpStock.ts`.

## WP-1 · back-end · 2026-09-11
**Complete:** `config.ts` (54→113), `erp/sku.ts` (new, 206), `db/migrateErpStock.ts`
(new, 352), `index.ts` (+2 lines, migration wiring only), `.env.example` (19→49).
**In flight:** none.
**Learned:**
- TS↔SQL `sku_key` parity verified empirically, 12/12 fixtures byte-identical vs
  live PG 16, including the tie cases (`1.005→1.01`, `99.995→100`, `-0.005→-0.01`).
  Postgres `round(numeric,2)` is exact decimal half-away-from-zero; `Math.round`
  and `toFixed` round the binary double and disagree on ties. `sku.ts` therefore
  rounds the decimal *string*, not the double. Do not "simplify" this.
- Both sides use ASCII-only case folding and explicit `[ \t\n\r\f\v]`, never
  `upper()` or `\s`, which are collation-dependent (`ß`, NBSP).
- A `|` inside `warna` is stripped, so the separator cannot be injected.
- `STOCK_CANCELLED_STATUSES` injection attempt was rejected by the whitelist.
- Idempotence proven: `pg_dump -s` after run 1 vs run 3 is byte-identical.
- A local PG 16 cluster is running in the sandbox: `postgres://kencana:kencana@localhost:5432/leadscout`,
  schema migrated, test rows cleaned. WP-3 and WP-7 can use it.
**Architect ruling:** the NULL-ETA challenge was upheld — see CONTRACTS AMENDMENT 1
(undated approved lines are LIVE and reserve) and AMENDMENT 2 (invariant §7.6
reworded). Assumptions A9–A15 logged in HANDOVER §7.
**Next action:** WP-2 (ERP client + sync worker), WP-3/WP-4 (ATP engine + routes +
retirement), WP-7 (tests + rollout) — all now unblocked.

## WP-8 · back-end · 2026-09-14
**Complete:** ST-R22 rule 2 — the SPB (goods-out) auto-close. `config.ts`
(+`STOCK_AUTOCLOSE_ON_SPB`, `STOCK_AUTOCLOSE_SPB_REQUIRE_FULL`, both default
true), `db/migrateErpStock.ts` (mirror columns `summary_spb`/`summary_do`, the
rule, and the view builder extracted to `buildCommitmentViewSql()` /
`applyCommitmentViews()` so the rules are testable at non-deployed settings),
`erp/selarasClient.ts` + `erp/syncWorker.ts` (both columns mirrored end to end),
`routes/stock-atp.ts` (four new `totals.*` counters, `summary_spb`/`summary_do`/
`autoclose_reserving` on every commitment row), `.env.example`. 22 new tests
(465 → 487 green).
**In flight:** none.
**Learned:**
- The rule joins AMENDMENT 20's single `autoclosed` expression as a second
  disjunct — one predicate, one reinstate path, one segment, §7.6 unchanged.
  `autoclose_basis` is what distinguishes them, and the aged rule is named first
  when both fire so an existing row's narration cannot change.
- This rule MOVES ATP, unlike rule 1. The movement is measured, not argued:
  `autoclose_reserving` on the view is true exactly for lines the liveness rule
  would have kept live, and Σ their `qty_balance` IS the delta
  (`totals.autoclosed_spb_atp_delta`).
- `summary_spb` is NOT mirrored on existing rows until they are re-synced (the
  column is new and nullable). NULL is not an SPB, so the rule is a strict no-op
  over a mirror that has not been re-pulled — see the report's re-sync note.
- Blank AND the ERP's `'-'` placeholder must both read as "no document"; the
  predicate trims spaces and dashes, and a real hyphenated number survives.
- **For the architect:** AMENDMENT 20 states that an undated line is "never"
  auto-closed. That ruling was about the AGE BASIS (the withdrawn `po_date`
  fallback). This rule reads a document rather than a date, so an undated line
  with an SPB IS closed — deliberately, and it is part of the population that
  moves ATP. CONTRACTS needs an amendment saying so; nothing in CONTRACTS.md was
  edited here.
**Next action:** front-end — the Tripwire in AMENDMENT 20 has now fired (a second
machine-decided population exists), so `Keputusan Sistem` on the Sinkronisasi tab
is due; the rows already carry `autoclose_basis`, `autoclose_reserving`,
`summary_spb` and `summary_do` to render it.


## Intermittent test — UNRESOLVED, recorded not dismissed · 2026-09-14
Immediately after the SPB work landed, the suite failed **2 of the first 3 runs**
with a single unnamed failure, then passed **10 consecutive runs**. The failing
test could not be captured — by the time a capture harness was in place it had
stopped reproducing.

**Most likely cause:** fixture residue in the shared `leadscout` database from a
concurrently-running agent, which later runs cleaned up. `routes.test.ts` and
`atp.test.ts` isolate by transaction rollback plus an id prefix, but the shared
database has already caused one silent corruption earlier in this project (a
prior package's Black Galaxy fixtures polluted an aggregate assertion).

**Why this is not dismissed as a flake:** "flake" is not a root cause. An
intermittent failure on a suite that gates a deploy is a latent CI problem, and
the standing rule in this project is that a failure is real until proven
otherwise. It is recorded here rather than left to be rediscovered.

**Next step when someone picks this up:** run the suite in a loop with
`--reporter=verbose` capturing full output to a file until it reproduces, then
fix the isolation rather than the assertion. Do not add a retry.
