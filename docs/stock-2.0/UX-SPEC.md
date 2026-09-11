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

#### 1.1b Inherited literals that have no token

The 1.0 CSS hard-codes a handful of colours inside rules rather than in `:root`.
They carry forward inside those rules verbatim. **Do not write any of these
values in new CSS** — if you need one, you need a token, which means §1.2, which
means raising it. They are listed only so every hex in this document traces to a
table.

| Literal | Inherited rule | Role |
|---|---|---|
| `#fafbfc` | `th`, `.card h2` | table-header / card-header ground |
| `#c7cfde` | `header .sub` | header subtitle ink on `--ink` |
| `#ffd27a` | `header a.pplink` | cross-link ink on `--ink` |
| `#166534` | `.toast.ok` | success toast ground |
| `#b45309` | `.toast.warn` | warning toast ground (same hue as `--warn-ink`) |
| `#f7fafc` | `tr.itemrow:hover` | row hover |
| `#f3c9c2` | `.btn.danger` | danger button border |
| `rgba(15,23,42,.5)` | `.modal-bg` | scrim |
| `#fef2f2` / `#fbcaca` / `#991b1b` | `.warnbox` | inline error box (PPIC) |
| `#fffbeb` / `#fde68a` / `#92400e` | `.warnbox.amber` | inline caution box (PPIC) |
| `#374151` | `.countchip` | totals-chip ink |

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
| `.fltchips`, `.fchip` (PPIC) | Filter chip rows on both pages — **but the two pages had diverged** (`/stock` uses tokens + `aria-pressed`, `/stock-ppic` still has raw hex + `.fchip.on`). §1.3 gives the canonical block; both pages adopt it verbatim and `.fchip.on` is retired. |
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

/* ── the merek inside a spec line (§5.2) ──────────────────────────────────
      `.sub2 .mk` is not redundant: `.warna b` is (0,1,1) and would otherwise
      give the merek the colour's 14px lead. The whole point of the class is
      that the merek is the ANCHOR of the second line, never the first. ───── */
.mk       {color:var(--ink-2);font-weight:700}
.sub2 .mk {font-size:inherit}
.sub2     {overflow-wrap:anywhere}   /* added declaration, §0 rule 1 */

/* ── the offline (ERP not configured) box — deliberately NOT amber ────────── */
.offbox{background:var(--offline-bg);border:1px solid var(--offline-line);
        color:var(--offline-ink);border-radius:12px;padding:12px 14px;
        font-size:13px;line-height:1.45;display:flex;gap:10px;
        align-items:flex-start;margin-bottom:12px}

/* ── filter chip row + totals strip — CANONICAL, byte-identical on both pages
      (CONTRACTS "Open": the two pages had diverged; this is the reconciliation) ─ */
.fltchips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.fchip{border:1px solid var(--line);background:var(--card);color:var(--ink-2);
       border-radius:999px;padding:0 12px;min-height:var(--tap);font:inherit;
       font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;
       align-items:center;gap:6px}
.fchip[aria-pressed="true"],
.fchip[aria-selected="true"]{background:var(--ink);color:var(--card);border-color:var(--ink)}
.fchip:disabled{opacity:.55;cursor:default}
.fchip .n{font-variant-numeric:tabular-nums;font-weight:800}

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
| `kode_barang` | **Kode Barang** | "Brand", "Merek", "Part no" — it is the ERP item code and `brand` is now a real field beside it (§11-A1) |
| `brand` / `brand_text` | **Merek** | "Brand", "Merk" (KBBI spells it *merek*), "Kode Barang" |
| `brand` when it is still a raw ID | **`Kode merek 12`** — same discipline as §1.6 | a bare `12` |
| `brand` and `brand_text` both absent | **nothing is rendered** | "—", a blank chip, or a merek guessed out of `kode_barang` |
| `warna` | **Warna** | |
| `warna` when it is still a raw ID | **`Kode warna 004`** — see §1.6 | a bare `004` |
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

### 1.6 `warna` is an ID, not a name — how the colour label is resolved

> **Added this session, verified against the real Selaras payload.** Both mirror
> tables carry `warna` as a numeric code (e.g. `4`) into the colour master
> `tbl_1228_DBRMWarnaID`, whose `rm_warna` holds the name (`BLACK GALAXY`). Every
> place this document writes `{warna}` as something to render — §5.2, §5.3,
> §6.1, §6.2.2, §6.10 — was therefore specifying **"4"** in the position where a
> rep expects the single most important label on a stock screen.

The back end resolves it into `warna_name` (= `coalesce(warna_text,
erp_warna.rm_warna)`) and folds the same name into the composed `name`. The
pages read, in this order, and stop at the first that is **not** all digits:

1. `warna_name` — the resolved name.
2. `warna_text` — the mirror's own `_text` twin.
3. `warna` — already a name in some payloads.
4. the colour recovered from `name`, by stripping the parts we hold as fields
   (the `kode_barang` prefix, the `th` suffix, the ` · {p}×{l}` tail). If the
   strip does not bite, the fuller name is kept — long but true.
5. otherwise the code, **labelled as a code**: `Kode warna 004`.

**Rule: a bare number is never rendered as if it were a product name.** Step 5 is
not a fallback of last resort that can be skipped — it is what makes the page
correct *before* the resolution lands as well as after, and it is what stops a
rep reading a master-data id as a colour.

**`brand` has exactly this shape and takes exactly this discipline.** It is the
product-line id the six-segment key is built from, with a `brand_text` display
twin, and the page reads `brand_text` → `brand` → `Kode merek {code}`. It differs
from `warna` in one way only: there is no name to recover from `name` and no
master to fall back to, so when **both** fields are absent the page renders
**nothing at all** — not an em dash, and never a merek split out of
`kode_barang`, which conflates merek, lini produk and tebal panel. A guessed
manufacturer is worse than a missing one: a rep will quote it.

This label — not the raw code — is what the `Warna` filter lists and matches on,
what `Warna A–Z` sorts by, and what `rankOf()` ranks. The raw code stays in the
search haystack, because PPIC and IT quote it.

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

## 4. Freshness, staleness, disconnection — five conditions, four looks

> **Amended (this session).** This section shipped with three conditions. The
> real Selaras connection needs five: the two that were missing are *credentials
> rejected* and *the sync itself is failing*, and both were previously rendered
> as one of the other three, which told the operator to do the wrong thing.
> §4.4 and §4.5 are new; §4.1's table gains their rows.

These are mutually exclusive in the UI. **Precedence, highest first:**

1. `freshness.erp_connected === false` → **offline box** (§4.3). Suppresses all below.
2. ERP reachable, credentials rejected → **rejected-access box** (§4.4).
3. last sync attempt errored → **amber banner, sync-failing copy** (§4.5).
4. `freshness.stale === true` → **amber banner, stale copy** (§4.2).
5. otherwise → **freshness line only** (§4.1), and on `/stock` only, the
   untrustworthy-ATP line (§4.6) when it applies.

Never render two at once. The header freshness line (§4.1) renders in all five
cases, with different text.

**Why 2 and 3 are not "tidak terhubung".** §4.3's slate box says *this feature is
switched off, wait for IT to turn it on*. A rejected credential is not switched
off — the ERP is there and answering, and it is refusing us; the fix is an
administrator replacing a secret, and telling the operator to wait is telling
them to wait for something that will never happen. **Why 3 is not "kedaluwarsa".**
§4.2 says only *the data is old*; §4.5 says *we know why it is old, and here is
the message*. They are one banner apart in colour and a whole diagnosis apart in
content.

Three colour families still carry it: slate = switched off · amber = the data may
be old · **red (`--neg-bg` / `--neg-ink`, new class `.alarmbox`, 5.30:1) = a
person has to fix this and waiting will not**. No new token; the pair is hoisted
from the inherited `.st-rejected`, exactly as §1.2 hoisted the others.

### 4.1 The freshness line — always visible

Lives in the inherited `header .sub` (`#dataPer`), 12px — the inherited
header-sub ink on `--ink`, 10.01:1 (§1.1b). It is the only thing in the header that
changes, so it is also the element that tells a rep the page is alive.

| Condition | Copy |
|---|---|
| `last_ok_at` present, fresh | `Data ERP per 14:05 · 2 mnt lalu` |
| `last_ok_at` present, <60s old | `Data ERP per 14:05 · baru saja` |
| `last_ok_at` present, >24h old | `Data ERP per 10 Sep 14:05` |
| `last_ok_at` null, `erp_connected` true | `Menunggu sinkronisasi pertama…` |
| `erp_connected` false | `ERP tidak terhubung` |
| credentials rejected (§4.4) | `Akses ERP ditolak` |
| last sync attempt errored (§4.5), `last_ok_at` present | `Data ERP per 14:05 · sinkronisasi gagal` |
| last sync attempt errored, `last_ok_at` null | `Sinkronisasi ERP gagal` |
| initial page load, before first response | `Memuat…` (inherited) |
| summary fetch failed, previous data still on screen | `Data ERP per 14:05 · gagal memuat ulang` |

When the sync is failing, `· sinkronisasi gagal` **replaces** the relative half
rather than being appended to it: `Data ERP per 14:05 · 2 jam lalu ·
sinkronisasi gagal` is three clauses where the middle one is the least useful.
Same rule as the inherited `· gagal memuat ulang`, which it sits beside.

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

### 4.4 Credentials rejected — an admin action, not a wait

Condition: the ERP is configured and reachable and is refusing our credentials.

**Ratified and landed (back-end FIX D):** `freshness.erp_authorized: boolean`,
false **only** on a recorded 401/403 — never-having-synced is not an
authorization verdict, so a fresh deployment gets no "call IT" banner. It is on
`Freshness`, so it arrives on `/summary`'s own 30s poll and this state does not
depend on `/sync-status` being reachable. Per-table `last_error_kind:
"auth" | "network" | "shape" | "erp_error" | "server" | "other"` classifies it a
second time.

Both pages read, in order, and stop at the first that answers:

1. `summary.freshness.erp_authorized === false`;
2. the same on `/sync-status`, at either level, plus the spellings the pages
   have always tolerated (`authorized`, `erp_auth_failed`, `auth_failed`,
   `unauthorized`);
3. any `tables[].last_error_kind === "auth"`;
4. **floor**, for a mirror predating those fields: a probe of
   `tables[].last_error`, into which the ERP client writes `HTTP 401 from ERP`
   verbatim — `/\bHTTP\s*(401|403)\b|\b(unauthorized|forbidden)\b/i`.

Step 4 is a string sniff on prose nobody promised to keep stable, which is
exactly why steps 1–3 exist and why it is last. Anything unmatched degrades to
§4.5 — the honest answer when we cannot tell.

Rendered in `.alarmbox` (red), never in `.offbox` (slate) and never in `.banner`
(amber).

```html
<div class="alarmbox" role="status">
  <span aria-hidden="true">🔒</span>
  <div><b>Akses ERP ditolak.</b> …</div>
</div>
```

| Page | Copy |
|---|---|
| `/stock` | `Sistem ERP menolak kredensial LeadScout, jadi angka stok berhenti diperbarui. Menunggu atau memuat ulang halaman tidak akan memperbaikinya — hubungi tim IT. Sementara itu, konfirmasi ke PPIC sebelum menjanjikan stok.` |
| `/stock-ppic` | `Sistem ERP menolak kredensial LeadScout sejak {waktu}, jadi data stok berhenti diperbarui. Menjalankan sinkronisasi ulang tidak akan memperbaikinya — hubungi tim IT untuk memperbarui kredensial ERP.` + `Sampai itu beres, angka di bawah adalah data terakhir yang berhasil diambil.` |

- **No retry affordance in this state, on either page.** Not a `Sinkron sekarang`
  button, not a `Coba lagi`. The credential stays rejected until a human replaces
  it, and a button that provably does nothing teaches the operator that the
  buttons on this page do nothing.
- The item list is **not** replaced and write controls are **not** disabled: the
  numbers on screen are the last good mirror, and LeadScout's own overrides and
  adjustments do not write to the ERP.

### 4.5 Sync failing — we know why the data is old

Condition: any table in `/api/stock/sync-status` carries a non-null `last_error`.
The worker clears `last_error` on a successful pull, so a message that is still
there means that table's **most recent attempt** failed. The front end does not
time this out or re-derive it.

Uses the inherited `.banner` (amber). It outranks §4.2 because it is strictly
more informative: staleness says the data is old, this says why and where the
message is.

| Page | Copy |
|---|---|
| `/stock` | `Sinkronisasi ERP gagal. Angka di bawah adalah data terakhir yang berhasil diambil, per {waktu} — konfirmasi ke PPIC sebelum menjanjikan stok.` (never synced: `Sinkronisasi ERP gagal dan belum pernah berhasil. Angka stok belum bisa dipakai — konfirmasi ke PPIC sebelum menjanjikan stok.`) |
| `/stock-ppic` | `Sinkronisasi ERP gagal sejak {waktu}. Angka di bawah adalah data terakhir yang berhasil diambil, per {waktu} — buka tab Sinkronisasi untuk pesan kesalahannya.` + right-aligned `<button class="btn mini tap ghost">Buka Sinkronisasi</button>` |

Sales gets no button, for §4.2's reason: sales cannot fix this. PPIC's button
goes to the tab that already renders `last_error` in full, untruncated and
copyable (§6.12) — that is the action, not another sync attempt against a thing
that just failed.

**Recovery**, from §4.4 or §4.5 back to healthy or merely stale, is announced
once and politely, the same way §4.2 announces its own: `Sinkronisasi ERP kembali
normal.` On `/stock-ppic` entering §4.4 also announces
`Peringatan: akses ERP ditolak. Hubungi tim IT.` to `#srlive`.

### 4.6 ATP is not trustworthy — the unmatched-SKU alarm (ST-R5.3)

> **Added by CONTRACTS amendment, this session.** §5.0 says `exceptions` is a
> PPIC hygiene number and is not shown to sales. That still holds and is not
> weakened here: what sales gets is **an instruction with no figures in it**.
> The reasoning is that §5.0's argument is about a *count* — "31 exceptions"
> reads to a rep as generalised breakage and gives them nothing to do — and says
> nothing about a *sentence* that tells them what to do. The stale banner already
> gives sales exactly that kind of sentence.

The SKU join key (`CONTRACTS §1`) has never been validated against real ERP data.
If it does not resolve, every commitment falls into `/exceptions`, nothing is
subtracted from on-hand, **ATP silently equals Stok Fisik, and the entire
inventory reads as promiseable on a page that looks perfectly healthy.** It is
the one failure where the screen is not visibly degraded — stale data is visibly
old; this is confidently wrong — and the person who acts on it is a rep in a
customer's showroom, not PPIC.

**Trigger, identical on both pages.** From `summary.totals`, no extra fetch:

| Available | Ratio | Fires above |
|---|---|---|
| `exceptions` (SO **lines**) ÷ `skus` (**SKUs**) | inflated — several lines share one SKU | **50%** |
| `exception_skus` (distinct unmatched `sku_key`) ÷ `skus` | a true share | **25%** |

`totals.exception_skus` has **landed**; both pages prefer it whenever it is
present and use the 25% limit, falling back to the line ratio and 50% only for a
payload that lacks it. The 50% figure is deliberately high: a working join lands in the low tens
of percent even with the line inflation, a broken join key lands at several
hundred, and 50% is the empty space between them. **The copy states its own
threshold** — an alarm that will not say what tripped it does not get believed.

`/stock-ppic` — `.alarmbox`, above the tab strip so it is visible on every tab,
**not dismissible**, with a `Buka Belum Cocok` button:

> **Angka Bisa Dijual belum bisa dipercaya.**
> `{n} baris Sales Order belum cocok dengan SKU stok. Dibandingkan jumlah SKU ({m}), itu {p}%.` *(with `exception_skus`: `{n} dari {m} SKU ({p}%) tidak punya baris stok yang cocok.`)* `Peringatan ini baru muncul di atas {limit}%, jadi ini bukan soal beberapa baris yang nyasar: pencocokan Kode SKU antara Sales Order dan stok belum jalan.`
> `Baris yang belum cocok tidak memotong stok, jadi hampir seluruh stok terlihat bisa dijual padahal sudah dipesan. Jangan pakai angka Bisa Dijual untuk menjanjikan stok, dan beri tahu tim Sales, sampai pencocokan Kode SKU dibereskan bersama tim IT.`

`/stock` — `.alarmbox`, above the list, not dismissible, **one sentence, no
numbers, no link** (there is no sales-side action but the phone call):

> `Angka Bisa Dijual sedang tidak bisa dipakai untuk menjanjikan stok — konfirmasi ke PPIC dulu.`

It is **last in the §4 precedence ladder**: it renders only when the connection
is healthy. When the ERP is disconnected, rejecting us, failing to sync or stale,
that claim is the more urgent one and this one is suppressed — never two at once.
The words banned on the Belum Cocok tab (§6.10 — `error`, `gagal`, `tidak valid`,
`rusak`, `masalah`) are avoided here too, even though this box sits outside that
tab, because it is the same subject.

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
| Search | `q` | `placeholder="Cari merek / warna / kode…"`, label `Cari merek, warna atau kode barang`. Matches `name`, `warna`, `brand`/`brand_text`, `kode_barang`, `sku_key`. A merek match ranks with a `kode_barang` match (rank 4), below every colour match. Keep the inherited `rankOf()` relevance ranking verbatim — it exists because "black" used to bury BLACK under BLACK GALAXY; the same failure exists in the new data. Read `warna` and `name`; the `batch_warna` branch is dropped (no such field). |
| Merek | `brand` | **ST-R8, implemented.** `<option value="">Semua merek</option>` + the distinct **merek labels present in the current `/summary` response**, sorted `id` collation. Keyed on the label (§1.6), never on the raw id, and **never a hardcoded list** — Alcopan, Maco and Tajima are values the catalogue happens to hold today, not an enum. Exact match via `eq()`, same as `Warna`. Items with no merek are simply not in the option list and are hidden whenever the filter is set. Persisted `stk_brand`; a stored merek that has left the catalogue resets to "" on the next `syncFilterOptions()` rather than emptying the table. |
| Kode barang | `kode` | `<option value="">Semua kode barang</option>` + distinct `kode_barang`, sorted. The placeholder says "kode barang" in full because "Semua kode" beside a live `Semua merek` reads as the merek select — see §11-A1. |
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
| Warna | `<b>{colour label, §1.6}</b>` + `.sub2` = `{merek, §1.5} · {kode_barang} · {th} · {p}×{l}` | left |
| Bisa Dijual | `.atp` block per §2.2 | right |
| Status | state chip (short label) + `.atp-note` when `habis`/`perlu_produksi` | right |

`th` header row: `KODE · WARNA · BISA DIJUAL · STATUS`.

Mobile (≤559px) — the `<table>` is replaced (not scrolled) by stacked cards:

```html
<div class="itemrow" role="button" tabindex="0" aria-label="ACP 4mm Black Galaxy, bisa dijual 3.849 lembar, Tersedia">
  <div style="display:flex;gap:10px;justify-content:space-between;align-items:flex-start;padding:12px 14px;border-bottom:1px solid var(--line);min-height:var(--tap)">
    <div style="min-width:0">
      <b>Black Galaxy</b>
      <div class="sub2"><b class="mk">Alcopan</b> · ACP-4MM · 0,3 · 4.880×1.220</div>
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

**Where the merek sits, and why it is not the bold lead.** A rep identifies a
product roughly *merek → warna → ukuran*, so the obvious move is to promote the
merek to the `<b>`. Do not. The colour is what the list is **sorted** by
(`Warna A–Z` is the default), what `rankOf()` ranks a search by and what the
`tail()` tie-break chain is anchored on; a bold lead that does not match the sort
key makes a 812-row list unscannable. The merek instead **leads the `.sub2` line
directly beneath the colour**, in `.mk` (`--ink-2`, 700) so it is the anchor of
that line rather than another grey token. That is where the eye goes second, and
it is precisely the job the merek does here: telling apart two rows that share a
colour. The two toolbar selects then read left-to-right in the same order the
line does — `Merek`, then `Kode Barang`.

A merek that is byte-identical to the `kode_barang` prints once, not twice (the
server's own `composeName()` falls back `brand_text ?? brand ?? kode_barang`, so
they can coincide). When there is no merek the line simply starts at the
`kode_barang`; nothing is reserved and no separator is left dangling.

`.sub2` carries `overflow-wrap:anywhere` on both pages: the line now holds two
ERP-supplied identifiers, and an unbroken one must break rather than push the
380px row sideways (§8.3).

Row tap → detail sheet (§5.3). The whole row is the target; there is no separate
button, because there is no second action to disambiguate from.

### 5.3 Detail sheet (ST-R13) — `GET /api/stock/sku/:sku_key`

Inherited `.modal-bg` / `.modal` bottom sheet. Opens on row tap, `ESC` and the
`Tutup` button close it, focus returns to the row (§9.3).

The **heading** carries the full product identity — `{merek} {warna}`, space-
joined in the server's own `composeName()` idiom — because this is the one line
a rep reads back down the phone, and a colour alone names several products. The
heading therefore carries the merek and the `.mp` spec line below it does
**not** repeat it. Falls back to the colour alone, then to the `sku_key`.

```
h3   Alcopan Black Galaxy          ← {merek} {warna}; the merek is omitted when absent
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

Field mapping, **frozen by CONTRACTS AMENDMENT 3** — use these names, do not
alias: the numbers block reads `item`; `Pesanan Aktif` reads `live_commitments`;
`Pesanan Lama` reads `stale_commitments`; `Penyesuaian` reads `adjustments`; the
optional per-serial breakdown reads `on_hand_rows`. Every array is always
present and `[]` when empty, so render an empty section as its §7.2 empty line,
never as a missing section. Fetch with `encodeURIComponent(sku_key)`
(AMENDMENT 5).

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
| SKU | `<b>{colour label, §1.6}</b>` + `.sub2` `{kode_barang} · {th} · {p}×{l}` |
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
| ☐ | — | bulk checkbox, ≥560px only, ETA Lewat segment only (§6.8, §8.2) |
| SKU | colour label (§1.6) bold + `.sub2` `{merek, §1.5} · {kode_barang} · {th} · {p}×{l}` | links to the detail sheet. `CommitLine` carries **no `kode_barang`** (AMENDMENT 19), so on this tab the line normally starts at the merek — which is exactly why the merek must be rendered and not inferred. Merek in `.mk`; the colour keeps the bold lead for the same reason as §5.2. |
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

> **No `Merek` filter on this tab, and that is a decision, not an omission.**
> The merek *renders* here (it leads the SKU cell's spec line, §6.2.2) because
> reading it is what triage needs. Filtering by it is a different thing: this
> queue is **server-paged** — page 1 of ~4,158 — and a client-side merek filter
> would silently filter 50 rows out of 4,158 while looking exactly like a filter
> over the whole queue. That is the trap §11-A11 already names for client-side
> sorting here, and it is worse for a filter, because an empty result reads as
> "no such merek in the queue" rather than "none on this page".
> `/stale-commitments` takes `segment`, `q`, `status`, `only_do`,
> `min_age_days`, `sku_key`, `page`, `limit` (AMENDMENT 8) and **no merek
> parameter**. Until one exists the honest control is the one already there:
> `q` searches the merek, because the server's `q` matches
> `coalesce(brand_text, brand, '')`. **Gap raised, not worked around:** a
> `brand=` parameter on `/stale-commitments` and `/exceptions` would make this
> one select, built exactly like `/stock`'s.
>
> Tab 1 (Kekurangan) has no filters at all by §6.1 and gains none here; it is a
> short, server-ranked list where a merek filter buys nothing.



Rendered as a `.fltchips` row plus a compact form. All filter state goes in the
query string of the request; none of it is client-side (4,158 rows are never all
in the browser).

| Control | Param | Options |
|---|---|---|
| Search | `q` | `placeholder="Cari merek / SKU / customer / No. SO…"`. Debounce 350ms, min 2 chars. The server's `q` matches `coalesce(brand_text, brand, '')` on both `/stale-commitments` and `/exceptions`, so naming the merek here is true, not aspirational — and it is the only merek-shaped control this tab honestly has (see the note above). |
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
Umur row: `Yang sudah ditutup`. It sets `segment=closed` on the request and renders
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

---

## 8. Responsive strategy

Mobile-first at **380px** (`CONTRACTS §6`). Two breakpoints only — the inherited
CSS already uses 560px for the modal, so reuse it rather than inventing a scale.

| Range | Name | Who |
|---|---|---|
| ≤559px | **phone** | sales reps (primary), PPIC supervisor checking in (secondary) |
| 560–959px | **tablet / small laptop** | |
| ≥960px | **desk** | PPIC (primary) |

`.wrap` stays at the inherited `max-width` (960px on `/stock`, 1000px on
`/stock-ppic`) with 16px side padding. Never let the page body scroll
horizontally; only the containers named below may.

### 8.1 `/stock` — phone-first

| Element | ≤559px | ≥560px |
|---|---|---|
| Item list | **Stacked cards** (§5.2). The `<table>` is not rendered at all — a four-column table at 380px either truncates the colour name or shrinks the ATP number, and both defeat the page. | Inherited `<table>` inside `.scrollx` |
| Toolbar | Search full width on its own row; the selects pair two-per-row via the inherited `flex:1 1 46%`; checkboxes on their own row. Exactly the 1.0 behaviour. | one row, wrapping |
| Totals strip | `.counts` wraps to 2–3 rows of `.countchip`. Nothing is dropped — the four state counts are the page's summary. | one row |
| Banner / offbox | full width, above everything | same |
| Detail sheet | bottom sheet, `border-radius:16px 16px 0 0`, `max-height:92vh` (inherited) | centred modal (inherited ≥560px rule) |
| Header | `h1` + freshness stack; `PPIC ↗` stays on the right, `white-space:nowrap` | same |

The ATP block never shrinks below 22px. If a five-digit number plus unit
overflows at 380px, the unit wraps to a second line — the number does not
shrink and never truncates.

### 8.2 `/stock-ppic` — desk-first, phone-survivable

| Element | ≤559px | 560–959px | ≥960px |
|---|---|---|---|
| Tab strip | horizontally scrollable `.tabs` with `scroll-snap`, active tab scrolled into view on load | same | all five fit, no scroll |
| Every data table | `.scrollx` horizontal scroll with **sticky first column** (`position:sticky;left:0;background:var(--card);z-index:1`) so the SKU stays anchored | `.scrollx` | full width |
| Columns dropped (Tinjau Pesanan) | none — the table scrolls instead. Dropping `Customer` or `Sisa Pesanan` on a phone would make a triage decision impossible, and a triage decision made on partial information is worse than one deferred. | none | none |
| Bulk select | **not offered** — no checkbox column, no bulk bar (§6.8) | offered | offered |
| Undo tray | offered, collapsed by default with `Baru Ditutup (3) ▾` | offered | offered |
| Pager | `←` / `Hal. 1/84` / `→` | full | full above + below |
| Penyesuaian form | fully stacked, one field per row; the `− / + / qty` triple stays on one row | stacked | two columns (form left, audit right) at ≥960px |
| Sinkronisasi cards | stacked | stacked | 3-up grid |
| Inline confirm expander (§6.6.2) | full-width row, buttons stacked full-width, `min-height:var(--tap)` | inline | inline |

**Not offered on a phone, deliberately:** bulk selection and bulk close; the
`Salin semua` bulk copy on Belum Cocok (clipboard of 31 keys is a desktop
workflow); the side-by-side Penyesuaian layout. Nothing else is removed — a
supervisor must be able to read every number and close a single row from the
plant floor.

### 8.3 Rules that hold at every width

- Touch targets ≥ `var(--tap)` (§9.1) at **all** widths, not just phone. PPIC
  works with a mouse but also on a 13" touchscreen laptop.
- Sticky `header` never exceeds 68px tall; the tab strip is **not** sticky
  (two stacked sticky bars eat a phone screen).
- The bulk bar (§6.8) is `position:sticky;bottom:0` — the only bottom-sticky
  element, and it exists only while a selection exists.
- Tables never use `table-layout:fixed`; Indonesian customer names need to wrap.
- No `min-width` greater than 320px on any element.

---

## 9. Accessibility

### 9.1 Touch targets

The inherited `select`/`input`/`textarea` rule already sets `min-height:44px`.
These do not:

| Inherited | Current | Required |
|---|---|---|
| `button.btn` | 40px | 44px on every **row action and primary action** → add `.tap` |
| `button.mini` | 34px | 44px in the stale queue, undo tray and pager → `.mini.tap` |
| `.chkline` | already 44px | unchanged |
| `.banner button` (×) | ~20px | removed entirely (§4.2) |
| `.fchip` | ~30px | 44px via `.tab`/`.fchip` min-height in §1.3 |

`.mini` without `.tap` survives only inside the archive modal, which sales no
longer opens. Row actions in a 4,158-row list are tapped thousands of times; 34px
is a mis-tap that closes the wrong commitment.

### 9.2 Contrast — computed against the inherited palette

sRGB relative luminance, WCAG 2.1 formula. AA normal text = 4.5:1; AA large
(≥24px, or ≥18.66px bold) = 3:1; non-text UI = 3:1.

| Foreground | Background | Ratio | Verdict |
|---|---|---|---|
| `--ink` | `--card` | **15.67** | AAA |
| `--ink` | `--bg` | **14.22** | AAA |
| `--muted` | `--card` | **4.83** | AA — passes, with no margin |
| `--muted` | `--bg` | **4.39** | ✗ **FAILS AA** |
| `--muted` | inherited header ground (§1.1b) | **4.67** | AA |
| `--ink-2` (added) | `--card` | **7.58** | AAA |
| `--ink-2` | `--bg` | **6.88** | AAA |
| `--accent` | `--card` | **5.38** | AA |
| `--card` | `--accent` (button text) | **5.38** | AA |
| `--danger` | `--card` | **5.35** | AA — and the ATP number at 22px/800 is "large", needing only 3:1 |
| `--danger` | `--bg` | **4.86** | AA |
| `--card` | `--danger` (danger button) | **5.35** | AA |
| `--ok-ink` | `--ok-bg` (`tersedia` chip) | **4.57** | AA |
| `--warn-ink` | `--warn-bg` (`habis` chip) | **4.51** | AA — the tightest pass in the system |
| `--neg-ink` | `--neg-bg` (`perlu_produksi` chip) | **5.30** | AA |
| `--neutral-ink` | `--neutral-bg` (`kosong` chip) | **6.87** | AAA |
| inherited `.chip.age` ink on its ground (§1.1b family) | | **4.39** | ✗ **FAILS AA** — the reason `--neutral-ink` exists |
| `--warn-ink-strong` | `--warn-bg` (stale banner) | **6.39** | AAA |
| `--offline-ink` | `--offline-bg` | **9.15** | AAA |
| `--age-old-ink` | `--age-old-bg` | **6.38** | AAA |
| `--age-ancient-ink` | `--age-ancient-bg` | **5.30** | AA |
| inherited header-sub ink (§1.1b) | `--ink` | **10.01** | AAA |
| inherited `.pplink` ink (§1.1b) | `--ink` | **11.01** | AAA |
| `--card` on the inherited `.toast.ok` ground (§1.1b) | | **7.13** | AAA |
| `--card` on the inherited `.toast.warn` ground (§1.1b) | | **5.02** | AA |
| `--card` on `--danger` (`.toast.err`) | | **5.35** | AA |
| `--card` on `--ink` (`.toast`) | | **15.67** | AAA |
| `--focus` | `--card` | **6.70** | far above the 3:1 non-text minimum |
| `--focus` | `--bg` | **6.08** | ditto |

**Two consequences are binding:**

1. **`--muted` may never be used for text on `--bg`.** It fails at 4.39:1. In
   practice that means: no caption, helper line, `.metaline` or `.foot` may sit
   directly on the page ground — put it inside a `.card` (white) or use
   `--ink-2`. The inherited `.foot` and `.metaline` rules are `--muted`; on both
   new pages they are only ever rendered **inside** `.card`, which is white.
   Check this in review; it is the easiest rule here to break by accident.
2. **`.chip.age` is not used on any new surface.** `.chip.umur` replaces it
   everywhere. The inherited rule stays for the archive modal only.

`--line` on `--card` is 1.24:1 — far below 3:1, but table rules and card borders
are decorative separators, not the sole carrier of any meaning, so 1.4.11 does
not bite. The one place it would is the offline box and the stale banner, whose
tinted grounds are ~1.1:1 against `--card`; both therefore carry a 1px border
(`--offline-line`, `--warn-line`) **and** state their meaning in text. Do not
remove those borders.

### 9.3 Focus

- `:focus-visible` ring defined in §1.3 — 3px `--focus`, 2px offset. On the dark
  header it flips to `--card`. There is currently **no** focus style in the
  inherited CSS; this is the addition that makes both pages keyboard-usable.
- **Focus order** follows DOM order, and DOM order follows reading order:
  header → banner/offbox → (PPIC: actor field → tab strip) → toolbar/filters →
  result count → table rows → pager. No `tabindex` above 0 anywhere.
- **Card rows** on the phone layout are `role="button" tabindex="0"` and respond
  to `Enter` and `Space` as well as click.
- **Tab strip**: `role="tablist"`, arrow-key navigation (`←`/`→` move, `Home`/
  `End` jump), roving `tabindex` (active tab `0`, others `-1`), `Enter`/`Space`
  activates. `aria-selected` on the active tab; the panel carries
  `aria-labelledby` pointing at it.
- **Modals and the bottom sheet**: on open, focus moves to the `<h3>`
  (`tabindex="-1"`); `Tab` cycles within the sheet; `Esc` closes; on close focus
  returns to the element that opened it. Background gets `inert` where supported,
  else `aria-hidden="true"`.
- **The inline confirm expander** (§6.6.2): focus moves to the reason input on
  open; `Esc` collapses and returns focus to the `Tutup` button that opened it.
- **A failed write returns focus** to the control that failed (§7.8), so a
  keyboard user is not left focused on a button that vanished.
- **Never move focus on a poll.** Ever. (§6.9.)

### 9.4 Screen-reader announcements when a poll changes numbers under the user

One polite live region per page, the last element in `<body>`:

```html
<div id="srlive" class="sr-only" aria-live="polite" aria-atomic="true"></div>
```

Rules — deliberately quiet, because a 30s poll that narrates itself is unusable:

| Event | Announcement | Throttle |
|---|---|---|
| Poll succeeds, nothing visible changed | *silence* | — |
| Poll succeeds, N visible ATP values changed | `Data ERP diperbarui pukul 14:05. 3 angka berubah.` | at most once per 60s |
| A row the user is focused on changed | `Black Galaxy sekarang 3.837 lembar, Tersedia.` — announced instead of the generic message | immediate |
| `freshness.stale` becomes true | `Peringatan: data ERP belum diperbarui sejak 11:42.` | once per transition |
| `freshness.stale` becomes false | `Data ERP sudah diperbarui.` | once per transition |
| `erp_connected` becomes false | `ERP tidak terhubung.` | once per transition |
| Write succeeds / fails | the toast text, mirrored into `#srlive` | per action |
| Page/filter change loads | `Menampilkan 50 dari 1.204 baris.` | per load |

- The banner is `role="status"` (implicit `aria-live="polite"`); do **not** also
  push its text into `#srlive` — it would be read twice.
- Toasts are **not** `aria-live` themselves; they are mirrored into `#srlive` so
  there is exactly one announcement channel and no double-reads.
- `aria-live` is never placed on the table, `<tbody>`, or any row container. A
  polite region on a 50-row table announces the entire table on every poll.
- The visual delta flash (`.f-up`/`.f-dn`) and the announcement are driven by the
  same diff, so a sighted and a screen-reader user learn the same fact.

### 9.5 Not by colour alone

Every state carries a word (`Tersedia`, `Habis`, `Kosong`, `Perlu Produksi`).
Every negative number carries a `−`. The delta flash is accompanied by the
number actually changing. The `Tutup` variant is distinguished by button label
and by an inline confirm, not only by button colour. A user with full
achromatopsia loses nothing on either page.

### 9.6 The rest

- `<html lang="id">` — inherited, keep it. Do not add `lang="en"` to any label.
- Every `<table>` gets a `<caption class="sr-only">` naming it
  (`Daftar stok per SKU`, `Antrean pesanan dengan ETA lewat`).
- Every icon-only or glyph element (`⚠️`, `🔌`, `←`, `→`, `×`) is
  `aria-hidden="true"` with the meaning in adjacent text or `aria-label`.
- Every form control has a real `<label for>`; placeholders are never the label.
- Numbers use `font-variant-numeric:tabular-nums` so columns align and a magnifier
  user can compare rows down the column.
- `prefers-reduced-motion` is honoured by the inherited rule; it disables the
  skeleton pulse, the delta flash, the toast entrance and the spinner animation.
  The spinner must therefore also carry text (`Menutup…`), never spin alone.
- Zoom to 200% at 380px must not clip anything: no fixed heights on text
  containers, no `overflow:hidden` on a row.

---

## 10. Removals — gone from the DOM, not hidden

Both developers must be able to `grep` their finished file and find **zero**
hits for each token below. `display:none`, `hidden`, a CSS class, or a commented-
out block are all failures: a hidden booking form is still a booking form to a
screen reader, to a keyboard user, and to anyone who opens devtools.

### 10.1 `/stock` (WP-5)

| Removed | grep for |
|---|---|
| Rep picker (the `Atas nama (sales)` select + free-text fallback) | `repSel`, `repFree`, `repFreeWrap`, `selectedRep`, `loadReps`, `onRepChange`, `REPS`, `/api/sales-reps`, `optgroup` |
| `stk_rep` persistence | `stk_rep` — and add `localStorage.removeItem("stk_rep")` on boot so a rep's old name is not left behind in their browser |
| Booking modal + qty field | `bkBg`, `bkModal`, `bkQty`, `openBooking`, `data-book`, `＋ Booking`, `POST /api/stock/bookings` |
| "Booking Saya" card | `mineCard`, `mineBody`, `mineCount`, `loadMine` |
| Cancel-booking action | `/cancel`, `batalkan booking` |
| Riwayat (booking history) modal | `rwBg`, `rwModal`, `openRiwayat`, `/items/:id/riwayat` — **replaced** by the §5.3 SKU detail sheet, which is a new component, not a renamed one |
| Overbooked badge + the "Hanya overbooked" checkbox | `.badge`, `OVERBOOKED`, `onlyOver`, `overbooked` |
| Booking status labels | `STLABEL`, `confirmed`, `overbooked`, `approved`, `rejected`, `cancelled`, `completed`, `outstanding` |
| The old advisory banner + its dismissal | `stk_banner_x`, `bannerX`, `wajib konfirmasi ulang ke tim PPIC` |
| `upload`-shaped freshness (`SUMMARY.upload`, filename in the header) | `SUMMARY.upload`, `filename` |

### 10.2 `/stock-ppic` (WP-6)

| Removed | grep for |
|---|---|
| **Excel upload control** and its whole parsing stack | `<input type="file"`, `id="file"`, `accept=".xlsx"`, `XLSX`, `cdnjs.cloudflare.com`, `preview`, `parseErr`, `looksLikeHeader`, `headerScore`, `KNOWN`, `NAME_HDRS`, `QTY_HDRS`, `POST /api/stock/uploads` |
| — including the `<script src>` tag pulling SheetJS | the page must load **zero** external scripts; `CONTRACTS §6` says no dependency |
| End-of-day export + "Buat Stock Check Baru" | `expEod`, `genCheck`, `Akhir Hari`, `Export Laporan` |
| Verify queue (approve / reject) | `vqBody`, `vqCount`, `data-approve`, `data-reject`, `verify(`, `Setujui`, `Tolak`, `.btn.approve`, `Antrean Verifikasi` |
| Booking Outstanding + **Penuhi** | `outBody`, `outCount`, `data-fulfil`, `Penuhi`, `fulfilled_item_id`, `/fulfill` |
| **LAMA long-booking tracker** | `trackBody`, `Tracker Booking`, `chip.lama`, `b.long`, `active_long`, `LAMA` |
| "Semua Booking" list + its status filter chips | `allBody`, `stFilters`, `DEDUCTING_SET` |
| Upload history + archive panel | `histBody`, `archivePanel`, `Riwayat Upload` |
| `complete` / `cancel` booking actions | `/complete`, `/cancel` |

### 10.3 What is kept

- `#actor` (`Petugas PPIC`) and `stk_actor` persistence — still required; every
  write records an actor (`CONTRACTS §7.8`).
- The `PPIC ↗` / `Halaman Sales ↗` cross-links in both headers.
- `stk_sort` persistence on `/stock`.
- Every inherited helper: `$`, `esc`, `NF`, `wib`, `wibShort`, `dur`, `ageSec`,
  `toast`, `eq`, the modal open/close pattern, the 30s poll, the 60s age tick.
- The archive **endpoints** stay readable server-side (ST-R14). Neither page
  calls them. If someone later wants the frozen booking history on screen, that
  is a new, separately specified surface — not a revived card.

---

## 11. Register of Blueprint gaps — what this spec assumed, and why

`CONTRACTS §4.1` freezes **only** the `/summary` response. Every other endpoint
in §4.2 is named by purpose, not by shape. Two developers building blind against
"ST-R18 review queue. Filter/paginate." will invent two different field sets.
Since this spec was drafted the Architect has frozen three of those gaps —
**AMENDMENT 3** (the `/sku/:sku_key` body), **AMENDMENT 4** (`page`, `limit`, `q`
and a total on *all four* list endpoints, `limit` capped server-side) and
**AMENDMENT 5** (`sku_key` travels as `encodeURIComponent(sku_key)` in a path
segment). Those three are contract; everything else below is still proposal.

**AMENDMENT 5 is a client obligation and easy to miss:** a `sku_key` contains
`|` and `.`, so *every* place either page puts one in a URL must encode it —
the detail-sheet fetch, the `#lama:stale?sku=…` deep link from §2.2, and the
`?sku_key=` filter on the adjustment audit list.

The shapes below are what this spec's screens are drawn against. **They are
proposals, not contract.** The Architect ratifies or corrects them; wherever they
are corrected, only the render function changes — no layout in this document
depends on a field name.

### 11.1 Assumed response shapes — PROPOSED, awaiting ratification

```jsonc
// GET /api/stock/shortfall            → ranked server-side, no paging (small)
{ "items": [{ "sku_key":"…", "name":"…", "kode_barang":"…", "warna":"…",
              "th":0.3, "p":4880, "l":1220, "unit":"lembar",
              "on_hand":100, "committed":1330, "adjustment":0,
              "atp":-1230, "deficit":1230,
              "nearest_eta":"2026-09-20", "so_line_count":7 }],
  "total": 12 }

// GET /api/stock/stale-commitments
//   ?segment=stale|undated|closed &q= &status= &only_do= &min_age_days=
//   &sku_key= &page=1 &limit=50
{ "rows": [{ "so_line_id":"…", "sku_key":"…", "name":"…",
             "kode_barang":"…","warna":"…","th":0.3,"p":4880,"l":1220,
             "unit":"lembar", "qty_balance":1200,
             "so_number":"SO-2020-0912", "customer_name_text":"PT …",
             "sales_name_text":"…", "estimate_delivery":"2020-08-27",
             "po_date":"2020-07-01", "status_order":"DO",
             "undated": false,                    // AMENDMENT 1
             "override_state": null,              // null | "closed" | "reinstated"
             "closed_at": null, "closed_by": null, "closed_reason": null }],
  "page":1, "limit":50, "total":4158, "total_unfiltered":4158,
  "facets": { "status_order": ["DO","Waiting","Proses"] },   // optional
  "counts": { "stale":4158, "undated":27 } }

// GET /api/stock/exceptions
{ "rows": [{ "so_line_id":"…", "sku_key":"…", "kode_barang":"…","warna":"…",
             "th":null,"p":4880,"l":1220, "qty_balance":120, "unit":"lembar",
             "so_number":"…", "customer_name_text":"…",
             "estimate_delivery":"2026-10-01",
             "reason":"no_fg_row" }],            // no_fg_row | uom_mismatch | incomplete_key
  "total":31, "total_qty":4120 }

// GET /api/stock/sku/:sku_key   ← FROZEN by CONTRACTS AMENDMENT 3. Use these
//    names exactly: `item`, `live_commitments`, `stale_commitments`,
//    `adjustments`, `on_hand_rows`. Every array always present, [] when empty.
//    Undated live lines arrive inside `live_commitments` with undated:true —
//    which is what §5.3 renders. Do NOT write alias-tolerant readers.

// GET /api/stock/adjustments?page=&limit=&q=      ← paging FROZEN by AMENDMENT 4
{ "rows":[{ "id":"…","sku_key":"…","name":"…","qty_delta":-12,
            "reason":"…","actor":"…","created_at":"…" }],
  "page":1,"limit":50,"total":… }

// GET /api/stock/sync-status
{ "erp_connected":true, "stale":false, "last_ok_at":"…", "interval_ms":180000,
  "tables":[{ "table_name":"live_fg","cursor_value":"…","last_ok_at":"…",
              "last_error":null,"last_error_at":null,"rows_synced":1464,
              "running":false }] }

// POST /api/stock/sync
{ "started": true,  "running": false }     // or { "started": false, "running": true }

// POST …/close  ·  POST …/reinstate
{ "ok": true, "so_line_id":"…", "state":"closed",
  "atp_delta": 1200,        // 0 for a stale line; qty_balance for an undated one
  "sku_key":"…", "atp": 5049 }
```

`atp_delta` on the close/reinstate response is what lets §6.6.2's success toast
and the undo tray state the consequence truthfully. If the Architect will not
return it, the client must compute it as `undated ? qty_balance : 0`, which is
correct today but becomes a lie the moment the liveness rule changes — so it is
worth the field.

### 11.2 Named gaps

| # | Gap | This spec's assumption | Cost if the Architect rules otherwise |
|---|---|---|---|
| **A1** | ~~**The §4.1 `item` has no brand field, but ST-R8 requires "search/filter by brand".**~~ **RESOLVED — the premise is false.** CONTRACTS AMENDMENT 19 rekeyed the SKU on `brand \| warna \| th \| th_panel \| p \| l`, so `brand` and `brand_text` are on `SkuItem` *and* on `CommitLine`, and `CommitLine` has no `kode_barang` at all. | **ST-R8 is built** (§5.1): a second select, `Merek`, whose options are the merek labels present in the current response. The old rationale — *label it "Kode barang" because there is no brand field* — no longer holds and must not be cited; the two controls now sit side by side and each says in full what it filters. **What still holds is the ban on guessing**: `kode_barang` (`ACP-4MM`) conflates merek, lini produk and tebal panel, and no client-side prefix rule may split it. A merek is read from `brand_text`, then `brand`, and otherwise **not rendered at all**. | — |
| **A2** | No `coating` field; 1.0 had a coating filter. **Now carried in CONTRACTS as an open product question.** | The coating select is **deleted**. | If PPIC wants it back it needs a field on `erp_live_fg` and on the item — a product answer, not a workaround. |
| **A3** | `/stale-commitments` has no documented way to list rows already confirm-closed. Without it, the only undo path is the in-session tray, which dies on reload. | `?segment=closed` (§11.1). | Without it, delete the `Yang sudah ditutup` chip (§6.7) and say plainly in the tray footer that a reload makes a close unrecoverable from the UI. That is a materially worse product; I would not ship it. |
| **A4** | `reason` on `close` is in the body but not marked required (it *is* marked required for adjustments). | Optional on the ETA Lewat segment (auto-composed), **mandatory** on Tanpa ETA and on bulk (§6.6, §6.8). | If made mandatory everywhere, the ETA Lewat one-tap becomes the §6.6.2 inline expander. ~15 lines, no layout change — but triage throughput drops by roughly an order of magnitude on a 4,158-row queue. |
| **A5** | No bulk close endpoint. | 50 sequential `POST`s, concurrency 4, cancellable, partial-failure report (§6.8). | See CHALLENGE-1. |
| **A6** | Nothing says whether a sales rep may see *which customer* holds a commitment. | `/stock` shows ETA + qty + `sales_name_text`; `customer_name_text` is PPIC-only. | If sales may see it, add one column — but this is a commercial-confidentiality call, not a UI call, and it should be made deliberately rather than by whichever developer writes the row first. |
| **A7** | `/exceptions` is read-only; there is no endpoint to resolve, map or dismiss an exception. | The tab is a report with `Salin Kode SKU` (§6.10). | A resolve flow is a new screen, not a button. |
| **A8** | `summary.totals` has no `shortfall` count and no `undated` count, so two tab badges cannot be filled from the poll. | Kekurangan badge renders `—` until its own fetch lands; Tinjau Pesanan badge adds `counts.undated` from §11.1. | Two integers in `totals` would remove a visible inconsistency (four badges populated instantly, one lagging). |
| **A9** | `nearest_eta` is undefined as to *which* population it comes from — nearest live commitment, or nearest incoming supply (PRD §9 explicitly defers incoming). | Nearest **live commitment** ETA. Labelled `ETA Terdekat` and, on a `habis` row, phrased `ETA terdekat 20 Sep` with no promise attached. | If it ever becomes an incoming-supply date, the copy must change to `Perkiraan masuk` — the two mean opposite things to a rep and must never share a label. |
| **A10** | ~~Paging/filter param names unspecified.~~ **RESOLVED by AMENDMENT 4** — `page`, `limit`, `q` on all four lists, server-capped `limit`. | Use them. The §6.4 pager is unchanged; it already assumed exactly this. | — |
| **A11** | Sorting on `/shortfall` is fixed server-side; no contract for client sorting on any list. | No sortable column headers anywhere on PPIC. | If sorting is wanted, it must be server-side and paged; client sorting of one page of 50 out of 4,158 is a trap that looks like it works. |

### 11.3 `[CHALLENGE: Architect]` — CHALLENGE-1: no bulk close endpoint

**The decision:** `CONTRACTS §4.2` exposes confirm-close only as
`POST /api/stock/stale-commitments/:so_line_id/close` — one line per request.

**The user experience it forces.** PPIC's opening position is ~4,158 stale lines,
of which the PRD says ~95% are phantoms back to 2020 (PRD §5A). Clearing them one
HTTP request at a time means: at 50 per page and ~250ms per request, a page takes
~3s of sequential traffic and a full pass takes 84 pages. The failure mode is not
slowness, it is **partial state** — a bulk of 50 that fails at row 31 leaves 30
closed, 1 in-flight and 19 untouched, and every one of those outcomes has to be
reported, recovered and undone individually. §6.8 designs that honestly (progress
counter, cancel, `20 berhasil, 3 gagal`, retry-failed), but a partial-failure
report is a symptom of a missing transaction, not a feature.

It also makes the safest bulk action unavailable. The highest-confidence set —
`status_order = 'DO'` with `qty_balance > 0`, i.e. the ERP's own
"delivered but never closed" rows (ST-R22) — is a single well-defined predicate.
It is exactly the thing PPIC should be able to clear in one audited action with
one reason, and exactly the thing 84 pages of clicking will guarantee never gets
finished.

**What I am asking for** (either is enough):

- `POST /api/stock/stale-commitments/close-batch` `{ so_line_ids[], actor, reason }`
  → `{ closed: [], failed: [{ so_line_id, error }] }`, applied in one
  transaction, capped at 200 ids. §6.8's UI is unchanged; it simply stops being a
  partial-failure narrator. **Or**
- `POST /api/stock/stale-commitments/close-filtered` `{ filter, actor, reason, expected_count }`
  → closes everything matching the current server-side filter, refusing if the
  live count no longer equals `expected_count`. This is the one that actually
  solves the 4,158-row problem, and `expected_count` is what makes it safe.

**Until then**, §6.8 stands as specified and I have deliberately capped selection
at one page (50). I would rather the queue take a week than ship a control that
can half-close 1,200 commitments with no transaction behind it.

### 11.4 `[CHALLENGE: Architect]` — CHALLENGE-2: `/summary` returns every SKU, unfiltered

`GET /api/stock/summary` takes no query parameters and returns every SKU with its
`items[]` array (§4.1). At the stated 812 SKUs, polled every 30s per rep, that is
fine. It stops being fine quietly: FG-only today (PRD §10 defers RM), aggregated
across warehouses today (OQ-2), and a `lokasi` dimension or an RM phase multiplies
the row count. A rep on a plant-floor 3G connection re-downloading a growing
payload every 30 seconds degrades without any visible symptom except the page
feeling slow.

Not a blocker, and I am not asking for it in v1 — but the moment either OQ-2 or
the RM phase lands, `/summary` needs `?q=&state=&limit=` and `/stock` needs its
toolbar moved server-side. Worth writing into the assumption log now, while the
decision is cheap, rather than discovering it as "the stock page got slow".

---

## 12. Build checklist

Tick these before calling either page done. They are the things this spec exists
to prevent, in the order they are usually got wrong.

**Both pages**
- [ ] Inherited `:root` copied byte-identical; the added block is a *second*
      `:root`; no inherited declaration edited or deleted.
- [ ] `grep -oE '#[0-9a-fA-F]{3,6}' page.html` returns hits **only** inside the
      two `:root` blocks and the inherited rules copied verbatim from 1.0.
- [ ] No external `<script src>` and no webfont.
- [ ] Every user-visible string appears in this document.
- [ ] `item.state` is rendered, never recomputed from the numbers.
- [ ] No `Math.max(0, …)`, no `Math.abs()` on an ATP headline, no `|| 0` that
      could swallow a negative.
- [ ] Negative numbers use `−` (U+2212).
- [ ] The **five** connection conditions render with the §4 precedence and never
      two at once: disconnected ▸ rejected ▸ sync-failing ▸ stale ▸ freshness
      line. On `/stock`, §4.6's line is last of all and yields to every one of
      them.
- [ ] No colour renders as a bare number anywhere (§1.6). `grep -n '\bi\.warna\b'`
      returns hits only inside the resolver and the search haystack.
- [ ] §4.4 offers **no** retry affordance, on either page.
- [ ] A poll never re-renders through an open modal, a focused input, or a list
      the user is touching.
- [ ] `#srlive` exists, is polite, and is silent on a no-change poll.
- [ ] Every `sku_key` in a URL is `encodeURIComponent`'d (AMENDMENT 5) — detail
      fetch, deep links, audit filter.
- [ ] `.fltchips` / `.fchip` are byte-identical on both pages and match §1.3;
      `.fchip.on` no longer exists anywhere.
- [ ] `/sku/:sku_key` is read with the AMENDMENT 3 names; no alias-tolerant
      reader remains.
- [ ] `:focus-visible` is visible on every interactive element, including on the
      dark header.
- [ ] Every row action is ≥44px tall.
- [ ] No `--muted` text sits on `--bg`.
- [ ] 380px: no horizontal body scroll; 200% zoom clips nothing.
- [ ] Renders correctly against: empty ERP, stale ERP, disconnected ERP,
      populated ERP, DB-503, network failure mid-session.

**`/stock`**
- [ ] Every grep token in §10.1 returns zero hits.
- [ ] `localStorage.removeItem("stk_rep")` runs on boot.
- [ ] The page issues **no** `POST` of any kind.
- [ ] "Sembunyikan yang kosong" cannot hide a `perlu_produksi` row.
- [ ] At 380px the list is stacked cards, not a scrolled table.

**`/stock-ppic`**
- [ ] Every grep token in §10.2 returns zero hits — especially `XLSX`,
      `type="file"` and `Penuhi`.
- [ ] The Tinjau Pesanan tab has two segments and the Tanpa ETA segment's close
      is an inline confirm with a mandatory reason (§6.6.2).
- [ ] No affordance anywhere selects more than one page of rows.
- [ ] Bulk close reports partial failure per row and never silently drops one.
- [ ] The undo tray survives tab switches and tells the truth about reload.
- [ ] Belum Cocok contains none of: `error`, `gagal`, `tidak valid`, `rusak`,
      `masalah`.
- [ ] `Merek` renders from `brand_text` → `brand` → `Kode merek {code}`, and
      renders **nothing** when both are absent — no em dash, no guess from
      `kode_barang`. Both pages, row and detail sheet.
- [ ] The `/stock` `Merek` select lists only values present in the current
      response. **Grep for `Alcopan`, `Maco`, `Tajima` in both HTML files: zero
      hits.** A hardcoded brand list is the defect this control exists to avoid.
- [ ] `stk_brand` survives a reload, and a stored merek that has left the
      catalogue resets to "" instead of emptying the table.
- [ ] Every write is blocked without `#actor`, and disabled when
      `erp_connected === false`.
- [ ] Adjustments: `reason` < 4 chars and `qty_delta === 0` are both blocked
      client-side *and* handled when the server rejects them.

---

## Superseded by CONTRACTS amendments — read the contract, not these paragraphs

Two passages in §6 were written before the contract was amended and are now
wrong. They are left in place rather than silently rewritten, because a reader
who remembers them needs to know they changed:

- **§6.7** described listing already-closed rows via `state=closed`. The ratified
  parameter is `segment=closed` (AMENDMENT 8). One enum, three values —
  `stale` · `undated` · `closed` — replaces the earlier booleans.
- **§6.8** said "there is no bulk endpoint" and specified sequential POSTs at
  concurrency 4 with a progress bar, a cancel button and a partial-failure retry
  list. `POST /stale-commitments/close-batch` now exists (AMENDMENT 6b) and is
  all-or-nothing, so none of that UI applies: a batch either applies in full or
  writes nothing, and a stale selection returns 409 with the operator's typed
  reason preserved.

Where this file and `CONTRACTS.md` disagree, **the contract wins.**
