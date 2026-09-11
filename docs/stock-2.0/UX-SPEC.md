# Stock 2.0 — UX SPECIFICATION

| | |
|---|---|
| **Status** | v1.0 — binding for WP-5 (`/stock`) and WP-6 (`/stock-ppic`) |
| **Owner** | UI/UX |
| **Date** | 2026-09-11 |
| **Subordinate to** | `CONTRACTS.md` (FROZEN). Where this document and the Blueprint disagree, the Blueprint wins and this document is wrong — raise it, do not diverge. |
| **Reads with** | `HANDOVER.md` §4 (WP-5, WP-6), `PRD.md` §5A/§6/§10 |

> **Two developers build from this document in parallel and cannot see each
> other's work.** Everything that must match between the two pages — tokens,
> copy, number formatting, state names, banner precedence, pager behaviour — is
> specified here literally, not described. Copy the strings. Do not translate
> afresh; a second translation of the same concept is a bug.

---

## 0. Reading order and the five rules

1. **The inherited CSS block is the design system.** You may *add* declarations.
   You may not change or delete an inherited one. (`CONTRACTS §6`.)
2. **`state` is computed server-side** (`CONTRACTS §4.1`). The front end renders
   `item.state`. It never derives a state from `atp`/`on_hand`. If the four
   numbers and the state ever disagree, render the state and the numbers exactly
   as received — do not "fix" it.
3. **Negative ATP is content, not an error.** Never clamp, never hide behind a
   toggle, never render as `0`, never wrap in parentheses. (`CONTRACTS §7.5`.)
4. **Every string a user can see is in this document, in Bahasa Indonesia.**
   If you need a string that is not here, you have found a gap — raise it.
5. **No raw hex outside §1.** Every colour you write is `var(--something)`.

---

## 1. Tokens

### 1.1 Inherited — carried forward verbatim, byte for byte

Copy this `:root` block into both pages unchanged. It is identical in today's
`stock.html` and `stock-ppic.html`; keeping it identical is what makes the two
pages look like one product.

```css
:root{
  --bg:#f2f4f7; --card:#fff; --ink:#17233b; --muted:#6b7280; --line:#e5e7eb;
  --accent:#157a46; --danger:#c03c2b;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
```

| Token | Value | Role — unchanged in 2.0 |
|---|---|---|
| `--bg` | `#f2f4f7` | Page ground. Never a text background for `--muted`. See §9.2. |
| `--card` | `#fff` | Card / table / modal surface. |
| `--ink` | `#17233b` | Primary text, sticky header ground, toast ground. |
| `--muted` | `#6b7280` | Labels, captions, table `th`. **Borderline — see §9.2.** |
| `--line` | `#e5e7eb` | 1px borders, table rules, card edges. |
| `--accent` | `#157a46` | Primary action ground, links inside `.empty`. |
| `--danger` | `#c03c2b` | Destructive action ink, **negative ATP**, error toast ground. |
| `--sans` | system stack | Only typeface. No webfont, ever (no build step, field 3G). |

Inherited classes that carry forward **with their existing declarations**:

| Class / id | Keep for |
|---|---|
| `.card`, `.card h2`, `.card .body` | Every panel on both pages. |
| `table`, `th`, `td`, `tr.itemrow`, `.sub2`, `.scrollx` | Every list. |
| `.chip` (base pill geometry) | Base for all new state chips. |
| `.chip.age` | **Archive surfaces only.** Fails AA — see §9.2. New surfaces use `.chip.umur` (§1.3). |
| `.btn`, `.btn.ghost`, `.btn.danger`, `.btn:disabled`, `.mini` | All buttons. |
| `.modal-bg`, `.modal-bg.on`, `.modal`, `.modal h3`, `.modal .mp`, `.modal .actions` | The bottom-sheet modal system. |
| `#toast`, `.toast`, `.toast.ok/.warn/.err`, `@keyframes tin` | Notifications. |
| `.empty`, `.empty a` | Every empty state. |
| `.banner`, `.banner button` | The stale banner (§4.2) — the only banner in 2.0. |
| `.warnbox`, `.warnbox.amber` (PPIC) | Inline error / caution boxes. |
| `.fltchips`, `.fchip`, `.fchip.on` (PPIC) | Filter chip rows on both pages. |
| `.countchip`, `.counts` (PPIC) | Totals strip. |
| `.spin`, `@keyframes sp` | In-flight buttons. |
| `.avail`, `.avail.neg`, `.m2`, `.sisa`, `.foot`, `.metaline`, `.rev` | Numbers, footnotes, struck-through rows. |
| `.st-confirmed`, `.st-overbooked`, `.st-approved`, `.st-rejected`, `.st-cancelled`, `.st-completed`, `.st-outstanding` | Keep the CSS (`§6` says verbatim). **No element in 2.0 may carry them** — they name booking statuses that no longer exist. Unused CSS is fine; a vestigial class on a live element is not. |
| `.badge`, `.chip.lama`, `button.btn.approve` | **Delete.** They exist only to render removed features. See §10. |

### 1.2 Added tokens — additive only, with justification

Append this block **after** the inherited `:root` (a second `:root{}` rule is
fine and keeps the diff obvious):

```css
:root{
  /* Stock 2.0 additions — see UX-SPEC §1.2. Additive only. */
  --ink-2:#475569;            /* secondary numerals; --muted is too weak here */
  --ok-bg:#dcfce7;   --ok-ink:#15803d;
  --warn-bg:#fef3c7; --warn-ink:#b45309; --warn-line:#fde68a; --warn-ink-strong:#7a4f08;
  --neg-bg:#fee2e2;  --neg-ink:#b91c1c;
  --neutral-bg:#f3f4f6; --neutral-ink:#4b5563;
  --offline-bg:#eef1f6; --offline-ink:#334155; --offline-line:#cbd5e1;
  --age-old-bg:#ffedd5;     --age-old-ink:#9a3412;
  --age-ancient-bg:#fee2e2; --age-ancient-ink:#b91c1c;
  --focus:#1d4ed8;
  --tap:44px;
}
```

| Token | Why it must exist |
|---|---|
| `--ink-2` | The ATP row carries three secondary numerals (fisik / dipesan / pesanan lama). At 11px on `--card`, `--muted` measures 4.83:1 and on `--bg` only 4.39:1 — it fails. `--ink-2` measures 7.58:1 / 6.88:1 and still reads clearly *below* `--ink`, which is what the hierarchy in §2 needs. |
| `--ok-*`, `--warn-*`, `--neg-*`, `--neutral-*` | The four ST-R10 states need semantic chips. The hex pairs are **hoisted unchanged** from `.st-confirmed` / `.st-overbooked` / `.st-rejected` / `.chip.age` so the palette does not grow — except `--neutral-ink`, which is darkened from `#6b7280` to `#4b5563` because the inherited grey-on-grey pill fails AA (4.39:1 → 6.87:1). The inherited `.chip.age` rule is untouched; the new value lives in a new class. |
| `--warn-line`, `--warn-ink-strong` | Hoisted from the inherited `.banner` rule (`#fde68a` border, `#7a4f08` text) so the stale banner and the `habis` chip provably share one amber. |
| `--offline-*` | "ERP tidak terhubung" **must not look like** "data is stale" (§4). Amber says *caution, data may be old*; slate says *this feature is switched off*. A third colour family is the cheapest way to make that unmistakable at a glance. 9.15:1. |
| `--age-old-*`, `--age-ancient-*` | The stale queue's whole point is that ETAs run back to 2020. Age needs three visual tiers, not one grey pill. Hoisted from `.st-outstanding` and `.st-rejected`. |
| `--focus` | The inherited CSS defines **no** `:focus-visible` style, so keyboard focus is currently the browser default and invisible on dark header chrome. Required by §9.3. |
| `--tap` | `44px`. The inherited inputs already honour it; `.btn` (40px) and `.mini` (34px) do not. Needed as a token so both pages spell the row-action minimum the same way. |

**Nothing else may be added.** If you need a colour that is not above, you are
inventing a state that this spec did not design — raise it.

### 1.3 New classes (defined only from tokens)

```css
/* ── ST-R10 state chips ───────────────────────────────────────────────────── */
.st-tersedia      {background:var(--ok-bg);      color:var(--ok-ink)}
.st-habis         {background:var(--warn-bg);    color:var(--warn-ink)}
.st-kosong        {background:var(--neutral-bg); color:var(--neutral-ink)}
.st-perlu-produksi{background:var(--neg-bg);     color:var(--neg-ink)}

/* ── age pill, three tiers (§6.5) ─────────────────────────────────────────── */
.chip.umur        {background:var(--neutral-bg); color:var(--neutral-ink)}
.chip.umur.old    {background:var(--age-old-bg); color:var(--age-old-ink)}
.chip.umur.ancient{background:var(--age-ancient-bg); color:var(--age-ancient-ink)}

/* ── the headline number (§2) ─────────────────────────────────────────────── */
.atp      {font-size:22px;font-weight:800;line-height:1.05;white-space:nowrap;
           font-variant-numeric:tabular-nums;color:var(--ink)}
.atp.neg  {color:var(--danger)}
.atp .un  {font-size:12px;font-weight:700;color:var(--ink-2);margin-left:4px}
.atp-m2   {font-size:11px;color:var(--muted);font-weight:500;margin-top:1px}
.atp-sub  {font-size:11px;color:var(--ink-2);margin-top:3px;
           font-variant-numeric:tabular-nums;line-height:1.35}
.atp-note {font-size:11px;color:var(--ink-2);margin-top:3px;line-height:1.35}

/* ── the offline (ERP not configured) box — deliberately NOT amber ────────── */
.offbox{background:var(--offline-bg);border:1px solid var(--offline-line);
        color:var(--offline-ink);border-radius:12px;padding:12px 14px;
        font-size:13px;line-height:1.45;display:flex;gap:10px;
        align-items:flex-start;margin-bottom:12px}

/* ── tabs (PPIC) ──────────────────────────────────────────────────────────── */
.tabs{display:flex;gap:6px;overflow-x:auto;scroll-snap-type:x proximity;
      -webkit-overflow-scrolling:touch;margin-bottom:12px;padding-bottom:2px}
.tabs::-webkit-scrollbar{display:none}
.tab{scroll-snap-align:start;flex:0 0 auto;border:1px solid var(--line);
     background:var(--card);color:var(--ink-2);border-radius:999px;
     padding:0 14px;min-height:var(--tap);font:inherit;font-size:13px;
     font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.tab[aria-selected="true"]{background:var(--ink);color:var(--card);border-color:var(--ink)}
.tab .n{font-size:11px;font-weight:800;opacity:.85}

/* ── pager (§6.4) ─────────────────────────────────────────────────────────── */
.pager{display:flex;gap:8px;align-items:center;justify-content:space-between;
       padding:10px 14px;border-top:1px solid var(--line);font-size:12px;
       color:var(--ink-2);flex-wrap:wrap}

/* ── skeleton (§7.1) ──────────────────────────────────────────────────────── */
.sk{background:var(--line);border-radius:6px;height:12px;animation:skp 1.1s ease-in-out infinite}
.sk.lg{height:20px}
@keyframes skp{0%,100%{opacity:.55}50%{opacity:1}}

/* ── poll delta flash (§9.4) ──────────────────────────────────────────────── */
@keyframes flup{from{background:var(--ok-bg)}to{background:transparent}}
@keyframes fldn{from{background:var(--neg-bg)}to{background:transparent}}
.f-up{animation:flup 1.2s ease-out}
.f-dn{animation:fldn 1.2s ease-out}

/* ── a11y (§9) ────────────────────────────────────────────────────────────── */
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;
         overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:6px}
header :focus-visible{outline-color:var(--card)}
.btn.tap{min-height:var(--tap)}
.mini.tap{min-height:var(--tap);padding:0 12px}
```

The existing `@media(prefers-reduced-motion:reduce){*{animation:none!important;
transition:none!important}}` rule is inherited and already neutralises `.sk`,
`.f-up`, `.f-dn` and `.spin`. Do not add a second one.

### 1.4 Number, date and duration formatting — identical on both pages

```js
const NF  = new Intl.NumberFormat("id-ID",{maximumFractionDigits:2});   // inherited
const num = n => NF.format(Number(n)||0).replace("-","−");          // U+2212 MINUS
```

| Thing | Rule | Example |
|---|---|---|
| Any quantity | `num()`. Indonesian grouping (`.`), decimal `,`. | `3.849`, `22.921,1` |
| A negative quantity | Real minus sign `−` (U+2212), never `-`, never `(…)`. The hyphen is 4px tall at 22px/800 and reps miss it. | `−1.230` |
| Unit | Always printed, always from `item.unit`. Never hard-code `lembar`. | `3.849 lembar` |
| m² | `≈ 22.921,1 m²` — always prefixed `≈`, always `.atp-m2`. | |
| Timestamp | inherited `wib()` — WIB, 24h. | `11 Sep 14:05` |
| Time only | inherited `wib(iso,false)`. | `14:05` |
| Date only (ETA, `po_date`) | inherited `wibShort()`. Append the year when the date is **not** in the current calendar year — a 2020 ETA reading "27 Agu" is the single most misleading thing on the stale screen. | `20 Sep` · `27 Agu 2020` |
| Age / duration | inherited `dur(sec)` → `2h 3j`. In the stale queue use **whole days**: `1.841 hari`. | |
| Relative freshness | `baru saja` (<60s) · `N mnt lalu` (<60m) · `N jam lalu` (<24h) · `wib()` beyond. | |

`wibShort()` must be extended to take the year; that is the only inherited
helper this spec changes, and it is an extension (optional argument), not a
rewrite.

### 1.5 Glossary — the Bahasa word for every domain term

**Both developers use these words and no others.** A synonym introduced on one
page is a defect on both.

| Contract field / concept | UI word (Bahasa) | Never write |
|---|---|---|
| `atp` | **Bisa Dijual** | "ATP", "Available", "Tersedia" (that is the *state*) |
| `on_hand` | **Stok Fisik** | "Stok", "Saldo", "Qty" |
| `committed` (live) | **Sudah Dipesan** | "Booking", "Terpakai" |
| `stale_committed` | **Pesanan Lama** | "Stale", "Basi", "Phantom" |
| `adjustment` | **Penyesuaian** | "Adjust", "Koreksi" |
| shortfall / deficit | **Kekurangan** | "Minus", "Shortage" |
| exceptions (ST-R5.3) | **Belum Cocok** | "Error", "Gagal", "Tidak valid" |
| `sku_key` | **Kode SKU** | "Key", "ID" |
| `kode_barang` | **Kode Barang** | "Brand", "Part no" |
| `warna` | **Warna** | |
| `qty_balance` | **Sisa Pesanan** | "Balance" |
| `status_order` | **Status SO** | |
| `estimate_delivery` | **ETA** (kept — universally used in the plant) | "Tanggal kirim" |
| `nearest_eta` | **ETA Terdekat** | |
| age of a stale line | **Umur** | "Usia", "Lama" |
| sync | **Sinkronisasi** / verb **Sinkron** | "Update", "Refresh" |
| `freshness.last_ok_at` | **Data ERP per …** | |
| confirm-close (ST-R21) | **Tutup** / result chip **Ditutup** | "Hapus", "Batal", "Reject" |
| reinstate (ST-R21) | **Aktifkan Lagi** | "Undo", "Restore" |
| PPIC operator | **Petugas PPIC** | |
| `actor` | **Petugas** | "User" |
| unit | from `item.unit`, normally **lembar** | |

---

## 2. The ATP number

> A rep is standing in a customer's showroom holding a phone in one hand. The
> question is *"berapa yang bisa saya jual?"*. The answer must be readable
> without stopping to parse a table.

### 2.1 Hierarchy

Exactly one number per row is large. Everything else is ≤12px.

| Rank | Element | Class | Size / weight | Ink |
|---|---|---|---|---|
| 1 | **Bisa Dijual** (`atp`) | `.atp` | 22px / 800, `tabular-nums` | `--ink`, or `--danger` when `atp < 0` |
| 1b | unit | `.atp .un` | 12px / 700 | `--ink-2` |
| 2 | state chip | `.chip.st-*` | 11px / 700 | per §3 |
| 3 | product name | `td.warna b` (inherited) | 14px / 700 | `--ink` |
| 4 | m² equivalent | `.atp-m2` | 11px / 500 | `--muted` |
| 5 | secondary numerals | `.atp-sub` | 11px / 400 | `--ink-2` |
| 6 | spec line | `.sub2` (inherited) | 11px | `--muted` |

22px against a 14px product name is a 1.57 ratio — enough that the eye lands on
the number first at arm's length, small enough that a five-digit quantity plus
unit still fits one line at 380px (`3.849 lembar` ≈ 118px at 22px/800).

### 2.2 Markup — identical on both pages

```html
<div class="atp" aria-label="Bisa dijual 3.849 lembar">3.849<span class="un">lembar</span></div>
<div class="atp-m2">≈ 22.921,1 m²</div>
<div class="atp-sub">Fisik 4.168 · Dipesan 319</div>
```

- `.atp-sub` is **one line**, separated by ` · `, in this fixed order:
  `Fisik {on_hand} · Dipesan {committed}` then, only when non-zero,
  ` · Penyesuaian {+/−adjustment}`.
- `stale_committed` is **not** in `.atp-sub`. It goes on its own line below, as a
  pill, because it is the one number that is deliberately *excluded* from the
  arithmetic above it and must not read as part of the sum:
  ```html
  <div class="atp-note"><span class="chip umur">Pesanan lama 1.810 — tidak dihitung</span></div>
  ```
  Render this line only when `stale_committed > 0`. On `/stock` (sales) it is
  informational; on `/stock-ppic` it is a link into the Tinjau Pesanan tab
  (`#lama:stale?sku=…`) pre-filtered to this SKU.
- Right-aligned in the desktop table cell; in the ≤559px card layout it sits in
  the right column of a two-column flex row, `align-items:flex-start`.

### 2.3 Negative ATP — `perlu_produksi`

This is the most valuable row on the page. It is styled *up*, not down.

- `.atp.neg` → `--danger` ink. Contrast 5.35:1 on `--card`; at 22px/800 it is
  "large text" under WCAG, which needs 3:1. Comfortable.
- Leading `−` (U+2212). `−1.230 lembar`.
- Chip `.st-perlu-produksi` reading **Perlu Produksi**.
- Row note, always: `Kekurangan 1.230 lembar.` — the deficit restated as a
  positive number, because "how many do I need to make" is the question PPIC
  actually asks and subtracting a minus in your head is an error source.
- **Prohibited:** `Math.max(0, atp)`, `Math.abs(atp)` in the headline,
  `atp || 0`, hiding the row behind any filter default, red row backgrounds
  (they make a 4,000-row list unreadable), and `display:none` on negative rows
  under any toggle. The "Sembunyikan yang kosong" toggle (§5.1) explicitly never
  hides them — this mirrors the inherited rule that the zero toggle never hid
  overbooked rows.

### 2.4 Zero

`atp === 0` renders `0`, ink `--ink` (not `--danger`), with the `habis` or
`kosong` chip carrying the meaning. Zero is not an error and never turns red.

---

## 3. The four states (ST-R10)

Derived server-side, in this order, per `CONTRACTS §4.1`. The front end reads
`item.state` and nothing else.

| `state` | Chip label | Chip class | Contrast | One-line explanation (verbatim) | Rep action |
|---|---|---|---|---|---|
| `tersedia` | **Tersedia** | `.chip.st-tersedia` | 4.57:1 | `Masih bisa dijual sekarang.` | Row tap → detail. No other action. |
| `habis` | **Habis (Semua Dipesan)** | `.chip.st-habis` | 4.51:1 | `Stok fisik ada, tapi seluruhnya sudah dipesan Sales Order lain.` | Row tap → detail. Note line shows `ETA terdekat {date}` when `nearest_eta` is present. |
| `kosong` | **Kosong** | `.chip.st-kosong` | 6.87:1 | `Tidak ada stok fisik di gudang.` | Row tap → detail. |
| `perlu_produksi` | **Perlu Produksi** | `.chip.st-perlu-produksi` | 5.30:1 | `Pesanan melebihi stok. Kekurangan {n} {unit}.` | Row tap → detail. PPIC only: the row also appears in the Kekurangan tab. |

Chip label wrapping: at 380px, `Habis (Semua Dipesan)` is 19 characters and
would push the chip onto two lines in the desktop table cell. Rule: the chip
renders the **short label** in table rows and the **long label** in the card
layout and detail sheet.

| `state` | Short (table cell) | Long (card ≤559px, detail sheet) |
|---|---|---|
| `tersedia` | `Tersedia` | `Tersedia` |
| `habis` | `Habis` | `Habis (Semua Dipesan)` |
| `kosong` | `Kosong` | `Kosong` |
| `perlu_produksi` | `Perlu Produksi` | `Perlu Produksi` |

**`habis` vs `kosong` is the distinction the whole module exists to make.**
They must never share a colour, a label, or a sort position. `habis` is amber
because there is something to talk about (physical stock exists; a delivery date
may free it). `kosong` is grey because there is nothing to talk about.

The explanation line renders:
- **always** in the detail sheet, under the numbers;
- **on the row** only for `habis` and `perlu_produksi` (the two counter-intuitive
  states), in `.atp-note`;
- never for `tersedia` (noise) or `kosong` in a table row (the chip says it).

State is never signalled by colour alone: every chip carries its word, and the
negative number carries its minus sign. (§9.5.)

---

## 4. Freshness, staleness, disconnection — three conditions, three looks

These are mutually exclusive in the UI. **Precedence, highest first:**

1. `freshness.erp_connected === false` → **offline box** (§4.3). Suppresses 2.
2. `freshness.stale === true` → **amber banner** (§4.2).
3. otherwise → **freshness line only** (§4.1).

Never render two at once. The header freshness line (§4.1) renders in all three
cases, with different text.

### 4.1 The freshness line — always visible

Lives in the inherited `header .sub` (`#dataPer`), 12px on `--ink`
(`#c7cfde` on `#17233b` = 10.01:1). It is the only thing in the header that
changes, so it is also the element that tells a rep the page is alive.

| Condition | Copy |
|---|---|
| `last_ok_at` present, fresh | `Data ERP per 14:05 · 2 mnt lalu` |
| `last_ok_at` present, <60s old | `Data ERP per 14:05 · baru saja` |
| `last_ok_at` present, >24h old | `Data ERP per 10 Sep 14:05` |
| `last_ok_at` null, `erp_connected` true | `Menunggu sinkronisasi pertama…` |
| `erp_connected` false | `ERP tidak terhubung` |
| initial page load, before first response | `Memuat…` (inherited) |
| summary fetch failed, previous data still on screen | `Data ERP per 14:05 · gagal memuat ulang` |

The relative half re-renders on a 30s client tick without refetching — reuse the
inherited `.chip.age[data-age]` tick pattern.

### 4.2 Stale banner — sync has not succeeded in N intervals

Condition: `freshness.stale === true` (server decides, from
`STOCK_SYNC_STALE_ALERT_INTERVALS`, default 4 × 3 min = 12 min). The front end
**does not** compute staleness from `last_ok_at`.

Uses the inherited `.banner` (amber, `--warn-bg` ground, `--warn-line` border,
`--warn-ink-strong` text, 6.39:1). Placed as the first child of `.wrap`, above
the toolbar, above the totals strip.

```html
<div class="banner" id="staleBanner" role="status">
  <span aria-hidden="true">⚠️</span>
  <span>Data ERP belum diperbarui sejak <b>11:42</b>. Angka di bawah mungkin
        sudah tidak akurat — konfirmasi ke PPIC sebelum menjanjikan stok.</span>
</div>
```

- **Not dismissible on `/stock`.** The inherited `.banner button` close affordance
  is removed here: a rep who dismissed it would quote a stale number an hour
  later. (The old advisory banner with `stk_banner_x` is deleted entirely — §10.)
- On `/stock-ppic` the banner gains one action, right-aligned, replacing the `×`:
  `<button class="btn mini tap ghost" id="syncNow">Sinkron sekarang</button>` →
  `POST /api/stock/sync`. Sales gets no button; sales cannot fix this and a
  button that does nothing visible is worse than no button. Sales copy ends with
  `— konfirmasi ke PPIC`, PPIC copy ends with `— jalankan sinkronisasi ulang.`
- The banner disappears on its own when a later poll returns `stale: false`.
  Announce that once, politely: `Data ERP sudah diperbarui.` (§9.4.)

### 4.3 ERP not connected — a different thing entirely

Condition: `freshness.erp_connected === false` (i.e. `SELARAS_BASE_URL` unset;
`CONTRACTS §3`). This is not a fault the user can wait out — it is a deployment
state. It is slate, not amber, and it replaces the list rather than warning
above it.

```html
<div class="offbox" role="status">
  <span aria-hidden="true">🔌</span>
  <div>
    <b>ERP tidak terhubung.</b><br>
    Integrasi ke sistem ERP belum diaktifkan, jadi angka stok belum bisa
    ditampilkan. Hubungi tim IT untuk mengaktifkan.
  </div>
</div>
```

Then, in place of the item list:

```html
<div class="card"><div class="empty">
  Data stok belum tersedia.<br>Halaman ini akan terisi otomatis setelah ERP terhubung.
</div></div>
```

- Toolbar/filters: **rendered but disabled** (`disabled` attribute, not hidden) —
  hiding them makes the page look broken; disabling them makes it look switched
  off. On `/stock-ppic` every write control (`Tutup`, `Aktifkan Lagi`,
  `Simpan Penyesuaian`, `Sinkron sekarang`) is `disabled` with
  `title="ERP tidak terhubung"`.
- **Exception:** if `erp_connected === false` but `items.length > 0` (a mirror
  populated before the URL was unset), render the items *and* the offline box,
  and change the box's second sentence to:
  `Angka di bawah adalah data terakhir sebelum koneksi dimatikan dan tidak lagi diperbarui.`
  Write controls stay disabled.
- Never show the amber stale banner in this state. "Belum disinkronkan" and
  "tidak ada yang menyinkronkan" are different sentences and users act on them
  differently.

---

## 5. `/stock` — the sales page (WP-5)

**Audience:** field sales rep, Android phone, 380px, patchy connection.
**Everything on this page is read-only.** There is no control that writes.

### 5.0 Page frame

```
<title>Stok — Bisa Dijual</title>
header (inherited, sticky)
  h1        "Stok"
  .sub      #dataPer → §4.1
  a.pplink  "PPIC ↗" → /stock-ppic     (unchanged; role-gated server-side)
.wrap (max-width 960)
  [banner §4.2 | offbox §4.3]
  .counts  → totals strip
  .toolbar → §5.1
  .card    → item list
```

Totals strip, from `summary.totals`, rendered as inherited `.countchip`s, in
this order, omitting any whose value is 0 except the first:

```
812 SKU · 640 Tersedia · 120 Habis · 40 Kosong · 12 Perlu Produksi
```

`stale_commitments` and `exceptions` are **not** shown to sales — they are PPIC
hygiene numbers and would read as "something is broken" to a rep.

### 5.1 Toolbar — ported from 1.0, not redesigned

The 1.0 toolbar works and reps have learned it. Port the structure, the ids, the
persistence and the layout rule (`.toolbar select{flex:1 1 46%}` so selects pair
up at 380px) **verbatim**. Only the option sets change, because the data changed.

| Control | id | 2.0 behaviour |
|---|---|---|
| Search | `q` | `placeholder="Cari warna / kode barang…"`. Matches `name`, `warna`, `kode_barang`, `sku_key`. Keep the inherited `rankOf()` relevance ranking verbatim — it exists because "black" used to bury BLACK under BLACK GALAXY; the same failure exists in the new data. Read `warna` and `name`; the `batch_warna` branch is dropped (no such field). |
| Kode barang | `brand` | `<option value="">Semua kode</option>` + distinct `kode_barang`, sorted. **Label is "kode", not "brand"** — see §11-A1. |
| Ukuran | `size` | distinct `p×l`, numeric sort, rendered `4.880×1.220`. Omit the whole select when no item has both `p` and `l`. |
| Tebal | `mm` | distinct `th`, numeric sort, rendered `0,3` (no `mm` suffix — `th` is not millimetres; panel thickness lives inside `kode_barang`). Label the select `title="Tebal (th)"`. Omit when empty. |
| Urutkan | `sort` | `Warna A–Z` (default, persisted as `stk_sort`) · `Kode barang A–Z` · `Bisa dijual terbanyak` · `Bisa dijual paling sedikit`. The 1.0 `Coating` and `Sesuai file` options are dropped (no `coating` field, no file). |
| Sembunyikan yang kosong | `hz` | checkbox, **default on**, persisted `stk_hide_kosong`. Hides `state === "kosong"` only. **Never hides `perlu_produksi`** — same guard as the 1.0 zero toggle. |
| Hanya perlu produksi | `oo` | checkbox, default off. Replaces "Hanya overbooked" 1:1. |

Coating filter: **deleted**, no field in the contract (§11-A2).

Tie-breaking: keep the inherited `tail()` comparator (warna → kode → ukuran →
key) so a colour never jumps position between polls. Substitute `sku_key` for
`id` as the final key.

Filtering and sorting are **client-side** on `summary.items`; `GET /summary`
takes no query params (`CONTRACTS §4.1`). At 812 SKUs this is fine. If the SKU
count passes ~3,000 the toolbar must move server-side — flagged, not designed.

### 5.2 Item row

Desktop (≥560px) — inherited `<table>`:

| Column | Content | Align |
|---|---|---|
| Kode | `kode_barang` | left |
| Warna | `<b>{warna || name}</b>` + `.sub2` = `{th} · {p}×{l}` | left |
| Bisa Dijual | `.atp` block per §2.2 | right |
| Status | state chip (short label) + `.atp-note` when `habis`/`perlu_produksi` | right |

`th` header row: `KODE · WARNA · BISA DIJUAL · STATUS`.

Mobile (≤559px) — the `<table>` is replaced (not scrolled) by stacked cards:

```html
<div class="itemrow" role="button" tabindex="0" aria-label="ACP 4mm Black Galaxy, bisa dijual 3.849 lembar, Tersedia">
  <div style="display:flex;gap:10px;justify-content:space-between;align-items:flex-start;padding:12px 14px;border-bottom:1px solid var(--line);min-height:var(--tap)">
    <div style="min-width:0">
      <b>Black Galaxy</b>
      <div class="sub2">ACP-4MM · 0,3 · 4.880×1.220</div>
      <span class="chip st-tersedia" style="margin-top:6px;display:inline-block">Tersedia</span>
    </div>
    <div style="text-align:right;flex:0 0 auto">
      <div class="atp">3.849<span class="un">lembar</span></div>
      <div class="atp-m2">≈ 22.921,1 m²</div>
      <div class="atp-sub">Fisik 4.168 · Dipesan 319</div>
    </div>
  </div>
</div>
```

Row tap → detail sheet (§5.3). The whole row is the target; there is no separate
button, because there is no second action to disambiguate from.

### 5.3 Detail sheet (ST-R13) — `GET /api/stock/sku/:sku_key`

Inherited `.modal-bg` / `.modal` bottom sheet. Opens on row tap, `ESC` and the
`Tutup` button close it, focus returns to the row (§9.3).

```
h3   Black Galaxy
.mp  ACP-4MM · 0,3 · 4.880×1.220 · Kode SKU ACP-4MM|004|0.3|4880|1220
────────────────────────────────────────────────────
.atp  3.849 lembar      ≈ 22.921,1 m²
chip  Tersedia
Masih bisa dijual sekarang.                     ← §3 explanation, always shown
────────────────────────────────────────────────────
Stok Fisik (ERP)            4.168
Sudah Dipesan (aktif)       − 319
Penyesuaian                     0               ← row hidden when 0
Bisa Dijual                 = 3.849             ← border-top, bold
────────────────────────────────────────────────────
Pesanan Aktif (3)                               ← table: ETA · Sisa Pesanan · Sales
Pesanan Tanpa ETA — TETAP dihitung (2)          ← only when any live line has undated:true
Pesanan Lama — tidak dihitung (12)              ← collapsed; "Lihat 12 pesanan lama"
Penyesuaian (0)                                 ← hidden when empty
.foot  Data ERP per 14:05
[ Tutup ]
```

**Undated live lines (AMENDMENT 1).** A commitment with `undated: true` sits
inside **Pesanan Aktif** — it reserves stock, so it belongs with the lines that
reserve stock — with `<span class="chip st-habis">Tanpa ETA</span>` in its ETA
cell. When at least one exists, the section header reads
`Pesanan Aktif (3 · 1 tanpa ETA)` and a `.foot` line follows:
`Pesanan tanpa tanggal kirim tetap memotong stok karena pesanannya sudah disetujui.`
Never file an undated line under "Pesanan Lama" — that section is defined as
*not counted*, and putting a counted line in it makes the arithmetic above it
unverifiable by hand.

The arithmetic block is rendered as a small table with the operator glyphs
(`−`, `=`) in their own left column so the formula reads as a formula. This is
the single place a rep can see *why* the number is what it is, and it is the
whole answer to "kok stoknya banyak tapi nggak bisa dijual".

**Customer names are not shown on `/stock`.** The "Pesanan Aktif" table on the
sales page shows ETA, Sisa Pesanan and Sales — not `customer_name_text`. PPIC
sees the customer. See §11-A6; if the Architect rules otherwise, the column is a
one-line addition.

---

## 6. `/stock-ppic` — the PPIC console (WP-6)

**Audience:** PPIC staff at a desk, 1280–1920px, triaging thousands of rows.
Must remain usable on a phone (a supervisor checking from the plant floor), but
is not optimised for it.

### 6.0 Shell

```
<title>Stok — PPIC</title>
header  h1 "Stok — PPIC"  ·  .sub #dataPer (§4.1)  ·  a.pplink "Halaman Sales ↗"
.wrap (max-width 1000)
  label.fld  "Petugas PPIC"  #actor   ← inherited, persisted `stk_actor`, unchanged
  [banner §4.2 | offbox §4.3]
  .tabs  (role="tablist")
  #tabPanel (role="tabpanel", aria-labelledby=<active tab id>)
```

Tabs, in this order, each `role="tab"` with `aria-selected`, badge count in
`.tab .n`:

| # | id | Label | Badge source |
|---|---|---|---|
| 1 | `tab-kekurangan` | **Kekurangan** | count from `/shortfall` once fetched, `—` before |
| 2 | `tab-lama` | **Tinjau Pesanan** | `totals.stale_commitments` + undated count (§6.2.1) |
| 3 | `tab-cocok` | **Belum Cocok** | `totals.exceptions` |
| 4 | `tab-penyesuaian` | **Penyesuaian** | none |
| 5 | `tab-sinkron` | **Sinkronisasi** | none |

Badge formatting: `num()`; ≥1000 shown in full (`4.158`), never `4k` — the exact
number is the point of ST-R22.

Tab state lives in `location.hash` (`#lama`) so a PPIC user can bookmark and
deep-link a tab, and so "open the stale queue for this SKU" from the detail sheet
works as `#lama?sku=…`. Default tab: `#kekurangan`. Unknown hash → default.

Only the active tab fetches. Switching tabs re-fetches, except the Pesanan Lama
tab which keeps its page/filter/undo state in memory for the session (§6.7).

`requireActor()` is inherited and unchanged: every write is blocked with
`Isi nama petugas PPIC dulu.` and focus moves to `#actor`.

### 6.1 Tab 1 — Kekurangan (ST-R11)

Ranked by deficit desc, then `nearest_eta` asc — **server-side**
(`CONTRACTS §4.2`). The client never re-sorts; a PPIC user who sorts by another
column would silently break the production-priority order this list exists to
express. There are no sortable column headers on this tab.

Row:

| Column | Content |
|---|---|
| SKU | `<b>{warna}</b>` + `.sub2` `{kode_barang} · {th} · {p}×{l}` |
| Kekurangan | `.atp.neg` `−1.230` + `.un` unit — the headline of this tab |
| Fisik | `.atp-sub`-sized `4.168` |
| Dipesan | `319` |
| ETA Terdekat | `20 Sep` + `.chip.umur` when overdue |
| — | `Detail` → the §5.3 sheet (PPIC variant, with customer names) |

Footer note, always: `Diurutkan dari kekurangan terbesar, lalu ETA terdekat.`

No write action on this tab. It is a work list that feeds production planning
(F1), not a queue to clear.

### 6.2 Tab 2 — Tinjau Pesanan (ST-R18 + AMENDMENT 1)

~4,158 rows, ETAs back to 2020. This is the screen that decides whether the
module is trusted.

#### 6.2.1 Two populations, opposite consequences — the segmented control

CONTRACTS **AMENDMENT 1** rules that an approved line with
`estimate_delivery IS NULL` is **live**: it reserves stock, it carries
`undated: true`, and `/stale-commitments` surfaces it for PPIC triage alongside
genuinely stale lines.

That puts two populations behind one tab, and **closing them has opposite
effects**:

| Segment | ETA | Reserves stock? | Effect of `Tutup` |
|---|---|---|---|
| **ETA Lewat** (stale) | older than the 60-day window | **no** — already excluded | Cosmetic. Clears the queue. ATP unchanged. |
| **Tanpa ETA** (undated, live) | `null` | **yes** | **Consequential. ATP rises by `qty_balance`.** |

Merging them behind one `Tutup` button would let an operator who has learned
"closing does nothing to the numbers" silently release reserved stock. **They are
therefore two segments with different copy, different confirm behaviour, and
different colour of primary button.** They are never mixed in one list, and there
is no "Semua" segment.

```html
<div class="fltchips" role="tablist" aria-label="Jenis tinjauan">
  <button class="fchip on" role="tab" aria-selected="true"  data-seg="stale">ETA Lewat <b>4.158</b></button>
  <button class="fchip"    role="tab" aria-selected="false" data-seg="undated">Tanpa ETA <b>27</b></button>
</div>
```

Segment lives in the hash (`#lama:undated`). Default: `stale`. The two segments
share the row anatomy (§6.2.2), filters (§6.3), pager (§6.4) and undo tray
(§6.7); everything else below states which segment it applies to.

The tab badge in the strip (§6.0) shows `stale + undated` combined, with a
`title` breaking it down: `4.158 ETA lewat · 27 tanpa ETA`.

**Subtitle copy, per segment** (rendered above the table, not dismissible):

*ETA Lewat:*
> `Sales Order di bawah masih punya sisa, tapi ETA-nya sudah lewat lebih dari 60 hari. Baris ini TIDAK memotong angka Bisa Dijual. Tutup baris yang sudah jelas selesai atau batal agar antrean ini bersih.`

*Tanpa ETA:*
> `Sales Order di bawah sudah disetujui dan masih punya sisa, tapi belum punya tanggal kirim. Baris ini TETAP memotong angka Bisa Dijual — pesanannya nyata, hanya belum dijadwalkan. Menutup baris di sini akan MENAMBAH angka Bisa Dijual, jadi tutup hanya kalau pesanannya memang sudah batal.`

The sentence "TIDAK memotong" / "TETAP memotong" is load-bearing in both
directions. On the stale segment PPIC's first instinct is that closing a row
frees stock — it does not. On the undated segment the instinct is right, and
that is exactly why it needs a confirm step (§6.6.1).

#### 6.2.2 Row anatomy (both segments)

Desktop row (one `<tr>`, 44px minimum height):

| Column | Field | Notes |
|---|---|---|
| ☐ | — | bulk checkbox, ≥560px only (§6.6/§8) |
| SKU | `warna` bold + `.sub2` `{kode_barang} · {th} · {p}×{l}` | links to the detail sheet |
| Customer | `customer_name_text` | truncate to 2 lines with `overflow-wrap:anywhere`; never `text-overflow:ellipsis` on a single line — Indonesian company names are long and the tail (PT / CV / cabang) is the identifying part |
| No. SO | `so_number` | monospace-ish via `tabular-nums`; `—` when null |
| ETA | `estimate_delivery` | `wibShort` **with year** when not this year → `27 Agu 2020`. On the Tanpa ETA segment: `<span class="chip st-habis">Tanpa ETA</span>`, never a bare `—` (an em dash reads as "missing value", and the whole point is that this is a *known* condition with a consequence) |
| Umur | derived, whole days | `.chip.umur` tier per §6.5. Tanpa ETA segment: age from `po_date` instead, pill reads `dipesan 412 hari lalu`; if `po_date` is also null, `—` |
| Sisa Pesanan | `qty_balance` | right-aligned, `tabular-nums`, `.avail` weight |
| Status SO | `status_order` | plain `.chip.umur` neutral pill; `DO` gets `.chip.umur.old` — a line marked delivered that still carries a balance is exactly ST-R22's "delivered but not closed" and is the safest thing to close |
| Aksi | — | `Tutup` button (§6.6) |

Sales rep (`sales_name_text`) is shown in the detail sheet, not the row — nine
columns is already at the limit.

**Order — ETA Lewat:** oldest ETA first (`estimate_delivery asc`). The oldest
phantoms are the most certainly dead and give the fastest confidence win on first
use. Footer: `Diurutkan dari ETA paling lama.`

**Order — Tanpa ETA:** largest `qty_balance` first. These lines are *suppressing*
ATP right now, so the ones worth a phone call are the big ones, not the old ones.
Footer: `Diurutkan dari sisa pesanan terbesar.`

On the Tanpa ETA segment the row gains one extra cell at the end, before Aksi:
`Efek jika ditutup` → `Bisa Dijual +1.200` in `--ok-ink`. The operator sees the
consequence in the row, before the button, every time.

### 6.3 Tab 2 — filters

Rendered as a `.fltchips` row plus a compact form. All filter state goes in the
query string of the request; none of it is client-side (4,158 rows are never all
in the browser).

| Control | Param | Options |
|---|---|---|
| Search | `q` | `placeholder="Cari SKU / customer / No. SO…"`. Debounce 350ms, min 2 chars. |
| Umur | `min_age_days` | `.fchip` row: `Semua` (default) · `> 6 bulan` (180) · `> 1 tahun` (365) · `> 3 tahun` (1095). **ETA Lewat segment only** — hidden on Tanpa ETA, where there is no ETA to age. |
| Status SO | `status` | select, `Semua status` + distinct values returned by the endpoint's facet list; if no facet list is available, a free-text select built from the current page's values, labelled `Status (halaman ini)` |
| Hanya status DO | `only_do` | checkbox — the highest-confidence closable set (ST-R22) |

Active filters render as removable chips under the toolbar:
`Umur > 1 tahun ✕` · `Cari "PT Sinar" ✕`, plus `Bersihkan filter` when ≥1 active.
The result count line sits immediately above the table and always states both
numbers: `Menampilkan 50 dari 1.204 baris (difilter dari 4.158).`

### 6.4 Tab 2 — paging

Server-paged, `limit=50`, `page` 1-based. 50 is chosen so one screenful of desk
monitor ≈ one page and a mis-tap on "select all on this page" can never touch
more than 50 rows (§6.6).

```html
<div class="pager">
  <button class="btn ghost mini tap" id="pgPrev">← Sebelumnya</button>
  <span>1–50 dari 4.158 · Halaman 1 dari 84</span>
  <button class="btn ghost mini tap" id="pgNext">Berikutnya →</button>
</div>
```

- Both buttons `disabled` at the ends (inherited `.btn:disabled`, opacity .55).
- While a page is loading, the pager text becomes `Memuat…` and both buttons
  disable; the table keeps the **previous** rows at `opacity:.5` rather than
  clearing — a blank table between pages at 4,158 rows feels like data loss.
- Page changes scroll the table header into view (`scrollIntoView({block:"start"})`),
  never the top of the document.
- ≤559px: the middle span shortens to `Hal. 1/84` and the buttons to `←` / `→`
  with `aria-label="Halaman sebelumnya"` / `"Halaman berikutnya"`.
- No page-number jump input. At 84 pages it is a false affordance — filtering is
  the real navigation, and a jump box invites "page 47" as a workflow.
- The pager appears **above and below** the table on desktop; below only on mobile.

### 6.5 Age pill tiers

`umur = floor((today − estimate_delivery) / 1 day)`, computed client-side from
the date so it cannot drift from what the eye sees in the ETA column.

| Age | Class | Text | Contrast |
|---|---|---|---|
| ≤ 180 hari | `.chip.umur` | `92 hari` | 6.87:1 |
| 181–365 | `.chip.umur.old` | `7 bulan` | 6.38:1 |
| > 365 | `.chip.umur.ancient` | `2 tahun` | 5.30:1 |

Units: `< 60 hari` → `N hari`; `60–730` → `N bulan`; beyond → `N tahun`
(`Math.floor`, never rounded up — overstating age would overstate confidence).

### 6.6 Confirm-close

`POST /api/stock/stale-commitments/:so_line_id/close` with
`{ actor, reason }`. **Two behaviours, chosen by segment** — §6.6.1 for
ETA Lewat, §6.6.2 for Tanpa ETA. Getting this wrong is the single most expensive
mistake available on this page.

#### 6.6.1 ETA Lewat — one tap, and why it is not a confirm dialog

The action is *destructive-ish*: it permanently marks an ERP line as dismissed
in LeadScout, and it is audited with the operator's name. But it is also
**fully reversible** (`reinstate`, `CONTRACTS §4.2`), it affects one row, and the
user has 4,158 of them to get through. A modal per row is the design that makes
PPIC abandon the queue. **So: no per-row confirm dialog.** Safety comes from
reversibility and visibility, not from a speed bump.

Interaction, per row:

1. Button `<button class="btn mini tap ghost" data-close="{so_line_id}">Tutup</button>`.
2. On tap: button immediately becomes `<span class="spin"></span>Menutup…` and
   `disabled`. The row is **not** removed.
3. On 2xx: the row stays in place, gains `.rev` (inherited strike-through,
   opacity .6), the Aksi cell becomes
   `<span class="chip st-kosong">Ditutup</span> <button class="btn mini tap ghost" data-reinstate="…">Aktifkan Lagi</button>`,
   and the row is pushed onto the undo tray (§6.7).
   Toast: `Baris ditutup. Bisa diaktifkan lagi.` (`.toast.ok`)
4. On failure: §7.8.

`reason`: the contract does not mark it required for close (it does for
adjustments). This spec sends a composed default so the audit row is never blank
and the operator is never blocked:

```js
reason: `Ditutup dari antrean ETA Lewat (ETA ${etaIso}, umur ${days} hari)`
```

An operator who wants to say more uses the detail sheet, which has a
`Alasan (opsional)` textarea and the same `Tutup` button. See §11-A4 — if the
Architect makes `reason` mandatory, this becomes a one-field inline row expander,
not a modal.

#### 6.6.2 Tanpa ETA — one tap plus an inline confirm, never a bare tap

An undated line **is** reserving stock (AMENDMENT 1). Closing it raises ATP by
`qty_balance`, which means the next rep who looks at `/stock` is told they can
sell units that this order may still own. That is the over-promising failure the
Amendment's own reasoning calls the worse of the two errors, so the operator
states a reason every time.

It is still not a modal — a modal per row kills the queue just as surely here.
It is an **inline row expander**, which keeps the row, its customer and its
quantity on screen while the operator types:

1. Tap `Tutup` → the row expands in place (a second `<tr>` spanning all columns,
   `--warn-bg` ground, `--warn-line` top border):

   ```
   Menutup baris ini akan MENAMBAH Bisa Dijual sebanyak 1.200 lembar untuk
   Black Galaxy. Pastikan pesanan PT Sinar Abadi memang sudah batal.

   Alasan (wajib) [__________________________________]
                  Contoh: "Dikonfirmasi batal via telepon, 11 Sep."
   [ Batal ]                      [ Ya, Tutup Baris ]   ← .btn.danger, disabled <4 chars
   ```
2. `Esc` or `Batal` collapses it with no request. Only one row may be expanded at
   a time; opening a second collapses the first.
3. On confirm: identical to §6.6.1 steps 2–4, plus the success toast names the
   consequence: `Baris ditutup. Bisa Dijual Black Galaxy naik 1.200 lembar.`
4. The undo tray entry (§6.7) records the ATP delta so `Aktifkan Lagi` can say
   what it is putting back.

`reason` is sent as typed, never composed. The primary button is `.btn.danger`
here and `.btn.ghost` on the ETA Lewat segment — the operator can see which of
the two actions they are performing without reading a word.

### 6.7 Undo / reinstate — the "Baru Ditutup" tray

A closed row disappears from `v_stale_commitments` on the server, so the next
fetch would erase the only undo affordance. That is unacceptable at this volume.
Two mechanisms:

**(a) The row stays put.** Closed rows are not removed from the rendered page
until the user changes page, filter, or tab. The row is struck through and shows
`Aktifkan Lagi`.

**(b) A session tray, pinned above the table**, holding every line closed in this
browser session (id, SKU, qty, ETA, time):

```html
<div class="card" id="undoTray">
  <h2>Baru Ditutup <span class="chip st-kosong">23</span>
      <button class="btn mini tap ghost" id="undoAll">Aktifkan Lagi Semua</button></h2>
  <div class="body">…rows: SKU · Sisa Pesanan · 14:07 · [Aktifkan Lagi]…</div>
</div>
```

- Hidden when empty. Caps at 200 entries (drops oldest, with the footer note
  `Hanya 200 penutupan terakhir yang bisa dibatalkan dari sini.`).
- Survives tab switches within the session; cleared on reload — and the tray
  footer says so: `Daftar ini hilang jika halaman dimuat ulang. Penutupan tetap tercatat dan bisa dibatalkan lewat pencarian.`
- `Aktifkan Lagi Semua` is the only bulk-undo and it *is* confirmed
  (`§6.8` modal shape), because undoing 23 closes at once is as surprising as
  doing 23 closes at once.
- **Auto-refresh is disabled while this tab is open** (§6.9 poll rules). Rows
  must not renumber under a finger mid-triage.

**Finding a closed line later:** the tab gains one `.fchip` at the end of the
Umur row: `Yang sudah ditutup`. It sets `state=closed` on the request and renders
the same table, struck through, with `Aktifkan Lagi` in the Aksi cell. This is
the recovery path once the session tray is gone. See §11-A3 — the contract does
not specify a filter for closed rows.

### 6.8 Bulk triage — bounded by construction

**Bulk close is offered on the ETA Lewat segment only.** On Tanpa ETA there is no
checkbox column and no bulk bar: every one of those rows releases reserved stock,
the population is small (tens, not thousands), and each deserves its own typed
reason. The segment footer says so: `Baris tanpa ETA ditutup satu per satu karena masing-masing menambah angka Bisa Dijual.`

The danger with 4,158 rows is a "select all" that means all 4,158. This spec
makes that impossible rather than warning about it.

- Selection is **per page only**, maximum 50. The header checkbox is labelled
  `Pilih semua di halaman ini (50)` — it names its own scope in its label.
- There is **no** "select all matching filter" affordance. If a PPIC user needs
  to close 1,200 rows, that is a data-migration job for the back end, not a
  button. Say so in the footer: `Untuk penutupan massal di luar halaman ini, hubungi tim IT.`
- The bulk bar appears only when ≥1 row is selected, sticky at the bottom of the
  viewport, `--ink` ground:
  `23 baris dipilih · 1.810 lembar  [Batal pilih] [Tutup 23 Baris]`
  The qty total is shown because "23 rows" understates what is being dismissed.
- `Tutup 23 Baris` opens the only confirm modal in the queue:

```
h3   Tutup 23 baris pesanan lama?
.mp  Total 1.810 lembar. Baris ini akan hilang dari antrean dan tercatat atas
     nama Budi. Angka Bisa Dijual TIDAK berubah — baris lama memang sudah tidak
     dihitung.
label Alasan (wajib)  <textarea id="bulkReason" minlength="4">
      helper: Contoh: "Hasil verifikasi PPIC Sep 2026 — SO sudah dikirim/batal."
[ Batal ]  [ Tutup 23 Baris ]        ← primary is .btn.danger, disabled until reason ≥4 chars
```

  Reason **is** mandatory for bulk even though it is optional for a single row:
  one tap on one line is a judgement about that line; 23 at once is a policy, and
  a policy needs a written justification in the audit log.
- Execution: sequential `POST`s, concurrency 4, with a live progress line in the
  modal (`Menutup 12 dari 23…`) and a cancel button that stops issuing new
  requests. There is no bulk endpoint (§11-A5).
- Result: `.warnbox`-style summary in the modal, not a toast, when anything
  failed:
  - all ok → close modal, toast `23 baris ditutup.`, all 23 enter the undo tray.
  - partial → `20 berhasil, 3 gagal.` with the 3 listed by No. SO and a
    `Coba Lagi yang Gagal` button. The 20 successes still enter the undo tray.
- ≤559px: bulk selection is **not offered** (§8). No checkbox column, no bulk
  bar. Per-row `Tutup` remains.

### 6.9 Poll and refresh rules — both pages

The inherited pattern is `setInterval(loadSummary, 30000)`. Keep the interval;
change what it is allowed to do.

| Rule | Applies |
|---|---|
| `/api/stock/summary` polls every **30s**. The ERP itself syncs every ~180s, so a 30s client poll costs little and keeps the freshness line honest. | both |
| **Never re-render while a modal is open.** Store the response, apply on close. | both |
| **Never re-render while the user is typing.** If `document.activeElement` is a filter input or textarea, defer to 2s after the last keystroke. | both |
| **Never re-order rows under a pointer.** If `document.activeElement` is inside the list, or the list has been scrolled in the last 2s, update the numbers in place and defer the re-sort. | both |
| The Tinjau Pesanan tab **does not auto-refresh its rows.** The summary poll continues (freshness line, badge counts). When `totals.stale_commitments` changes, show a non-modal pill above the table: `Ada perubahan di antrean. [Perbarui]` — the user chooses when the ground moves. | PPIC tab 2 |
| Penyesuaian and Sinkronisasi tabs refresh on the 30s tick normally. | PPIC |
| A poll that fails does **not** clear the screen (§7.4). | both |
| Changed values flash once (`.f-up` / `.f-dn`, 1.2s) and are announced (§9.4). | both |

### 6.10 Tab 3 — Belum Cocok (ST-R5.3)

**Copy discipline first.** These rows are SO demand whose SKU has no matching
Live FG row. Common causes: a make-to-order item that has never been stocked, a
brand-new SKU, or a code written differently on the two sides. **None of these
is the user's mistake, and none of them is a system failure.** The words `error`,
`gagal`, `tidak valid`, `rusak` and `masalah` are banned on this tab.

Tab subtitle:

> `Baris Sales Order di bawah belum cocok dengan SKU barang jadi mana pun, jadi belum bisa ikut dihitung. Biasanya karena barang dibuat khusus (make-to-order), SKU-nya baru, atau penulisan kodenya berbeda antara SO dan stok. Permintaannya tetap nyata — bukan kesalahan input.`

Row:

| Column | Field |
|---|---|
| Kode SKU (SO) | `sku_key` from the SO side, `tabular-nums`, with a `Salin` button |
| Detail | `kode_barang · warna · th · p×l` — whichever segments are present, `—` for `-` segments |
| Customer | `customer_name_text` |
| No. SO / ETA | `so_number` · `estimate_delivery` |
| Sisa Pesanan | `qty_balance` + unit |
| Sebab | one of the reasons below, as a `.chip.umur` |

`Sebab` chip values (client-derived, purely descriptive, never accusatory):
`Tidak ada di stok` (no FG row with this key) · `Satuan berbeda` (ST-R5.4 UoM
reconciliation failed) · `Data belum lengkap` (a key segment is `-`).

Footer: `Total permintaan belum cocok: 31 baris · 4.120 lembar.`

**No write action.** The contract exposes no endpoint to resolve an exception
(§11-A7), so this tab is a report. Offer `Salin Kode SKU` per row and
`Salin semua (31)` in the card header so PPIC can paste the list into an ERP
cleanup ticket — that is the real workflow and it needs no back end.

### 6.11 Tab 4 — Penyesuaian (ST-R12)

Two halves in one tab: the form, then the audit list.

**Form** — `POST /api/stock/adjustments` `{ sku_key, qty_delta, reason, actor }`.

```
h2   Penyesuaian Stok
.body
  label.fld  SKU  <input id="adjSku" list="skuList" placeholder="Cari warna atau kode barang…">
             ← datalist built from summary.items; the field stores sku_key,
               displays "{warna} · {kode_barang} · {th} · {p}×{l}"
  ↳ once resolved, a read-only preview strip:
      Stok Fisik 4.168 · Sudah Dipesan 319 · Bisa Dijual 3.849
  label.fld  Jumlah Penyesuaian
             [ − ] [ input type=number inputmode=decimal id=adjQty ] [ + ]   satuan: lembar
             helper: Positif = stok bertambah (mis. barang ketemu saat opname).
                     Negatif = stok berkurang (mis. pecah, salah catat).
  label.fld  Alasan (wajib)  <textarea id="adjReason" minlength="4" rows="3">
             helper: Contoh: "Stock opname 11 Sep — 12 lembar pecah di rak B."
  ↳ live effect line, --ink-2:
      Bisa Dijual: 3.849 → 3.837  (−12)
  [ Simpan Penyesuaian ]     ← .btn, min-height var(--tap)
```

Validation, enforced client-side before the request and re-checked on the
response (§7.10):

| Rule | Message under the field |
|---|---|
| SKU not chosen / not in list | `Pilih SKU dari daftar.` |
| `qty_delta` empty or `0` | `Jumlah tidak boleh 0.` |
| `qty_delta` not a number | `Masukkan angka.` |
| `reason` < 4 characters | `Alasan wajib diisi.` |
| `actor` empty | inherited `requireActor()` → toast + focus |

The submit button is enabled only when all pass; it never fires a request it
knows will fail. On success: toast `Penyesuaian tersimpan.`, form resets except
`actor`, audit list refreshes, and the effect line is replaced by
`Bisa Dijual sekarang 3.837 lembar.` for 5s.

**Sign is a deliberate two-step.** The `−` / `+` buttons set the sign and the
number field holds an unsigned magnitude; the effect line restates the signed
result in words. A bare signed number field is where "-12" gets typed as "12".

**Audit list** — `GET /api/stock/adjustments`, newest first, 50 per page with the
§6.4 pager:

| Waktu | SKU | Jumlah | Alasan | Petugas |
|---|---|---|---|---|
| `11 Sep 14:07` | `Black Galaxy · ACP-4MM` | `−12` in `.atp.neg`-coloured 13px | full text, wrapped | `Budi` |

Adjustments are additive and are never edited or deleted (`CONTRACTS §2.2`). The
card footer says so: `Penyesuaian tidak bisa dihapus. Untuk membatalkan, buat penyesuaian kebalikannya.`
There is no delete button; do not build one.

### 6.12 Tab 5 — Sinkronisasi

`GET /api/stock/sync-status`. One `.card` per mirrored table, in this order:
`live_fg` (**Stok Fisik**), `so_line` (**Baris Sales Order**), `so_header`
(**Sales Order**).

```
h2   Stok Fisik (live_fg)     <span class="chip st-tersedia">Sehat</span>
.body
  Sinkron terakhir     11 Sep 14:05 · 2 mnt lalu
  Posisi kursor        11 Sep 13:58
  Baris tersinkron     1.464
  Kesalahan terakhir   —                       ← or the message + timestamp
```

Health chip per table: `Sehat` (`.st-tersedia`) when `last_ok_at` is within
2 intervals · `Terlambat` (`.st-habis`) within `STOCK_SYNC_STALE_ALERT_INTERVALS`
· `Bermasalah` (`.st-perlu-produksi`) beyond that or when `last_error` is set and
newer than `last_ok_at` · `Belum pernah` (`.st-kosong`) when `last_ok_at` is null.

`last_error` renders inside the inherited `.warnbox`, wrapped, never truncated —
and **never** in a toast, because the operator needs to copy it. Add
`Salin pesan kesalahan`.

Header action: `<button class="btn tap" id="syncNow">Sinkron Sekarang</button>`
→ `POST /api/stock/sync`.

| Response | Behaviour |
|---|---|
| accepted | button → `<span class="spin"></span>Menyinkronkan…`, disabled 10s, then re-fetch status. Toast `Sinkronisasi dijalankan.` |
| already running | Toast `Sinkronisasi sedang berjalan.` (`.toast.warn`), button disabled 10s anyway |
| error / network | §7.8 |
| `erp_connected === false` | button rendered `disabled` with `title="ERP tidak terhubung"` |

The button is `disabled` for 10s regardless of outcome. The endpoint is
idempotent, but a PPIC user hammering it during an outage produces a log flood
and a false sense of action.

Footer, always: `Sinkronisasi otomatis berjalan setiap ±3 menit.`

---

## 7. Unhappy paths

Every state below is designed, has copy, and is reachable in a fixture. A state
not listed here does not exist; if you hit one, raise it.

**Global rule:** a failure never empties a screen that already has data. The last
good render stays, dimmed if necessary, with the failure stated above it. At
4,158 rows and a field 3G connection, a blank page reads as data loss.

### 7.1 Loading

- **First load, nothing on screen yet:** skeleton, not a spinner, not `Memuat…`
  alone. Header `.sub` shows `Memuat…` (inherited). The list card renders 6
  skeleton rows: a `.sk` 40% wide (name), `.sk` 60% (spec), `.sk.lg` 70px
  right-aligned (the ATP). Table header renders for real so the columns do not
  jump.
- **Refresh over existing data:** no skeleton, no spinner, no layout change.
  Only the freshness line moves. This is the common case and it must be silent.
- **Page change in a pager:** previous rows at `opacity:.5`, pager reads
  `Memuat…`, buttons disabled (§6.4).
- **A button that triggers a request:** inherited `.spin` inside the button,
  button `disabled`, label changes to the present participle
  (`Menutup…`, `Menyimpan…`, `Menyinkronkan…`). Never a full-page overlay.
- Nothing shows a loading state for less than 200ms — `setTimeout` the skeleton
  so a fast response does not flash.

### 7.2 Empty — there is genuinely nothing

| Where | Copy (inside inherited `.empty`) |
|---|---|
| `/stock`, `items: []`, ERP connected, synced | `Belum ada data stok dari ERP.`<br>`Sinkronisasi berjalan otomatis setiap ±3 menit. Halaman ini akan terisi sendiri.` |
| `/stock`, ERP connected, `last_ok_at` null | `Menunggu sinkronisasi pertama dari ERP.`<br>`Biasanya selesai dalam beberapa menit.` |
| `/stock`, ERP not connected | §4.3 |
| PPIC · Kekurangan empty | `Tidak ada SKU yang kekurangan stok.`<br>`Semua pesanan aktif masih tertutup stok fisik.` — this is good news; do not style it as an error. |
| PPIC · Tinjau Pesanan / ETA Lewat empty | `Tidak ada pesanan dengan ETA lewat.`<br>`Semua Sales Order terbuka punya ETA dalam 60 hari terakhir.` |
| PPIC · Tinjau Pesanan / Tanpa ETA empty | `Tidak ada pesanan tanpa tanggal kirim.`<br>`Semua Sales Order yang disetujui sudah punya ETA.` |
| PPIC · Belum Cocok empty | `Semua baris Sales Order sudah cocok dengan SKU stok.` |
| PPIC · Penyesuaian audit empty | `Belum ada penyesuaian.` |
| PPIC · Sinkronisasi, no rows in `erp_sync_state` | `Sinkronisasi belum pernah berjalan.` |

### 7.3 Zero results after filtering — never the same as §7.2

The distinction matters: §7.2 means "there is no data"; §7.3 means "your filter
hid it". The escape hatch must be in the message.

```html
<div class="empty">
  Tidak ada baris yang cocok dengan filter ini.<br>
  <a href="#" id="clearFlt">Bersihkan filter</a> untuk melihat semua 4.158 baris.
</div>
```

- `/stock` variant: `Tidak ada produk yang cocok.` + `Bersihkan filter` +, when
  `hideZero` is on and would have matched, the extra line
  `Beberapa produk disembunyikan karena stoknya kosong.` with an inline
  `Tampilkan yang kosong` link. A rep searching for a colour and getting nothing
  because a checkbox they never noticed is ticked is the worst bug on this page.
- The filter chips row and the toolbar stay visible and enabled. Never clear the
  user's filters automatically.

### 7.4 Fetch failed — network or 5xx

- **With data on screen:** keep it. Freshness line →
  `Data ERP per 14:05 · gagal memuat ulang`. One `.toast.err`:
  `Gagal memuat data. Mencoba lagi otomatis.` Toast is rate-limited to once per
  60s so a tunnel does not produce twenty toasts.
- **Without data (first load):** replace the skeleton with
  ```html
  <div class="empty">Gagal memuat data.<br>Periksa koneksi Anda.
    <br><button class="btn tap" id="retry" style="margin-top:12px">Coba Lagi</button></div>
  ```
- Polling continues on its normal 30s interval. Do not back off aggressively and
  do not stop — the common cause is a lift or a dead spot, and the page should
  simply recover.

### 7.5 Database unavailable — HTTP 503

Shape is frozen: `{ error: "Database tidak tersedia." }` (`CONTRACTS §4`).
Render the server's message verbatim; do not substitute your own.

```html
<div class="empty">Database tidak tersedia.<br>Hubungi tim IT.</div>
```

Plus `.toast.err` with the same server string on the first occurrence only.
All write controls become `disabled`. Polling continues.

### 7.6 Partial failure

PPIC fetches per tab, so one failing endpoint must not take the page down.

- A tab whose fetch failed shows §7.4 **inside its own panel**; the tab strip,
  the header, the freshness line and every other tab keep working.
- The failing tab's badge shows `!` in `--danger` instead of a count, with
  `title="Gagal memuat"`.
- If `/summary` succeeds but a tab endpoint fails, the header is still correct —
  say so implicitly by leaving it alone. Do not grey out the whole page.
- Bulk close partial failure: §6.8.

### 7.7 Stale data and ERP disconnected

§4.2 and §4.3. Precedence in §4. Both are *states*, not errors: they never use
`.toast.err`, never use `--danger`, and never block reading the numbers.

### 7.8 Write failed

Applies to close, reinstate, adjustment, manual sync.

1. **Revert the optimistic UI immediately.** The row goes back to exactly its
   pre-tap appearance; the button re-enables with its original label. A row that
   is still struck through after a failed close is a lie.
2. `.toast.err` with the server's Bahasa `error` string when present, else the
   generic per action:
   - close → `Gagal menutup baris. Coba lagi.`
   - reinstate → `Gagal mengaktifkan lagi. Coba lagi.`
   - adjustment → `Gagal menyimpan penyesuaian. Coba lagi.`
   - sync → `Gagal menjalankan sinkronisasi.`
3. **Never lose typed input.** A failed adjustment leaves the form filled exactly
   as submitted, including the reason. A failed bulk close leaves the modal open
   with its reason text and the failed rows listed.
4. Two consecutive failures on the same control swap the toast for an inline
   `.warnbox` above the control, which persists until the next success:
   `Perubahan belum tersimpan. Periksa koneksi, lalu coba lagi.`
5. `409`/`422` (already closed, already reinstated) is **not** an error to the
   user: refresh that row from the response and toast
   `Baris ini sudah diperbarui oleh orang lain.` (`.toast.warn`).

### 7.9 A retired endpoint answers (HTTP 410)

Should be unreachable — §10 deletes every caller. Defensive net, because a cached
HTML file in a rep's browser is a real thing:

on any `410`, show a non-dismissible `.warnbox`:
`Halaman ini sudah diperbarui. Muat ulang untuk melanjutkan.` with a
`Muat Ulang` button calling `location.reload(true)`. Do not render the server's
410 body — it explains bookings to someone who is not trying to book.

### 7.10 Validation failure returned by the server

Client validation (§6.11) should prevent these, but the server is the authority.
Render the server's `error` string under the offending field in `--danger` 12px,
move focus to that field, and leave every other value untouched. Never clear a
form because the server said no.

