# Kabar Pesanan — Customer Order Notifications · PRD v1.0 (consolidated)

| | |
|---|---|
| **Status** | **v1.0, consolidated.** Supersedes v0.1–v0.3. MVP test pipeline **built and in the repo** (stub channel); everything after Phase 1 is specified, not built. |
| **Date** | 2026-11-10 |
| **Owner** | Mechashock (product) · Claude (spec) |
| **Product** | LeadScout (`dna160/kencanaleadscout`, `apps/server`) |
| **Companion docs** | `docs/ontology/SELARAS-ONTOLOGY.md` (verified ERP map, 165 tables) · `claude/leadscout-2.0-prd.md` (master: auth, F1, F2) · `claude/stock-system-prd.md` (mirror + derived-state patterns) |
| **Audience** | Whoever builds the next phase (human or Claude Code). §4–§7 plus the phase's work packages in §14 are enough to build from. |

---

## 0. Summary

**What.** When an order moves in the ERP, LeadScout sends the customer a WhatsApp message, with a copy to the sales rep. It works like RentOS: a Kencana WhatsApp number linked to a self-hosted **whatsmeow** gateway. The MVP covers three movements:

1. **Pesanan diterima**: SO received.
2. **Mulai produksi**: production started (make-to-order only).
3. **Pengiriman dijadwalkan**: DO created, quoting its scheduled date (pickups get "siap diambil").

Later phases add delivery confirmation, CBD/COD payment nudges, and Tempo due-date reminders once paid status is available.

**Why.**
- Today the rep's personal WhatsApp is the order-status system. That eats hunting time, depends on one person, and leaves money waiting: Rp 3.1bn of SO value sat in "waiting approval" in the September review.
- Payment terms explain lost projects better than price does. A system that knows who pays on time is a future sales weapon.

**The architectural bet (future-proofing).** Don't build "a notifier". Build an **order event backbone**:
- **ERP mirror**: Selaras copied into LeadScout's Postgres.
- **Order events**: facts derived from the mirror, append-only and idempotent.
- **Notification rules**: subscribe to those events.
- **Outbox**: holds, re-checks and pacing before anything is sent.
- **Channels**: stub today, whatsmeow next, Cloud API or email later.

Notifications are the first consumer. The same events later feed the customer-360 timeline, the F2 sales tracker, the delay log for the ERP business case, a tracking page, internal alerts, and an AI auto-reply on the notification number. None of those should require touching the ERP or re-deriving state.

**Trigger and rep come straight from Selaras.** A message fires as soon as the ERP records the movement: a webhook once the Selaras vendor adds one (the API has none today), a 60-second poll until then. The rep CC'd is the sales person Selaras puts on the SO, whatever the segment.

**Where we are.** The ERP has been swept and verified (Appendix A). `/notify` is built and committed: config, a three-step test pipeline with sales CC, trigger rules, a ledger, a stub channel, a gateway adapter and 26 tests. **Next:** deploy and smoke-test (rest of WP-0), fix the SO mirror key, build the event engine and the whatsmeow gateway, then two weeks of internal shadow sends to reps.

---

## 1. Decisions locked (owner, 2026-11-10)

| # | Decision | Consequence |
|---|---|---|
| D1 | **Channel = whatsmeow** (WhatsApp Web multi-device / linked device, LID-aware), self-hosted, RentOS-style. Not a BSP, not Qontak. | No template approval, no per-message fee, free-form text. Ban risk is an accepted trade-off, controlled by §10.4. |
| D2 | **MVP = 3 movements, no Finance-approval logic.** | Wording stays neutral ("diproses"). No payment language until Phase 3. |
| D3 | **Recipient = the phone on the SO:** `tbl_1202.kontak_penerima` ("Telepon"). | Verified field. Fallbacks in §9. |
| D4 | **Delivery wording = "dijadwalkan kirim"**, using `sj_date`. | DOs are created the day before dispatch (verified). |
| D5 | **Sales rep is CC'd** on every customer message. | Needs a rep-phone mapping (§9.4); the ERP has none. |
| D6 | **Stub first.** Config + test pipeline before any live send. | Built (§13). |
| D7 | Deliverables are PRDs for Claude Code to execute; PPIC is a data source, never instructed. | Messages never promise dates the ERP didn't give. |
| D8 | **Selaras is the single source of truth; send as soon as the ERP records the movement.** Webhook-driven when Selaras supports it; until then a fast poll (60 s). | §5.0. No business logic is keyed on LeadScout's retail/project/distributor verticals. |
| D9 | **The rep is whoever Selaras puts on the SO** (`1202.sales_name` → `tbl_1130` id). One rep-phone list keyed by that Selaras ID, vertical-agnostic. | §9.4. The preferred end state is the phone stored in Selaras itself. |

---

## 2. Problem, users, goals

**Users.**

| Who | Gets | Owns |
|---|---|---|
| Customer (retail toko, project/contractor, distributor) | Order movement messages; later delivery confirmation and payment reminders | Opt-out (STOP) |
| Sales rep | A CC of every customer message; later forwarded replies | Keeping customer phones accurate |
| Sales Admin | Ledger, mutes, test pipeline | Message wording |
| Finance (from Phase 3) | Payment-nudge policy, exclusions, overdue queues | Dunning rules, paid-status feed |
| PPIC / logistics | Nothing new to do | Data source only |
| Management | Accuracy, coverage, WISMO and DSO trends | Phase gates |

**Goals.**
- G1. Customers hear about major order movements from Kencana, accurately, without asking a rep.
- G2. **Zero false messages.** Accuracy beats coverage at every gate.
- G3. Free rep time: WISMO ("where is my order") traffic down.
- G4. Faster cash: CBD/COD paid sooner, Tempo paid on time (Phase 3+).
- G5. One event backbone that later customer-facing features reuse (§5).

**Non-goals (v1).**
- No write-back to Selaras or Accurate.
- No messages that make promises on PPIC's behalf.
- No marketing broadcasts on this number (separate consent, separate number).
- No automatic credit holds.
- No customer login. The Phase 5 tracking link is tokenized and needs no account.

---

## 3. Evidence base: what is true about the ERP

Verified by the 2026-11-10 sweep (all 165 tables, plus 60-day cross-tabs on 2,636 SOs and 2,809 DOs). Full detail is in Appendix A and `docs/ontology/SELARAS-ONTOLOGY.md`.

- **Order-to-cash spine:** `1054` Customer → `1202` SO header / `1203` SO lines → (`1236` Request Produksi → `1190` WO Production FG) → `1082` DO header / `1205` DO lines → `1179` FG mutations (auto-created from 1205). `1332`/`1261` are daily exports **to** Accurate.
- **SO number** = `po_no` (e.g. `SO.26/12821`) on 1202, 1203 and 1205. 1082 and 1236 call it `so_no`.
- **Recipient phone** `1202.kontak_penerima`: 84% one clean mobile, ~5% two numbers in one field, 10% empty. 7 numbers receive SOs for ≥ 3 different customers (likely a forwarder or staff).
- **Production** applies to ~4% of SOs. `1236.so_no` is filled on 97% of SO-type requests (`so_ms = 'SO'`). `approval_factory_manager` and `status_request` are dead (always "Waiting").
- **DO** (`1082`): `sj_date` = scheduled date (DO created 1 day earlier in 90%, 2 days in 9%). `cara_kirim` = di Antar 76% / di Ambil 24%. `cancel_order` Yes 0.7%. 97% of SOs have exactly one DO. **Never filled:** `delivery_date`, `received_date`, `driver`, `no_kendaraan`.
- **Timing:** 80% of SOs get their DO the next day, so messages 1 and 3 usually land within 24 hours.
- **Payment:** `top_limit` is CBD 66%, COD 13% (distinct terms), Tempo ~21%. `1082.due_date` = `sj_date` + `top_days` (99.2%). `invoice_no` is set per DO. **Paid status is not in Selaras** (lives in Accurate).
- **Approval:** Finance's button = `1203.approval` ("Approval Finance"). The live header field is `approval_new`; header `approval` is dead. Approval is unreliable: 164 CBD SOs shipped while still "Waiting".
- **Volume:** ~1,300 SOs and ~1,400 DOs per month.
- **Rep master** (`1130`) has **no phone**.
- **Snapshot tables** (1210, 1212, 1325, 1326, 1180, 1254, 1261, 1332) are rebuilt daily, so `updated_at` is useless as a change cursor there. `1179.updated_at` is bulk-touched.

---

## 4. LeadScout today (as-is architecture)

```
Railway project ── service "leadscout" (Dockerfile, Node 20, one Fastify process)
                └─ Railway Postgres

apps/server
  src/index.ts        bootstrap: static pages, route plugins, boot migrations, in-process timers
  src/config.ts       env-driven config singleton (hasDatabase / hasErp flags; everything degrades)
  src/db/*.ts         additive, idempotent migrations run on every boot (migrate, migrateStock, migrateErpStock, migrateNotify)
  src/erp/            selarasClient.ts (REST, auth, adaptRow per table, redaction)
                      syncWorker.ts (180 s poll, updated_at cursors, upsert erp_* mirror, guarded by erp_sync_state lock + heartbeat)
  src/routes/*.ts     one Fastify plugin per module (visits ×4 verticals, stock-atp, color-gateway, sy-hunter, notify …)
  public/*.html       server-served vanilla HTML/JS pages, one per surface, Bahasa UI
  test/*.test.ts      vitest; DB tests skip without DATABASE_URL
packages/core         pure IP (phone normalization → E.164, scraping)
```

**Properties to respect:**
- **Single process, in-process timers.** Cadence engines and the ERP sync run on `setInterval` inside the web process. The sync already uses a DB lock with heartbeat, so a second replica is safe for it.
- **Mirror-first.** Features read `erp_*` tables, never Selaras inline. The `/notify` "Muat dari ERP" preview is a deliberate, human-triggered exception.
- **Derived, never stored** (from Stock 2.0). State is recomputed from the mirror, so replays cannot double-count.
- **No auth on `main` yet.** LeadScout 2.0 Phase A (Clerk, role areas, `AUTH_ENFORCED` off/shadow/on) exists as an unapplied patch. Until it lands, `/notify` writes are guarded by `NOTIFY_ADMIN_TOKEN`.
- **Rep rosters are per vertical:** `salespeople` (has `phone_e164`), `distributor_salespeople` (has `phone_e164`), `project_salespeople` and `mirae_salespeople` (no phone). Kabar Pesanan does **not** use them; the rep comes from Selaras (D9).

**Fixed defect (WP-1, ✅).** The mirror's SO adapter used to read the SO number from `so_number`/`no_so`/…, and the line→header link from `so_id`/…. Selaras has neither: the real key is `po_no` on both tables, so the old join matched nothing in production. Both mirror tables now carry `po_no`; lines find their header through `SO_HEADER_LOOKUP_SQL` (a lateral `limit 1` on `po_no`, falling back to `so_id`), which can never duplicate a line even if two header rows share an SO number. The first boot after deploy resets the `so_header` / `so_line` sync cursors once, so both tables are re-pulled in full and `po_no` gets filled in.

---

## 5. Target architecture

```
                      ┌──────────────────────────── LeadScout (Railway) ─────────────────────────────┐
 Selaras ─webhook*/poll 60s─► ERP mirror (erp_*)                                                            │
 (read-only)          │   so_header·so_line·do_header·do_line·request_produksi·(customer, pic)       │
                      │        │                                                                      │
                      │        ▼  derive (idempotent, per sync batch)                                 │
                      │   ORDER EVENTS  (order_events: append-only facts, unique event_key)          │
                      │        │   so.created · production.requested · production.completed          │
                      │        │   do.created · do.cancelled · (invoice.issued · payment.received)   │
                      │        ├──────────────► consumers: customer-360 timeline · F2 tracker ·       │
                      │        │                delay log · tracking page · internal alerts           │
                      │        ▼                                                                      │
                      │   NOTIFICATION RULES  (code-defined, versioned; exclusions, recipients)       │
                      │        ▼                                                                      │
                      │   OUTBOX  (notify_ledger: pending → held → sending → sent|failed|cancelled)   │
                      │        │   hold window · pre-send recheck · merge · quiet hours · caps        │
                      │        ▼   dispatcher (leased, replica-safe)                                  │
                      │   CHANNEL  stub | gateway | (cloud-api | email later)                         │
                      └────────┼─────────────────────────────────────────────────────────────────────┘
                               ▼ internal HTTP
                      wa-gateway (Go + whatsmeow, own Railway service, wa_store schema)
                               │  ⇄ WhatsApp (linked device on the dedicated number)
                               └─ events back: receipts · inbound (LID→PN) · logged_out · temp_ban
```

### 5.0 Trigger source: webhook first, fast poll until then (D8)
- **Verified 2026-11-10:** the Selaras API is documented as *read-only* with exactly three endpoints (`GET /api/tables`, `GET /api/table/{t}/columns`, `GET /api/table/{t}`). There is no webhook or push today.
- **Target:** ask the Selaras vendor for an outbound webhook on insert/update of `1202`, `1236` and `1082` (POST `{table, id, action}` to `/api/erp/webhook`, HMAC-signed). LeadScout then re-reads that one row, upserts the mirror, derives the event and sends. That is seconds end to end.
- **Until then:** a dedicated *fast lane* polls only those three tables every **60 s** with `updated_at__gte` cursors (~3 small requests/min; the full stock sync keeps its 180 s cadence). Worst-case latency is ~1 min.
- **Both paths feed the same event deriver**, so switching from poll to webhook changes nothing downstream. The poll stays on as a safety net for missed webhooks.
- **Hold windows are policy, not plumbing.** Defaults are short (MV1 10 min, to absorb SOs deleted or edited right after entry; MV2/MV3 0 min) and configurable to 0 for fully immediate sends. The MV1+MV3 merge applies only when both are pending at the same time.

### 5.1 Why events, not "on change → send" (the future-proofing core)
- **One derivation, many consumers.** "DO KP/DO-13224 created for SO.26/12821, scheduled 11 Nov, pickup" is a business fact. Notifications, the customer-360 timeline (master PRD F2-R6), the M9 delay log, a tracking page and an AI reply agent all need it. Derive it once.
- **Idempotent by construction.** `event_key` is the event type plus a natural key (e.g. `do.created:KP/DO-13224/11/26`), unique in the table. A re-sync, replay or second replica cannot create a duplicate. The same discipline as Stock 2.0 ATP.
- **Replaceable source.** If Selaras ever offers webhooks (it has a dormant notification module, `tbl_1278`), they become another *producer* of the same events. Nothing downstream changes.
- **Cold start is trivial.** Backfilling events for history is harmless, because rules only fire for events newer than the activation watermark.

### 5.2 Outbox and dispatcher
- Rules write **outbox rows**, never channel calls.
- A dispatcher claims due rows with `FOR UPDATE SKIP LOCKED` (replica-safe, the same idea as the ERP lock). For each row it:
  1. re-derives the condition (pre-send recheck);
  2. applies merge, caps and quiet hours;
  3. calls the channel;
  4. records the result.
- If the ERP mirror is stale (last success > 3 sync intervals), the dispatcher pauses. Messages wait; they are never dropped.

### 5.3 Process model
- **Today:** the event deriver runs as a step after each successful sync batch, and the dispatcher on its own timer, both inside the web process. Configured with `NOTIFY_LIVE` and `NOTIFY_DISPATCH_INTERVAL_MS`.
- **Later:** the same image with `ROLE=worker` runs sync, derivation and dispatch as a separate Railway service. Leasing makes that a deploy-config change, not a rewrite.

### 5.4 Channel layer
- `Channel` interface: `send`, `health`. Built: `StubChannel`, `GatewayChannel`.
- Future channels plug in without touching rules: `CloudApiChannel` (Meta, if the ban risk ever bites), `EmailChannel` (invoices), and `MultiNumberGateway` (number pool, if volume or the number of brands grows).
- The ledger records `channel`, `from_number` and `template_version` for every message.

---

## 6. Data model

All additive; migrations run on boot. ✅ = built.

**Mirror extensions (WP-1 / WP-2)** ✅
- `erp_so_header` + `po_no` (fixes the key), `customer_name_id`, `customer_final_id`, `buyer_name_id`, `sales_name_id`, `penerima`, `kontak_penerima`, `alamat_kirim`, `top_limit`, `top_limit_value`, `approval_new`, `erp_created_at`. (A header deleted upstream is removed, as the stock sync always did.)
- `erp_so_line` + `po_no` (the join key, replacing `so_id`) ✅.
- `erp_do_header` ← `tbl_1082`: `id`, `so_no`, `no_sj`, `sj_date`, `do_created_at`, `cara_kirim`, `cancel_order`, `print_status`, `top`, `top_days`, `due_date`, `invoice_no`, `customer_name_id`, `customer_name_text`, `total_lembar`, `total_m2`, `erp_created_at`, `erp_updated_at`, `deleted_at`.
- `erp_do_line` ← `tbl_1205`: `id`, `po_no`, `so_item_no`, `sj_id` (Selaras `sj_no`, the 1082 row id), `do_text`, `sj_date`, `sn_fg`, `item_details`, `qty_delivered`, timestamps, `deleted_at`.
- `erp_request_produksi` ← `tbl_1236`: `id`, `so_no`, `so_ms`, `wo_no`, `no_request`, `tanggal_request`, `brand`/`warna` (+ `_text`), `th_panel` (1236 `th_alu_skin`), `th_skin` (1236 `alu`), `qty_lembar`, timestamps, `deleted_at`.
- `erp_sales` ← `tbl_1130`: `id`, `sales_name`, `department`, `active`, `phone` (NULL today; filled automatically if Selaras adds a phone column).
- Order-table rows deleted upstream are **kept** with `deleted_at`, so WP-3 can derive `do.cancelled`.
- Sync state lives in `erp_order_sync_state` (one row per table and cursor field) and `erp_order_sync_lease`, apart from the stock sync's `erp_sync_state`.
- Later: `erp_wo_output` ← `1190` (`request_id`, `status_automatic`, `production_date`); `erp_customer` ← `1054`; `erp_customer_pic` ← `1055`.

**Events** ✅
- `order_events`: `id`, `event_key` **unique**, `event_type`, `so_no`, `subject_ref` (no_sj / request id), `occurred_at` (ERP time), `detected_at`, `payload jsonb`, `source` ('erp-mirror' | 'erp-webhook' | 'manual').
- `order_event_state` (single row): `swept_until` (catch-up watermark), `late_swept_at`.

**Notifications**
- ✅ `notify_settings` (single row): `system_number`. Extend with `live_enabled`, `activation_watermark`, `daily_cap`, `quiet_start` / `quiet_end`.
- ✅ `notify_ledger` (= outbox). Has `mode`, `milestone`, `so_no`, `recipient_role` (customer | sales_cc), `to_number`, `from_number`, `body`, `channel`, `status`, `provider_message_id`, `error`, `context_source`, `idempotency_key` **unique**, `created_at`. Extend with `event_id`, `due_at`, `attempts`, `leased_until`, `template_version`, `lid`, `delivered_at`, `read_at`, `cancel_reason`.
- `notify_contacts`: `phone_e164` **pk**, `lid`, `consent_state` (implied | explicit | opted_out), `consent_source`, `opted_out_at`, `shared_flag` (≥ 3 customers in 90 days), `first_contacted_at`, `notes`.
- `notify_customer_overrides`: `customer_name_id`, `phone_e164` | null, `muted`, `digest_mode`, `set_by`, `reason`.
- `notify_sales_contacts`: `erp_sales_id` (→ 1130) **pk**, `sales_name`, `active` (mirrored from 1130), `phone_e164`, `cc_enabled`, `source` ('manual' now, 'selaras' once 1130 carries a phone). Vertical-agnostic; editable on `/notify`.

**Retention.** Message bodies are redacted after 180 days; metadata is kept. Raw phone numbers live only in `notify_contacts`, the ledger and the mirror.

---

## 7. Milestones and triggers

| # | Event | Notification | Primary signal (verified) | Hold / merge | Coverage | Phase |
|---|---|---|---|---|---|---|
| **MV1** | `so.created` | **Pesanan diterima** | New `1202` row (po_no), not deleted, `status_order` not cancelled | 10 min hold (configurable to 0). If a `do.created` for the SO is pending at release → **merged** "diterima & dijadwalkan" message (NTF-R2a) | All non-excluded SOs | **MVP** |
| **MV2** | `production.requested` | **Mulai produksi** | `1236` row with `so_ms='SO'` and `so_no` = SO (97% filled); `wo_no` | 0 min (configurable) | ~4% of SOs | **MVP** |
| **MV3** | `do.created` | **Pengiriman dijadwalkan** / **siap diambil** | New `1082` row for `so_no`, `cancel_order='No'`; date = `sj_date`; pickup if `cara_kirim` ~ "ambil"; items from `1205` | 0 min; cancel if `do.cancelled` before dispatch | One per DO | **MVP** |
| — | `do.cancelled` | (internal) cancels a pending MV3; tells the rep if MV3 already went out | `cancel_order` flips to Yes / row deleted | — | 0.7% | MVP |
| M2b | `production.completed` | "Selesai diproduksi" (optional) | `1190` `status_automatic='Done'`, `production_date` set, via `request_id` | Merge with MV3 if within 24 h | ~4% | 3 |
| M5 | `delivery.received` | **Diterima** | Not in the ERP. Needs a POD source: driver link/photo, or logistics fills `1082.received_date` | — | — | 3 |
| M1 | `so.approved` | "Dikonfirmasi" | `approval_new` → Approved (unreliable, so not used for payment) | — | — | 3 |
| M1-W | — | Menunggu pembayaran (CBD/COD) | CBD/COD term **and** `approval_new='Waiting'` > 2 h, not shipped | Max 2 nudges | ~79% of SOs are CBD/COD | 3 |
| M7 | `invoice.due_soon` | Pengingat jatuh tempo | `1082.due_date` − today; **send only if Accurate paid-status says outstanding > 0, from a feed < 24 h old** | Ladder R1–R3 customer, R4–R5 internal | Tempo ~21% | 4 |
| M9 | `so.late` | (internal) Terlambat | `estimate_delivery` passed, not delivered, within the 60-day liveness window | — | — | 1 (internal) |

**Exclusions (rules layer).**
- Marketplace SOs (`1368+` tables).
- Related parties (Anugerah Kencana Panelindo, KMI) and Kencana SY Build.
- Customers with `muted` overrides.
- Shared numbers (held for review).
- SOs created before the activation watermark.
- `customer_final` ≠ `customer_name` → route to the purchaser PIC or suppress. This is rare (2 of 2,636 SOs), but it protects distributors.

**Idempotency keys.** `notify:{milestone}:{so_no|no_sj}:{role}:{phone}`. Test sends add a UUID.

---

## 8. Messages

- **Source of truth:** `apps/server/src/notify/messages.ts` (built). It is pure functions shared by the test pipeline and the live path, so what a tester sees is exactly what customers get. `template_version` (a git hash or semver constant) is recorded per message.
- **Rules:**
  - Bahasa Indonesia, WhatsApp formatting.
  - Greet `penerima` (fall back to the customer name).
  - Items as "Brand Warna Tmm / skin × qty lembar", at most 3 lines, then "dan N item lainnya".
  - Show the rep's name and WA.
  - Sign off "— PT Kencana Panelindo", then the STOP footer.
  - **No payment, approval or price language in MVP messages.**
  - Dates only from the ERP (`sj_date`). Production messages carry no date.
- **Optional intro** on the first-ever message to a number ("nomor resmi notifikasi pesanan…").
- **Sales CC** = "📋 *Salinan Kabar Pesanan* — {step}" + customer name and number + SO + the exact customer text.
- **Anti-fingerprinting:** 2–3 equivalent phrasings per message type, rotated, so sends are never byte-identical (NTF-R38).
- **Later templates:** Diterima, Menunggu pembayaran (official bank account only, plus "Kencana tidak pernah meminta transfer ke rekening pribadi"), due reminders. See Appendix B.

---

## 9. Recipients, consent, sales CC

### 9.1 Customer recipient resolution (live)
1. `notify_customer_overrides.phone_e164`, if set.
2. `1202.kontak_penerima`: split on `/`, `&` or `,`; take the first number that normalizes to an Indonesian mobile (`@kencana/core normalizeNumber`); keep the rest as fallback.
3. `1055` PIC via `buyer_name`.
4. `1054.phone_number`.
5. None → `unreachable`, flagged to the rep.

Before the first send to a number, the gateway's `/check` runs (WhatsApp `IsOnWhatsApp`). A number that isn't on WhatsApp is marked `undeliverable`.

### 9.2 Guards
- **Shared-number guard:** a number receiving SOs for ≥ 3 different customers in 90 days is held for review.
- **Batching per phone**, not per customer: 98 numbers had ≥ 5 SOs in 60 days.
- Daily cap per phone (default 3); the overflow goes into an end-of-day digest.
- Quiet hours 07:00–20:00 WIB; payment messages 08:00–17:00, never Sundays or holidays.

### 9.3 Consent
- **Implied:** the recipient is on the SO.
- **Explicit:** a rep confirms it in LeadScout.
- **Opt-out:** a "STOP" or "BERHENTI" reply, resolved from LID back to the phone number, takes effect within one dispatch cycle and is permanent until re-consent.
- Consent source and time are stored, in line with Indonesia's PDP Law (UU 27/2022).

### 9.4 Sales CC (D5, D9)
- **Who:** the rep Selaras puts on the SO, `1202.sales_name` (→ `tbl_1130` id; the SO also carries `project_sales_name`). Retail, project, distributor and Mirae make no difference; LeadScout's per-vertical rosters are **not** used.
- **Phone:** Selaras' rep master (`tbl_1130`, 86 reps / 60 active) has **no phone column** (verified), so the number has to come from somewhere:
  - **Preferred:** ask the Selaras vendor to add a WhatsApp number field to *CRM - List Sales* (`tbl_1130`). Then it truly lives in Selaras and LeadScout just mirrors it.
  - **Until then:** one table on `/notify`, `notify_sales_contacts`, lists the active Selaras reps by their Selaras ID with one phone field each. Filled once (60 numbers), and it falls away when Selaras has the field.
- **CC rule:** every customer message is copied to that rep. No phone → no CC, and the rep shows as "CC belum aktif" on `/notify`.
- **Reps see what customers see.** In Phase 1 shadow, only the reps receive messages (§13).

---

## 10. Channel: whatsmeow gateway (`apps/wa-gateway`)

### 10.1 Service
- Go service on Railway, internal networking only.
- Session in Postgres schema `wa_store`, so a redeploy never needs re-pairing.
- One dedicated number (never a rep's, the main sales number, or the Qontak number).
- Pairing by QR or phone-number code, from an admin page that the gateway serves through LeadScout `/notify`.

### 10.2 API (contract fixed now; `GatewayChannel` is built against it)
- `POST /send {to_pn, text, idempotency_key}` → `{message_id, queued}`
- `POST /check {pns[]}` → `[{pn, on_whatsapp, jid, lid?}]`
- `GET /health` → `{connected, logged_in, phone_last_seen, queue_depth}`
- `GET /pair` → QR or pairing code (admin)
- Callbacks to `POST {LEADSCOUT}/api/notify/wa-events`:
  - `receipt {message_id, status: server_ack|delivered|read}`
  - `inbound {from_pn|from_lid, text, ts}`
  - `logged_out`, `temporary_ban {expires}`, `disconnected`
- Auth: `x-gateway-secret` both ways.
- The gateway de-duplicates on `idempotency_key` for 7 days.

### 10.3 LID-aware addressing
- WhatsApp is migrating users to LIDs (`…@lid`). For a LID-migrated account, whatsmeow reports the sender as a LID, not a phone number.
- **Outbound:** address by phone number. whatsmeow resolves it through its LID store.
- **Inbound:** resolve LID → phone number from the persisted mapping. If unknown, forward the raw LID and attach it to `notify_contacts.lid` once a later receipt or message reveals the pair.
- LeadScout never assumes a phone number is present on inbound messages.

### 10.4 Operating safely (the controls behind D1)
- **Pacing:** 8–25 s random gap between sends, typing presence first; hourly and daily caps (start at 200/day).
- **Warm-up:** Phase 1 internal traffic, then a gradual customer ramp.
- **Content:** personalised, non-identical; no links in a first message.
- **Opt-out:** STOP honoured instantly.
- **Failure handling:**
  - `logged_out` / `temporary_ban` / 10 minutes disconnected → alert the admin and pause the outbox. Nothing is dropped.
  - The primary phone stays powered and online; a linked device is dropped after prolonged primary inactivity.
  - A standby number is ready to pair.
- **Escape hatch:** the provider-agnostic `Channel` means moving to Cloud API is a new adapter, not a redesign.

### 10.5 Inbound replies
- STOP → opt-out.
- Anything else → forwarded to the SO's rep (WA + LeadScout feed), with a polite auto-reply that names the rep and says this number isn't a CS inbox.
- **Future:** an AI reply agent answering "pesanan saya sudah sampai mana?" from `order_events`. It is read-only and hands off to the rep.

---

## 11. Admin surface: `/notify`

**Built ✅**
- **Uji Pipeline:**
  - Inputs: customer test number, sales CC number, sales name, optional SO number with "Muat dari ERP" (4 read-only GETs; the real recipient is shown masked and never messaged), an intro toggle.
  - Three buttons with "Pemicu di sistem live" rule panels.
  - WhatsApp-style preview of the customer message and the sales CC, with status chips.
  - Warnings when a real SO wouldn't trigger a step (e.g. no production request).
- **Konfigurasi:** system number (normalized to E.164), channel mode and health, admin-token field.
- **Riwayat:** ledger with message bodies.

**Built in WP-6 ✅** — tabs Live, Antrian, Shadow, Sales CC, Pelanggan (see §14 WP-6).

**Access.**
- Today: `NOTIFY_ADMIN_TOKEN` on writes.
- After LeadScout 2.0 Phase A: area `notify-admin` (Admin, Sales Admin, Finance) and read-only `notify-view` (C-Level).
- The token then retires, but stays for the gateway callback.

---

## 12. Security & privacy

- **Secrets:** Selaras key/token, gateway secret and admin token are Railway env only; error paths use `redactSecrets`. The Selaras key pasted in chat on 2026-11-10 should be **rotated**.
- **PII:**
  - Phone numbers are normalized and stored once.
  - The test pipeline cannot message ERP recipients.
  - The sweep and ontology tooling never records PII values.
  - Ledger bodies are redacted at 180 days.
- **Abuse:** rate limit on test sends (30 per 10 min per process). Gateway mode refuses to send without an admin token.
- **Fail-safe:** a stale mirror, unknown term or missing data delays or omits a message. It never produces a wrong one.

---

## 13. Phasing (status and gates)

| Phase | Scope | Gate | Status |
|---|---|---|---|
| **0 — Discovery** | ERP sweep and ontology; field verification; MVP test pipeline (stub) | Signals verified on ≥ 200 SOs | ✅ Done (pipeline committed; deploy + smoke test pending) |
| **1 — Backbone + shadow** (≈ 3 wks) | WP-1…WP-6: mirror key fix and extensions; `order_events` deriver; outbox and dispatcher; wa-gateway with pairing; sales CC mapping. **Live triggers on, but every message goes only to the SO's rep** (shadow), which doubles as number warm-up. Plus the M9 internal delay log | **≥ 99% "benar"** on rep-graded MV1–MV3 over 2 weeks; 0 gateway logouts; < 1% unreachable reps | Next |
| **2 — Customer MVP** | Customers receive MV1–MV3 and reps get the CC. Pilot **retail** → project → distributor. Pacing, caps, STOP | 0 false messages in the pilot month; opt-out < 3%; WISMO down | — |
| **3 — Close the delivery loop + COD/CBD** | POD source (driver link or `received_date` discipline) → M5; M2b; M1-W nudges and the "CBD menunggu" queue | CBD created→approved median −30% | — |
| **4 — Tempo reminders** | Accurate paid-status feed (Accurate Online API, else daily AR export upload); ladder R1–R5; Finance exclusions | 30 days with 0 reminders to paid invoices | — |
| **5 — Customer surface** | Tokenized tracking page; payment links / VA with auto-confirm; payment-behaviour score → TOP decisions (`1207`); AI reply agent | — | — |

---

## 14. Work packages (Claude Code handoff, Phase 1)

Each WP is independently testable. The order is the dependency order.

- **WP-0. Land the MVP.**
  - ✅ Code committed (`/notify`, `src/notify/*`, `migrateNotify.ts`, 26 tests).
  - Merge, deploy.
  - Set `NOTIFY_ADMIN_TOKEN`.
  - Smoke-test `/notify` with a real SO number.
- **WP-1. Mirror key fix** ✅ (`erp/selarasClient.ts` adapters, `migrateErpStock.ts`, `syncWorker.ts`; tests in `test/soKey.test.ts` and `atp.test.ts`).
  - Map `po_no` on 1202 and 1203; add `po_no` columns; join lines↔header on `po_no`.
  - One-time full re-pull of both tables.
  - Test: fixture rows with `po_no` populate both, and the line→header join is non-null.
  - Must not change ATP results (assert in `atp.test.ts`).
- **WP-2. Mirror extensions + fast lane.** ✅ (`erp/orderTables.ts`, `erp/orderSync.ts`, `db/migrateOrders.ts`, `routes/erp-webhook.ts`; tests in `test/orderLane.test.ts`)
  - `do_header` (1082), `do_line` (1205), `request_produksi` (1236) and `sales` (1130) mirrored with adapters (field names from Appendix A). **Built as a separate order lane, not in `SYNC_TABLES`**: the stock sync's lock, freshness alarm and purge sweep are scoped to stock, and a DO-table outage must not raise stock alarms.
  - 60 s lane for 1202, 1236, 1082 and 1205 (§5.0); 1130 every 30th tick. Own lease, so a second replica can't double-run it. Separate from the 180 s stock sync.
  - An empty cursor starts `ERP_ORDER_BACKFILL_DAYS` (60) back instead of pulling all history (78k DOs, 143k DO lines).
  - `POST /api/erp/webhook` (HMAC-SHA256 of the raw body in `x-selaras-signature`; payload `{table, id, action}` is only a pointer, and the row is re-read from the ERP). 503 until `ERP_WEBHOOK_SECRET` is set.
  - 1202 header columns extended; the first boot re-pulls the header table once to fill them.
  - Cursor on `updated_at`, plus a `created_at` cursor for 1236.
  - Consumers subscribe with `onOrderRows()` and receive the ids written per run (WP-3 hooks in here).
  - **Not done:** contract fixtures from real rows (masked). This needs ERP access; the fixtures in `orderLane.test.ts` follow the verified field names.
- **WP-3. Event deriver** ✅ (`events/derive.ts` pure core, `events/store.ts`, `events/runner.ts`, `db/migrateEvents.ts`, `routes/order-events.ts`; tests in `test/events.test.ts`)
  - After each order-lane batch (poll or webhook), derive `so.created`, `production.requested`, `do.created`, `do.cancelled` from the rows touched; `source` records `erp-mirror` vs `erp-webhook`.
  - `insert … on conflict (event_key) do nothing`. Keys: `so.created:{po_no}`, `production.requested:{so_no}:{wo_no}`, `do.created:{no_sj}`, `do.cancelled:{no_sj}`, `so.late:{po_no}:{earliest passed ETA}`.
  - Pure-function core with tests: replaying the same batch twice yields one event.
  - **Added:** a catch-up sweep every 5 min over mirror rows whose `synced_at` moved, from either sync loop, so events don't depend on a listener having run (and still flow with the lane off). `so.late` runs every 30 min from `v_live_commitments` (ETA passed, balance owed, inside the liveness window).
  - **Added:** rows created more than `EVENTS_HORIZON_DAYS` (60) ago produce no events, so the WP-1 re-pull of 75k historic SOs isn't recorded as news.
  - Payloads carry business facts only, never phone numbers: WP-4 reads the recipient from the mirror at send time.
  - Read-only: `GET /api/orders/events?so_no=&type=&limit=` and `GET /api/orders/sync-status`.
- **WP-4. Rules + outbox + dispatcher** ✅ (`notify/rules.ts` pure policy, `notify/context.ts`, `notify/dispatcher.ts`; tests in `test/dispatcher.test.ts`)
  - Planner: event → outbox rows (customer + sales CC) in `notify_ledger` with `due_at` = hold. One row per (mode, step, subject, role); step 3 is per DO.
  - Recipient resolution (§9.1): override → `kontak_penerima` (split, first Indonesian mobile). **Not yet:** the 1055 PIC / 1054 phone fallbacks (those tables aren't mirrored); a missing number is `unreachable` and the rep's CC says so.
  - Exclusions (§7): related parties (`NOTIFY_EXCLUDE_CUSTOMERS`, whole-word match), direct-ship (`customer_final` ≠ `customer_name`, suppressed until OQ-3), muted overrides, stale events (> 24 h on the ERP clock), and anything before the activation watermark.
  - Dispatcher: claim with `FOR UPDATE SKIP LOCKED` (a crashed claim is reclaimed after its lease); pre-send recheck from the mirror; MV1+MV3 merge in either order; opt-out; shared-number hold (≥ 3 customers in 90 days → `held`); daily cap per phone (overflow waits for tomorrow, no digest yet); sending window 07–20 WIB; staleness and gateway pauses; failed sends retried with backoff (3 attempts).
  - `do.cancelled`: a pending step 3 is cancelled; if the customer was already told, the rep gets a notice and the customer is not re-messaged.
  - Shadow mode sends **every** message only to the rep, prefixed "[SHADOW]", with the live verdict (would send to 0812-****-4455 / no number / opted out / held) and a BENAR/SALAH prompt.
  - Flags: `NOTIFY_LIVE=off|shadow|on` (default off). Any mode change sets the activation watermark to now, starts planning after the newest event, and cancels the previous mode's pending rows.
  - API: `GET/PUT /api/notify/sales-contacts` (rep phones, ahead of the WP-6 table); `/api/notify/config` reports the live mode, since when, and outbox counts; `/api/notify/ledger` filters by mode/status/SO.
  - **Not yet:** anti-fingerprinting variants (NTF-R38), the end-of-day digest, the 180-day body redaction.
- **WP-5. wa-gateway** ✅ (`apps/wa-gateway`, Go 1.26; whatsmeow pinned to the 2026-10-27 commit `1eec113`; deploy notes in `apps/wa-gateway/README.md`)
  - whatsmeow with the Postgres store (schema `wa_store`), the §10.2 API, a **persistent** outbox (`wa_store.wa_outbox`, written before `/send` answers; 7-day idempotency), paced sender (typing first, 8–25 s gap, hourly 40 / daily 200 caps, waits while disconnected), receipts and inbound callbacks, LID resolution (SenderAlt, then the LID store).
  - A number with no LID is looked up once via `IsOnWhatsApp` before failing permanently as `not_on_whatsapp` (whatsmeow returns `ErrRecipientNotOnWhatsApp` since 2026-10-26).
  - Added to the contract: `POST /pair/phone` (link by 8-character code), `GET /healthz` (open liveness), and `status`/`duplicate` in the `/send` answer.
  - LeadScout: `POST /api/notify/wa-events` (receipts → ledger `sent`/`delivered_at`/`read_at`/`failed`; STOP/BERHENTI → opt-out + one confirmation, MULAI → back in; a rep's BENAR/SALAH grades their latest [SHADOW] message; other customer replies → forwarded to the SO's rep + at most one auto-reply per 24 h; logged_out / temporary_ban / disconnected recorded and shown on `/api/notify/config`). Pairing proxy: `GET /api/notify/gateway/pair`, `POST /api/notify/gateway/pair-phone` (admin token).
  - Railway: its own service, Root Directory `apps/wa-gateway`, exactly one replica, private networking only.
  - Verified here: builds, 13 Go tests (race detector, Postgres outbox), and a live boot that reached WhatsApp and produced a pairing QR. **Not verified:** the Docker image build (no Docker daemon here) and an actual paired send (needs the dedicated number, OQ-1).
- **WP-6. `/notify` additions.** ✅ (`public/notify.html` tabs; API in `routes/notify-admin.ts`; tests in `test/notifyAdmin.test.ts` + dispatcher switch tests)
  - **Live:** mode, sending state, channel, gateway state, 7-day counts; a global kill switch (pauses sending, nothing dropped) and per-step on/off (a step that is off is recorded `skipped: milestone_off`); the order lane's cursors and errors. The **mode itself stays the `NOTIFY_LIVE` env var**: switching customers on is a deploy decision, not a click. The switches can only make things safer.
  - **Pairing:** QR rendered server-side as SVG (`qrcode`, no external scripts), auto-refreshing; or an 8-character code by phone number.
  - **Antrian:** pending (send now / cancel), held shared numbers (reviewed → release, sent despite the guard, or cancel), failed / no number, recent; plus incoming replies.
  - **Shadow:** % "benar" against the 99% gate over 14 days, SALAH first; admins can grade too.
  - **Sales CC:** Selaras reps by ID with one phone field each and a CC toggle; "CC belum aktif" count.
  - **Pelanggan:** search customers from SOs, set a replacement number and/or mute, with a reason.
  - Every admin action records who acted (`x-notify-actor`, the name typed on Konfigurasi).

---

## 15. Success metrics

| Metric | Target | Phase |
|---|---|---|
| False-message rate | 0 in shadow and pilot; < 0.1% at scale | 1–2 |
| SOs with a reachable WhatsApp recipient | ≥ 85% | 1–2 |
| Reps with an active CC number | 100% of active reps | 1 |
| ERP movement → message latency | ≤ hold + ~1 min on the 60 s poll; seconds once Selaras webhooks exist | 2 |
| WISMO messages to reps | −50% in 3 months | 2 |
| Opt-out rate | < 3% | 2+ |
| Gateway: bans / logouts recovered | 0 / < 1 h | 1+ |
| CBD created→approved median | −30% | 3 |
| Tempo paid by due date; DSO | +10 pts; −7 days | 4 |

---

## 16. Risks

| Risk | Mitigation |
|---|---|
| Number restricted (unofficial channel) | §10.4 controls; standby number; provider-agnostic channel |
| ERP fields misread or drift | Verified ontology; adapters per table; contract fixtures; shadow grading |
| Mirror key defect produces wrong SO grouping | WP-1 before any live trigger |
| Stale mirror (sync outages have happened) | Dispatcher pauses; no catch-up blast (events > 24 h old → digest line) |
| Wrong or shared recipient | Shared-number guard; first message minimal; consent and STOP |
| Reps feel bypassed | They're CC'd, named as contact, can mute; shadow phase is theirs first |
| Payment message to someone who has paid | Phase 4 gated on a fresh Accurate feed and a pre-send recheck; humans after R3 |
| Single-process timers overloaded | Leasing now; `ROLE=worker` split later |

---

## 17. Open questions

- OQ-1. Which number is the dedicated notification number, which phone holds it (always on), and who holds the standby?
- OQ-2. Can the Selaras vendor add a WhatsApp number to *CRM - List Sales* (`tbl_1130`)? If not, the 60 active reps' numbers are entered once on `/notify`.
- OQ-3. Distributor direct-ship: when `kontak_penerima` is the distributor's end customer, suppress or route to the purchaser? (Rare, but a policy is needed.)
- OQ-4. POD source for "Diterima": driver link, or will logistics start filling `received_date`?
- OQ-5. Accurate edition (Online API vs desktop), and who owns the daily AR export (Phase 4).
- OQ-6. Sender identity: one "Kencana Panelindo" number for all brands, or per brand/entity (Mirae)?
- OQ-7. Will the Selaras vendor add outbound webhooks for `1202`/`1236`/`1082` inserts and updates? (Verified: the API has none today.)

---

## 18. Where this goes (future-proofing map)

Each item is a new consumer of the backbone, not new plumbing.

1. **Order timeline everywhere.** `order_events` powers the customer-360 panel and the F2 tracker's SO/DELIVERED legs (master PRD §11).
2. **Delay log.** `so.late` accumulates the evidence for the ERP-investment business case from Phase 1 onward.
3. **Tracking page.** A tokenized "Lacak pesanan" link in each message; later SJ/invoice download.
4. **AI reply agent** on the notification number, answering status questions from events. Fits the existing MCP tooling.
5. **Payment loop.** Due reminders → payment links / VA → auto-confirmed `payment.received` → payment-behaviour score → evidence for TOP approvals (`1207`). This turns payment terms into a sales weapon instead of a loss reason.
6. **Distributor feed.** Distributors get their own order stream (digest or webhook), supporting the konsinyasi → firm-PO ladder.
7. **Internal alerts.** CBD waiting, approval ageing, stale SOs, stock shortfalls, all on the same outbox.
8. **More producers.** Selaras webhooks, Accurate, the LeadScout F1 production runs: all emit the same event types.

---

## Appendix A — Selaras field reference (verified 2026-11-10)

| Table | Use | Key fields |
|---|---|---|
| `tbl_1202_SOSalesOrderNID` | SO header | `po_no` (SO no), `po_date`, `status_order` {Done, Half Done, Wating}, `customer_name` (→1054, `_label`), `customer_final`, `customer_project`, `buyer_name` (→1055), `penerima`, **`kontak_penerima`** ("Telepon"), `alamat_kirim`, `sales_name` (→1130), `sales_name_text`, **`top_limit`** ("Pembayaran"), `top_limit_value`, **`approval_new`**, `sj_no_summary`, `remarks`, `created_at`, `deleted_at`. Dead: `approval`, `invoice_no_summary` |
| `tbl_1203_SOSalesOrderDetailNID` | SO lines | `po_no`, `brand(_text)`, `warna(_text)`, `total_thickness_acp` (panel mm), `th_alu_skin` (skin), `p`, `l`, `qty_order`, `qty_delivered`, `qty_balance`, `estimate_delivery`, **`approval` ("Approval Finance")**, `summary_do`. Dead: `sj_no`, `invoice_no`, `qty_produksi`, `sn_fg`, `summary_spb` |
| `tbl_1236_DBRequestProduksiID` | Production request | `so_ms` {SO, MS, O, TRIAL}, `so_no`, `wo_no`, `no_request` (→1280), `tanggal_request`, `sticker(_text)` (brand), `warna(_text)`, `th_alu_skin` (= **panel** mm, "Tebal"), `alu` (skin), `qty_lembar`. Dead: `approval_factory_manager`, `status_request`, `po_no` |
| `tbl_1190_WOProductionOutputID` | Production output | `request_id` (→1236 id), `wo_no`, `status_automatic` {Done, Waiting}, `production_date`, `planning_qty`, `actual_qty`, `no_so` (42%) |
| `tbl_1082_SOLogisticPID` | DO / surat jalan | `so_no`, `no_sj`, **`sj_date`** (scheduled), `do_created_at`, `tanggal_spb`, `cara_kirim` (→combo; di Antar / di Ambil), `cancel_order`, `print_status`, `top`, `top_days`, `due_date`, `invoice_no`, `pembeli` (→1055), `contact_person`. Dead: `delivery_date`, `received_date`, `driver`, `no_kendaraan` |
| `tbl_1205_SOSalesOrderDeliveryNID` | DO lines | `po_no`, `so_item_no` (→1203), `sj_no` (→1082 id), `do_text`, `sj_date`, `sn_fg`, `item_details`, `qty_delivered` |
| `tbl_1054_DBCustomer` / `tbl_1055_DBCustomerPIC` | Customer / PIC | `phone_number`, `top_days`, `top_value`, `sales_name`; PIC `pic_customer`, `position`, `phone_number` |
| `tbl_1130_CRMListSalesID` | Reps | `sales_name`, `department`, `active`. **No phone** |
| `tbl_1332` / `tbl_1261` | Daily export to Accurate | `invoicenumber`, `due_date`, `paid` (always "No"). Not a paid-status source |

API: `GET {base}/table/{t}?col=val&col__gte=…&fields=…&order_by=…&limit=…&page=…`, headers `X-Secret-Key` / `X-Secret-Token`. Lookup columns also return `<col>_label`.

## Appendix B — Message templates (current, `messages.ts`)

- **MV1:** "Halo Bapak/Ibu {penerima}, Pesanan Anda nomor *{SO}* telah kami terima dan sedang diproses. Ringkasan: {items} … Untuk pertanyaan, silakan hubungi sales Anda, {sales} ({wa}). — PT Kencana Panelindo · _Balas STOP…_"
- **MV2:** "…Pesanan *{SO}* saat ini sedang diproduksi di pabrik kami. Item: … Kami akan mengabari Anda kembali saat jadwal pengiriman sudah ditetapkan."
- **MV3 (antar):** "…Pesanan *{SO}* telah dijadwalkan untuk dikirim. No. surat jalan: {sj} · Jadwal pengiriman: {Hari, tgl Bulan tahun} · [Alamat kirim] · Barang: … [Ini pengiriman sebagian; sisa pesanan menyusul.] Mohon periksa kondisi dan jumlah barang saat diterima."
- **MV3 (ambil):** "…Pesanan *{SO}* sudah siap diambil mulai {tanggal} (No. DO {sj}). Barang: … Silakan koordinasikan waktu pengambilan dengan sales Anda."
- **Sales CC:** "📋 *Salinan Kabar Pesanan* — {langkah} · Pelanggan: {nama} ({nomor}) · SO … · — Pesan yang dikirim ke pelanggan — {teks}"
- **Later:**
  - Diterima.
  - Menunggu pembayaran (official account + anti-fraud line).
  - R1 due reminder: "…tagihan untuk pengiriman {sj} ({invoice}) akan jatuh tempo pada {due_date}… Abaikan pesan ini apabila pembayaran telah dilakukan."

## Appendix C — Configuration

| Env | Default | Purpose |
|---|---|---|
| `NOTIFY_CHANNEL` | `stub` | `stub` or `gateway` ✅ |
| `WA_GATEWAY_URL` / `WA_GATEWAY_SECRET` | — | Gateway endpoint and shared secret ✅ |
| `NOTIFY_ADMIN_TOKEN` | — | Guards `/notify` writes; required for gateway mode ✅ |
| `NOTIFY_TEST_SENDS_PER_10MIN` | 30 | Test-pipeline rate limit ✅ |
| `NOTIFY_LIVE` | `off` | `off` / `shadow` / `on` ✅ |
| `NOTIFY_DISPATCH_INTERVAL_MS` | 15000 | Dispatcher tick ✅ |
| `NOTIFY_HOLD_MV1_MIN` / `_MV2_MIN` / `_MV3_MIN` | 10 / 0 / 0 | Holds; 0 = send on detection ✅ |
| `NOTIFY_SEND_FROM_HOUR` / `NOTIFY_SEND_UNTIL_HOUR` | 7 / 20 | Sending window, WIB ✅ |
| `NOTIFY_MAX_EVENT_AGE_HOURS` | 24 | Older movements are skipped ✅ |
| `NOTIFY_EXCLUDE_CUSTOMERS` | Anugerah Kencana Panelindo, KMI, Kencana SY Build | Never messaged ✅ |
| `NOTIFY_SHARED_NUMBER_CUSTOMERS` | 3 | Shared-number hold threshold ✅ |
| `ERP_FAST_POLL_MS` | 60000 | Order lane for 1202/1236/1082/1205; 0 disables it ✅ |
| `ERP_ORDER_SLOW_EVERY_TICKS` | 30 | Rep master (1130) read every Nth tick ✅ |
| `ERP_ORDER_BACKFILL_DAYS` | 60 | Where an empty order-lane cursor starts ✅ |
| `ERP_ORDER_PAGE_SIZE` / `ERP_ORDER_MAX_PAGES_PER_TICK` | 500 / 20 | Order-lane paging ✅ |
| `ERP_WEBHOOK_SECRET` | — | HMAC secret for Selaras webhooks; empty ⇒ webhook 503 ✅ |
| `NOTIFY_DAILY_CAP_PER_PHONE` | 3 | Cap ✅ |
| `EVENTS_SWEEP_MS` | 300000 | Event catch-up sweep; 0 disables the timer ✅ |
| `EVENTS_LATE_SWEEP_MINUTES` | 30 | `so.late` check cadence ✅ |
| `EVENTS_HORIZON_DAYS` | 60 | Older SOs/DOs/requests produce no events ✅ |
| `SELARAS_*` | existing | ERP access (shared with the stock sync) |

## Appendix D — Built API (`/api/notify`)

- `GET /config` → `{systemNumber, channel{mode,connected,detail}, adminTokenRequired, erpLookupAvailable, databaseAvailable, milestones[{key,step,label,trigger,hold,coverage,notes}]}`
- `PUT /config {systemNumber}` [token]
- `GET /order?so_no=` → read-only SO preview (recipient masked)
- `POST /test {milestone, customerNumber, salesNumber?, salesName?, soNo?, introduce?}` [token] → `{from, context, warnings[], messages[{role,to,text,status,providerMessageId,error}]}`
- `GET /ledger?limit=`

Files: `src/notify/{messages,channel,erpLookup}.ts`, `src/routes/notify.ts`, `src/db/migrateNotify.ts`, `public/notify.html`, `test/notify.test.ts` (26 tests).

## Appendix E — Decision log

| Date | Decision | By |
|---|---|---|
| 2026-11-10 | Customer notifications as a LeadScout module | Owner |
| 2026-11-10 | MVP without Finance approval; 3 movements | Owner |
| 2026-11-10 | whatsmeow (linked device, LID-aware) over BSP / Qontak | Owner |
| 2026-11-10 | Recipient = `kontak_penerima`; delivery wording "dijadwalkan kirim" | Owner |
| 2026-11-10 | Sales CC in MVP; stub-first test pipeline | Owner |
| 2026-11-10 | Event backbone + outbox architecture (§5) | Spec |
| 2026-11-10 | ERP verified by full sweep; auto-ontology not run (no NVIDIA key) | Spec |
| 2026-11-10 | Selaras is the single source of truth: send on ERP movement (webhook when available, 60 s poll until then); rep = Selaras sales on the SO, vertical-agnostic | Owner |
