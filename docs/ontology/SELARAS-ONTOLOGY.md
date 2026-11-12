# Selaras ERP — Ontology (verified sweep, 2026-11-10)

**Source.** A one-off, read-only sweep from an isolated Railway service (Railway project `selaras-ontology-sweep`, service `selaras-sweep`, to be deleted after use). It pulled all **165 tables** through the live REST API:
- column list with lookup (FK) metadata;
- the 300 most-recently-updated rows, profiled per column (fill %, distinct values, date range; PII values never recorded);
- total row count, rows updated in the last 30 / 365 days, and first-created date.

Cross-tabs on the last 60 days of SO, DO and production rows were then run through the same service. The sweep script is `docs/ontology/selaras-sweep.ts`; raw per-table numbers are in `sweep-overview-2026-11-10.txt`.

Auto-ontology (NVIDIA) was **not** run: no `nvapi-` key. The semantic labelling below was done by hand from the profiles. The FK graph is the ERP's own lookup metadata, not inferred.

---

## 1. How to read Selaras (conventions that hold everywhere)

| Convention | Meaning | Evidence |
|---|---|---|
| `col` + `col_text` / `col_label` | Lookup columns store an **ID**; the API adds `<col>_label` with the text, and many tables also persist a `_text` copy | Lookup metadata on every FK column ("Kolom ini menyimpan ID…") |
| `…ID` suffix | Transactional / entry table (documents people create) | 1202, 1203, 1082, 1236, 1190… all active |
| `…MX` suffix | Derived table: snapshot, report or export builder | 1210, 1212, 1180, 1261, 1332 are rebuilt daily |
| `…MA` suffix | Legacy/alternate copy | 1272 SO Detail MA: 228k rows, frozen since 2023-10 |
| `loaded_by` | Who/what wrote the row: `1` = user form, `Excel`, `Rule` = scheduled rule, `Auto Insert` = triggered by another table, `tbl_XXXX` = generated from that table | 1179 rows carry `loaded_by = tbl_1205…` (FG out-mutations auto-created from DO lines) |
| `FORM - …` tables | UI forms with **no data** (0 rows, 8 cols) | 1286, 1246, 1282, 1287, 1299, 1346, 1397 |
| `deleted_at` | Soft delete; the API already hides deleted rows | API docs |
| Lookup targets not exposed | `tbl_1060_DBWarehouse` (wh_code) and `tbl_1123` (combo for sales/DO) are referenced but not in the API | lookup metadata |

### Snapshot tables: updated_at is NOT a change cursor
These tables are **truncated and reloaded daily** (every row has today's `created_at`/`updated_at`). Mirror them as a full refresh, never incrementally:
`1210` Live FG · `1212` Live RM · `1325` Live FG Gudang · `1326` Live RM Gudang (65k) · `1180` Mutasi RM · `1254` RM Stock Import · `1261` Report DO Exportable · `1332` Sales Invoice Import · `1373/1374/1375` ecommerce equivalents · `1260` Export Settings.

`1179` Mutasi FG is incremental but **bulk-touched**: 49k of 187k rows had `updated_at` bumped in the last 30 days. Use `created_at` / `mutasi_date` as its cursor.

---

## 2. Order-to-Cash: the tables that matter (verified)

```
1054 Customer ─┬─ 1055 Customer PIC (purchaser phones)
               ├─ 1207 Customer TOP Approval (term/limit requests)
               ▼
1202 SO header ── 1203 SO lines ──(so_no)── 1236 Request Produksi ──(request_id)── 1190 WO Production FG ── 1165 WO header
      │               │                                                                     │
      │               └──(so_item_no)── 1205 DO lines ──(sj_no)── 1082 DO header             └─ 1339 FG Waste
      │                                      │
      │                                      └── auto-creates ── 1179 Mutasi FG (Out, loaded_by=1205)
      └── 1082 DO header ──(daily rule)──► 1261 Report DO / 1332 Sales Invoice Import ──► Accurate (manual import)
```

### 1202 `SO - Sales Order N` (header): 75,212 rows, ~1,350 new/30d
- `po_no` = **SO number** (`SO.26/12821`); `po_date`; `status_order` ∈ {Done, Half Done, Wating[sic]}.
- `customer_name` → 1054 (bill-to). `customer_final` → 1054 is almost always the same as `customer_name` (2 of 2,636 differ). `customer_project` → 1054 filled on 16% (project owner).
- `buyer_name` → 1055 PIC (purchaser). **`penerima` + `kontak_penerima` ("Telepon")**: recipient name and phone.
- **`top_limit` ("Pembayaran")** = payment term *as of the SO*; **`top_limit_value`** = credit limit.
- **`approval_new` ("Approval")** = live header approval {Approved, Waiting}. The column named `approval` is **0% filled (dead)**.
- `sj_no_summary` = DO numbers (89%). `invoice_no_summary` = **0% (dead)**. `remarks` is free text; "LUNAS" (paid) appears on 7% of SOs, nearly all CBD.

### 1203 `SO - Sales Order Detail N` (lines): 142,206 rows
- `po_no` → header. Product: `brand`, `warna`, `th_alu_skin`, `total_thickness_acp`, `p`, `l`, `m2`. Qty: `qty_order`, `qty_delivered`, `qty_balance`. Price: `price`, `nominal`, `ppn_percentage`.
- **`approval` is labelled "Approval Finance"**: this is the Finance-approved button. Also `approval_team_leader` ("Approval Leader", mostly Waiting), `approval_manager` (always Waiting, unused), `auto_approval` (system check; Not Approved on about a third and overridden).
- `estimate_delivery` 100%. `summary_do` = DO numbers (86%).
- **Dead on lines:** `sj_no`, `invoice_no`, `qty_produksi`, `sn_fg`, `summary_spb`, `wh_code` (all 0%).

### 1082 `SO - Delivery Order` (DO / surat jalan header): 77,929 rows, ~1,400/30d
- `no_sj` (`KP/DO-13222/11/26`, `KP/DO-GB-…` for the second warehouse), `so_no`, `so_created_at`, `do_created_at`, **`sj_date` ("Do Date")**, `tanggal_spb` (= sj_date in 99.9%), `no_spb`.
- **`cara_kirim`** ∈ {di Antar 76%, di Ambil 24%}: delivery vs customer pickup. `cancel_order` (Yes 0.7%). `print_status` {Printed, Waiting}. `gudang` → 1322.
- **`top`, `top_days`, `due_date`**: due_date = sj_date + top_days in 99.2%. **`invoice_no`** (`KP/INV/2026-11-…`) is assigned at DO creation (100%).
- `pembeli` → 1055; `contact_person`, `bill_to`, `ship_to`, `invoice_c_name/email`.
- **Dead (0%):** `delivery_date`, `received_date`, `driver`, `no_kendaraan`, `pengambilan`, `latitude/longitude`, `freight_packing`, `send_email`.
- **Timing (60-day cross-tab, 2,809 DOs):** `sj_date` = `do_created_at` + 1 day in 90%, +2 in 9%. **The DO is created the day before dispatch, and `sj_date` is the scheduled delivery date.** 80% of SOs get their DO the next day; 97% of SOs have exactly 1 DO.

### 1205 `SO - Sales Order Delivery N` (DO lines): 143,029 rows
- One row per SO line per DO: `po_no`, `so_item_no` → 1203 id, `sj_no` → 1082 id, `do_text`, `sj_date`, `sn_fg` → 1172 (the actual serial shipped), `batch_warna`, `qty_delivered`, `item_details`.
- `loaded_by` = "Auto Insert". It drives 1179 Out mutations. `delivery_date` and `received_date` are 0% here too.

### 1236 `DB - Request Produksi`: 9,064 rows, ~240/30d
- `so_ms` ∈ {SO 60%, MS 35% (make-to-stock), O 4%, TRIAL}. **`so_no` is filled on 97% of SO-type requests.**
- `no_request` → 1280 batch (REQNO…); `wo_no` (WO.26/000xx) 100%; `tanggal_request`; `qty_lembar`, `qty_so`, `qty_delivered_so`; `catatan_untuk_so`.
- **Dead:** `approval_factory_manager` and `status_request` are always "Waiting" (never maintained). `po_no` 0%.

### 1190 `WO - Production FG` (production output per request line): 9,678 rows
- `request_id` → 1236 id (99% of SO requests link). `wo_no`, `no_so` (42%), `so_ms`.
- **`status_automatic`** {Done, Waiting}; **`production_date`** is filled when Done. `planning_qty`, `actual_qty`, `m2_actual`, `approval_gudang` {Approved, Waiting}.
- Raw-material consumption (BOM-like): `alu_top/bottom` → 1178 with `conv_*`, `polymer`, `antifoam`, `core_pe`, `protective_film`, `pe_type`.

### 1165 `WO - Work Order` (header): 341 rows, **now in active use** (WO.26/00036–42 in Oct–Nov)
- `WO_no`, `production_date`, approvals (`approval_ppic/qc/produksi/factory_manager`), `wo_status` (Waiting 299 / Done 1: not closed in practice).

### Production share and lags (SOs since 11 Sep, requests since 1 Aug)
- **Only ~4% of SOs (109 of 2,636) go through production.** The rest ship from stock.
- SO → request: 44% same day, 92% within a week.
- Request → `production_date`: 1–7 days.
- Production → DO: 0–2 days typically.

### 1054 `DB - List Customer`: 15,502 rows
- `customer_name` ("Perusahaan"), `badan_usaha` (PT/CV/Toko/Perorangan/Aplikator/UD/Owner), `customer_business`, address with province/kabupaten/kecamatan IDs, `phone_number`, `nik`, `npwp`, `email`.
- **`top_days`, `top_value`** (the customer's standing terms), `sales_name` → 1130, `specifier_name`, `most_buy` (brand), `duplicate_detection`.

### 1055 `DB - Customer PIC`: 14,982 rows
- `customer_name` → 1054, `pic_customer`, `position` (Owner…), `phone_number` ("Telepon/HP"), `email`, `ktp`, `sales_name`.

### 1207 `DB - Customer TOP Approval`: 9,709 rows, ~120/30d
- A workflow of term/limit requests: `request_date`, `customer_name`, `top_days` ("Pembayaran", same vocabulary as SO `top_limit`), `top_value` (limit), `team_leader_approval`, `sales_manager_approval`, **`finance_approval`**. `current_top_*` is 0% (dead).

### 1332 `SO - Sales Invoice Import` / 1261 `SO - Report DO Exportable`: daily snapshots
- Built every morning by a rule from **yesterday's DOs**, in **Accurate's sales-invoice import format**: invoice number, invoice date, due date, `shipvia`, product, qty, unit price, `paid`.
- **Direction is Selaras → Accurate.** `paid` is always "No". These tables **do not** contain payment status.

### 1130 `CRM - List Sales`: 86 reps
- `sales_name`, `department`/`access_group` (Sales Retail / Sales Project), `position`, `active` (60 active), `user` → users. **No phone column**: rep WhatsApp numbers must come from LeadScout's registry.

---

## 3. Payment terms in the wild (SO `top_limit`, 2,636 SOs, 11 Sep – 10 Nov 2026)

| Normalized term | SOs | Share | Raw variants |
|---|---|---|---|
| **CBD** | 1,747 | 66% | "Cash before Delivery", "Cash Before Delivery" |
| **COD** | 336 | 13% | "Cash on Delivery", "Cash On Delivery" |
| **Tempo 30** | 517 | 20% | "Tempo 30 Hari" / "hari", "- Transfer", "- Giro" |
| Tempo 14 / 21 / 45 / 60 | 23 | 1% | incl. "- Transfer" |
| DP 50% | 4 | | |
| Konsinyasi | 7 | | |

- CBD and COD are **different terms**, both in use. Normalize with: lowercase, strip; then `cash before` → CBD, `cash on` → COD, `tempo (\d+)` → Tempo N (+ method Transfer/Giro), `dp` → DP, `konsinyasi` → Konsinyasi.
- **Approval is unreliable as a payment signal:** 164 CBD SOs reached Done/shipped with header approval still "Waiting".

---

## 4. Recipient phone quality (`1202.kontak_penerima`, same 2,636 SOs)

| Shape | SOs | Share | Handling |
|---|---|---|---|
| Single clean mobile (08…/62…) | 2,222 | 84% | Normalize to E.164 |
| Two numbers joined by "/" or "&" | ~120 | ~5% | Split; use the first mobile, keep the second as fallback |
| Empty | 271 | 10% | Fall back to 1055 PIC via `buyer_name`, then 1054 |
| Landline / text / "-" | ~20 | <1% | Unreachable; flag |

- 1,006 distinct numbers across 2,636 SOs; 98 numbers had ≥ 5 SOs in 60 days, so batching per phone matters.
- **Shared-number guard:** 7 numbers receive SOs for ≥ 3 different customers (up to 9 customers on one number, across many reps). These are likely a forwarder/ekspedisi or internal staff. Hold them for review; don't auto-send.

---

## 5. Full domain map (all 165 tables)

Status key: **A** = active (updated in last 30d) · **S** = daily snapshot/rebuild · **D** = dormant (no update > 1 yr) · **E** = empty · **F** = form shell (no data) · **L** = legacy copy.

**Party & terms.** 1054 Customer **A** · 1055 Customer PIC **A** · 1207 Customer TOP Approval **A** · 1380 Customer History D · 1200 Customer Business (lookup) D · 1206 Badan Usaha (lookup) D · 1229 Provinsi D · 1201 Customer Province (API error) · 1354/1358 Customer Export D · 1275 DSB Customer D

**Sales / CRM.** 1130 List Sales **A** · 1309 Sales Target (60 rows, set May 2026) · 1217 CRM Project **A** · 1218 CRM Project Detail **A** · 1239 Project Item Detail D · 1230/1231/1232/1233 CRM enums D · 1216 Laporan Sales (34,867; last update Apr 2026) · 1219 Kondisi Lapangan D · 1274 DSB Project D · 1378/1387/1388/1389 EXP CRM Project D · 1246 FORM Laporan Sales F

**Order.** 1202 SO header **A** · 1203 SO lines **A** · 1359 SO Detail Deleted (audit of deleted lines, to 2024-12) · 1272 SO Detail MA L (frozen 2023-10) · 1208 SO Detail FU D · 1281 Form SO Update D · 1286 FORM SO Approval F · 1330/1331 Booking FG/RM E · 1238/1244 Booking Stock FG/RM D/E · 1081 SO Invoice D (1 stub) · 1255 SO Report Retail D (2023 snapshot) · 1256 Report Retail Exportable D · 1260 Export Settings S

**Ecommerce channel.** 1368 SO Ecommerce **A** (marketplace TOKOPEDIA/SHOPEE, `no_pesanan`) · 1369 SO Detail Ecommerce **A** · 1371 DO Ecommerce **A** · 1370 SO Delivery Ecommerce **A** · 1372 Marketplace list D · 1373/1374/1375 invoice/report/settings S · 1392 EXP DO Head Ecommerce **A**

**Fulfilment.** 1082 DO header **A** · 1205 DO lines **A** · 1261 Report DO Exportable S · 1332 Sales Invoice Import (→Accurate) S · 1307/1308 DO Delivery (+Detail) D (≤2 rows; abandoned design) · 1338 DO Daily D · 1277 DSB DO D (2021) · 1235 SPB D (3 rows) · 1327 Retur Approval D · 1312/1335/1349 EXP DO/Delivery D

**Production.** 1236 Request Produksi **A** · 1280 Summary Request Produksi (REQNO batches) **A** · 1390 Request Produksi Report D · 1165 Work Order **A** · 1190 WO Production FG **A** · 1171 WO Production RM **A** · 1339 WO Production FG Waste **A** · 1209 Production RM Waste D · 1320 WO Estimasi D · 1341 WO Summary D · 1168 Formula Conversion · 1170 Jam Conversion · 1169 Jumlah Jam E · 1191 Report Jam WO E · 1287 FORM WO Approval F

**Inventory.** 1210 Live FG S · 1325 Live FG Gudang S · 1212 Live RM S · 1326 Live RM Gudang S · 1179 Mutasi FG **A** (bulk-touched) · 1180 Mutasi RM S · 1328 Transfer Stock FG **A** · 1334 Transfer Summary FG **A** · 1329 Transfer RM E · 1324 Stock Opname FG (131,742; last Aug 2026) · 1336/1340 Opname Pemutihan FG/RM **A**(RM) · 1323 Opname RM E · 1242/1243 ST Stock Opname FG/RM D (2020) · 1301/1302 Live FG/RM Diff D · 1211/1213 Live Buffer D · 1265/1269/1271/1270/1283/1284 Level Stock Min (+settings) D (2020) · 1278/1279 Stock Notification (+Log) D (2020, unused) · 1240 QC FG **A** · 1241 QC RM · 1253 FG Stock Import D · 1254 RM Stock Import S · 1350/1351 Transfer Stock Export D · 1337 FORM Transfer Stock F · 1397 FORM Cek Stok FG F

**Procurement (AP).** 1252 PO List **A** · 1084 PO Item **A** · 1196 Incoming Material **A** · 1264 Request Pembelian **A** · 1262 Request Pembelian Detail **A** · 1263 Kode dan Nama Barang D · 1251 Supplier list · 1177 RM Supplier/Brand D · 1053 Supplier PIC D · 1086/1087 PO delivery/invoice D · 1316/1317 EXP PO D

**Product master.** 1172 Finished Goods (SN FG master, 9,094) **A** · 1178 Raw Material **A** · 1228 Warna **A** · 1194 FG Brand · 1173 Combo (generic enum table) · 1303 TH Alu Sales Master · 1161 TH→m² · 1076 Pack · 1174 Protective Film · 1175 FG Category E · 1176 RM Category · 1225 Thickness · 1204 FG Warna (deprecated "xxx") · 1276/1306 Checkers D · 1360 Auto Approval FG V2 D · 1361 Min Price Bekasi D

**Warehouse / QR / tracing.** 1322 List Gudang (15) · 1288/1296 QR gudang/positions D · 1291/1292/1293/1295/1297/1298 QR stock D (2020 pilot) · 1299 Form QR FG F · 1310/1311 Lacak D

**Export / admin.** 1318 EXP Manager · 1313/1314/1321 EXP SO/Invoice D · 1394 Export Manager V2 E · 1282/1346 forms F · 1395 Dashboard Top E

**Bottom line:** of 165 tables, about **35 carry live business data**. The order-to-cash spine is **1054 → 1202/1203 → (1236 → 1190) → 1082/1205 → 1179**, plus the daily Accurate export (1332). The rest are lookups, daily snapshots, exports, form shells or 2020 pilots.
