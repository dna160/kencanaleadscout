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
