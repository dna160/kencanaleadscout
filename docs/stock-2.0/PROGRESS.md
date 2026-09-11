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
