/**
 * WP-5 · The coating half of `/stock` — UX-SPEC §5.1 / §11-A2, owner's ruling
 * 2026-09-29.
 *
 * WHY THIS FILE EXISTS. Coating is not a segment of the SKU key and never will
 * be: `tbl_1203` (sales-order detail) has no coating column, so a commitment
 * cannot be attributed to one. PV and PVDF rolls that share brand, colour,
 * thickness and size are therefore ONE SKU with ONE summed on-hand and ONE
 * **blended** ATP. Every assertion below guards one of the two ways a page can
 * lie about that:
 *
 *   1. HIDING a mixed SKU behind a coating filter — it tells a rep there is no
 *      PVDF when 60 sheets are sitting in the warehouse. That costs a sale.
 *   2. Showing the blended ATP under a coating filter — it tells a rep he can
 *      promise 80 of a coating when at most 60 exist. That over-promises, which
 *      is the failure mode the whole Stock 2.0 rebuild exists to eliminate.
 *
 * The ruling: the filter SHOWS mixed SKUs, and while it is active the row shows
 * a CEILING — `min(atp, on_hand of that coating)` — labelled as an upper bound,
 * never with an ATP's weight or an ATP's wording, with the blended ATP still on
 * the row so the real number is never lost.
 *
 * HOW IT IS TESTED. `/stock` is one vanilla HTML file with an inline <script> —
 * no bundler, no framework, no test-only export, and the repo has no DOM
 * library and may not grow one. So the page's own script is extracted verbatim
 * and evaluated in a `node:vm` context over a DOM stub small enough to be read
 * in one screen. That means these tests run the SHIPPED code, not a copy of it:
 * if someone edits the page and breaks the ruling, this file goes red. The stub
 * records what the page assigns to `innerHTML`, which is exactly the surface a
 * rep reads.
 *
 * No coating name is written into the page (the same discipline §12 greps for
 * with merek), so the fixtures below invent their own — the page must work off
 * whatever the response happens to carry.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, type Context } from "node:vm";
import { describe, expect, it } from "vitest";

const PAGE = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "stock.html");

/** The page's inline script, verbatim. There is exactly one <script> in it. */
function pageScript(): string {
  const html = readFileSync(PAGE, "utf8");
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m || m[1] === undefined) throw new Error("no inline <script> in stock.html");
  return m[1];
}

// ── the DOM stub ─────────────────────────────────────────────────────────────
// Only what the page actually touches. Anything it asks for that is not here
// would throw, which is itself a useful signal.

interface StubEl {
  value: string;
  checked: boolean;
  disabled: boolean;
  innerHTML: string;
  textContent: string;
  className: string;
  style: { display?: string };
  parentNode: StubEl | null;
  attrs: Record<string, string>;
  classList: { add(): void; remove(): void };
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  addEventListener(): void;
  querySelectorAll(): StubEl[];
  appendChild(c: StubEl): void;
  remove(): void;
}

function makeEl(): StubEl {
  const el: StubEl = {
    value: "",
    checked: false,
    disabled: false,
    innerHTML: "",
    textContent: "",
    className: "",
    style: {},
    parentNode: null,
    attrs: {},
    classList: { add() {}, remove() {} },
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    getAttribute(k) {
      return this.attrs[k] ?? null;
    },
    addEventListener() {},
    querySelectorAll() {
      return [];
    },
    appendChild(c) {
      c.parentNode = this;
    },
    remove() {
      this.parentNode = null;
    },
  };
  return el;
}

interface Page {
  ctx: Context;
  el(sel: string): StubEl;
  /** Evaluate an expression inside the page's own scope. */
  run<T = unknown>(src: string): T;
  /** Load a response and render the whole page from it. */
  load(items: unknown[], totals?: Record<string, unknown>): void;
  /** Set one toolbar control the way a tap would, then re-render the list. */
  setFilter(id: string, value: string): void;
  /** The rendered `<tbody>` — what a rep is looking at. */
  rowsHtml(): string;
}

function bootPage(): Page {
  const els = new Map<string, StubEl>();
  const el = (sel: string): StubEl => {
    let e = els.get(sel);
    if (!e) {
      e = makeEl();
      els.set(sel, e);
      // Faithful to the markup: the coating sort option ships INSIDE the sort
      // select and is detached when there is nothing to sort on. A stub that
      // starts it detached would hide exactly that bug.
      if (sel === "#sortCoating") e.parentNode = el("#sort");
    }
    return e;
  };
  const store = new Map<string, string>();
  const sandbox: Record<string, unknown> = {
    document: {
      querySelector: (sel: string) => el(sel),
      addEventListener() {},
      createElement: () => makeEl(),
    },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
    // Both polls hang forever: a test must never race the page's own fetches.
    fetch: () => new Promise(() => {}),
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    console,
  };
  const ctx = createContext(sandbox);
  runInContext(pageScript(), ctx, { filename: "stock.html" });

  const run = <T,>(src: string): T => runInContext(src, ctx) as T;
  return {
    ctx,
    el,
    run,
    load(items, totals = {}) {
      sandbox.__items = items;
      sandbox.__totals = totals;
      run(`
        SUMMARY = {
          freshness:{ last_ok_at:"2026-09-29T07:00:00.000Z", stale:false, erp_connected:true },
          totals: __totals, items: __items
        };
        FIRSTLOAD = false;
        renderAll();
      `);
    },
    setFilter(id, value) {
      el("#" + id).value = value;
      sandbox.__v = value;
      run(`flt[${JSON.stringify(id)}] = __v; renderRows();`);
    },
    rowsHtml() {
      return el("#tbody").innerHTML;
    },
  };
}

// ── fixtures ─────────────────────────────────────────────────────────────────
// Deliberately NOT the live coating values: the page must read whatever the
// response carries and must contain no coating name of its own.
const GLOSS = "GLOSS";
const MATT = "MATT";

type Sku = Record<string, unknown>;
function sku(over: Sku = {}): Sku {
  return {
    sku_key: "KODE-A|004|0.3|4880|1220",
    kode_barang: "KODE-A",
    brand_text: "Merek Satu",
    warna_name: "Hitam",
    th: 0.3,
    p: 4880,
    l: 1220,
    unit: "lembar",
    on_hand: 105,
    committed: 25,
    adjustment: 0,
    atp: 80,
    state: "tersedia",
    coatings: [{ coating: GLOSS, on_hand: 60 }, { coating: MATT, on_hand: 45 }],
    coating: null,
    ...over,
  };
}
/** A single-coating SKU: the scalar is non-null only in exactly this case. */
function single(name: string | null, over: Sku = {}): Sku {
  return sku({
    coatings: [{ coating: name, on_hand: 105 }],
    coating: name,
    ...over,
  });
}

describe("/stock — coating (UX-SPEC §11-A2, owner's ruling 2026-09-29)", () => {
  describe("the page carries no coating vocabulary of its own", () => {
    it("hardcodes no coating name, exactly as it hardcodes no merek", () => {
      const html = readFileSync(PAGE, "utf8");
      // The live population is one long coating name and two short ones. A page
      // that names any of them has an enum where it should have data — the §12
      // defect, one control over. Only the long one can be grepped as a
      // substring; for the shape, assert that the options come from one place
      // and that that place reads the response.
      expect(html).not.toMatch(/pvdf/i);
      expect(html).toContain("function coatOptions(items){");
      expect(html).toContain("syncSelect(\"coating\",coatOptions(items)");
    });

    it("never calls the unknown bucket 'no coating'", () => {
      const html = readFileSync(PAGE, "utf8");
      expect(html.toLowerCase()).not.toContain("tanpa coating");
      expect(html).toContain("Coating belum tercatat");
    });
  });

  describe("1 · coating on every row, unfiltered", () => {
    it("renders a single-coating SKU as the plain coating name", () => {
      const p = bootPage();
      p.load([single(GLOSS)]);
      const rows = p.rowsHtml();
      expect(rows).toContain(`<span class="chip coat">${GLOSS}</span>`);
      expect(rows).not.toContain("Campuran coating");
    });

    it("renders a MIXED SKU as both coatings with both quantities, never a lead value alone", () => {
      const p = bootPage();
      p.load([sku()]);
      const rows = p.rowsHtml();
      expect(rows).toContain("Campuran coating");
      expect(rows).toContain(`${GLOSS} 60`);
      expect(rows).toContain(`${MATT} 45`);
      // The whole point: the smaller bucket is not swallowed by the larger one.
      expect(rows.indexOf(`${GLOSS} 60`)).toBeLessThan(rows.indexOf(`${MATT} 45`));
    });

    it("renders the unknown bucket in Bahasa Indonesia — not blank, not a coating name", () => {
      const p = bootPage();
      p.load([
        single(GLOSS, { sku_key: "A" }),
        sku({
          sku_key: "B",
          coatings: [{ coating: GLOSS, on_hand: 60 }, { coating: null, on_hand: 45 }],
        }),
      ]);
      const rows = p.rowsHtml();
      expect(rows).toContain("Belum tercatat 45");
      expect(rows).not.toContain("null");
      expect(rows).not.toContain("undefined");
    });

    it("sums the split back to on_hand, so the row cannot contradict itself", () => {
      const p = bootPage();
      p.load([sku()]);
      const total = p.run<number>(`coatsOf(SUMMARY.items[0]).reduce((a,c)=>a+c.on_hand,0)`);
      expect(total).toBe(105);
    });
  });

  describe("2 · the filter — shows mixed SKUs, and shows a ceiling", () => {
    it("builds its options from the response, with an unknown option when unknown stock exists", () => {
      const p = bootPage();
      p.load([
        single(MATT, { sku_key: "A" }),
        sku({
          sku_key: "B",
          coatings: [{ coating: GLOSS, on_hand: 60 }, { coating: null, on_hand: 45 }],
        }),
      ]);
      const opts = p.run<{ v: string; label: string }[]>(`coatOptions(SUMMARY.items)`);
      expect(opts.map((o) => o.label)).toEqual([GLOSS, MATT, "Coating belum tercatat"]);
      // Keys are namespaced so the unknown bucket can never collide with a
      // coating the ERP happens to call "unknown", and so the sentinel survives
      // an <option value> round trip.
      expect(opts.map((o) => o.v)).toEqual([`c:${GLOSS}`, `c:${MATT}`, "u:"]);
    });

    it("SHOWS a mixed SKU rather than hiding it — hiding 60 sheets costs a sale", () => {
      const p = bootPage();
      p.load([sku({ sku_key: "MIXED" }), single(MATT, { sku_key: "PURE" })]);
      p.setFilter("coating", `c:${GLOSS}`);
      expect(p.rowsHtml()).toContain("MIXED");
      expect(p.rowsHtml()).not.toContain('data-sku="PURE"');
    });

    it("shows the CEILING, not the blended ATP, and keeps the real number reachable", () => {
      const p = bootPage();
      p.load([sku()]); // atp 80, GLOSS on_hand 60
      p.setFilter("coating", `c:${GLOSS}`);
      const rows = p.rowsHtml();
      // min(80, 60) = 60 — the number a rep may quote as a maximum.
      expect(rows).toContain("Maks. 60");
      // ...and it is NOT dressed as an ATP: no .atp headline on this row.
      expect(rows).not.toMatch(/class="atp[ "]/);
      // ...it says in words that it is an upper bound...
      expect(rows).toContain(`Batas atas coating ${GLOSS} — bisa lebih sedikit`);
      // ...and the blended ATP is still on the row, named in full.
      expect(rows).toContain("Bisa Dijual (semua coating) 80");
    });

    it("labels every filtered row as a bound, but only warns 'bisa lebih sedikit' where it can be", () => {
      const p = bootPage();
      // A SKU whose stock is ENTIRELY the filtered coating: no commitment of it
      // can be another coating, so the figure is exact and a warning there
      // would be false — which is how warnings stop being read.
      p.load([sku({ sku_key: "MIXED" }), single(GLOSS, { sku_key: "PURE", atp: 90 })]);
      p.setFilter("coating", `c:${GLOSS}`);
      const rows = p.rowsHtml();
      const cut = rows.indexOf('data-sku="PURE"');
      const mixedRow = rows.slice(0, cut);
      const pureRow = rows.slice(cut);
      expect(mixedRow).toContain(`Batas atas coating ${GLOSS} — bisa lebih sedikit`);
      expect(pureRow).toContain(`Batas atas coating ${GLOSS}</div>`);
      expect(pureRow).not.toContain("bisa lebih sedikit");
      // One visual grade of trust, though: both are `.cap`, neither is `.atp`.
      expect(pureRow).toContain("Maks. 90");
      expect(pureRow).not.toMatch(/class="atp[ "]/);
    });

    it("warns, above the list, that a filtered view is not an unfiltered one", () => {
      const p = bootPage();
      p.load([sku()]);
      expect(p.el("#capBar").style.display).toBe("none");
      p.setFilter("coating", `c:${GLOSS}`);
      const bar = p.el("#capBar").innerHTML;
      expect(p.el("#capBar").style.display).toBe("");
      expect(bar).toContain("batas atas, bukan Bisa Dijual");
      // The reason, not just the claim: commitments carry no coating.
      expect(bar).toContain("Pesanan di ERP tidak mencatat coating");
    });

    it("ceiling === min(atp, on_hand of that coating), in both directions", () => {
      const p = bootPage();
      // on_hand of the coating binds
      p.load([sku({ atp: 80, coatings: [{ coating: GLOSS, on_hand: 60 }, { coating: MATT, on_hand: 45 }] })]);
      expect(p.run<number>(`coatCeiling(SUMMARY.items[0], "c:${GLOSS}")`)).toBe(60);
      // atp binds — a big coating bucket cannot raise what is sellable
      p.load([sku({ atp: 30, coatings: [{ coating: GLOSS, on_hand: 90 }, { coating: MATT, on_hand: 15 }] })]);
      expect(p.run<number>(`coatCeiling(SUMMARY.items[0], "c:${GLOSS}")`)).toBe(30);
      // the unknown bucket is a bucket like any other
      p.load([sku({ atp: 80, coatings: [{ coating: GLOSS, on_hand: 60 }, { coating: null, on_hand: 45 }] })]);
      expect(p.run<number>(`coatCeiling(SUMMARY.items[0], "u:")`)).toBe(45);
    });

    it("never prints 'Maks. −n': at or below zero the ceiling IS the ATP and is shown as itself", () => {
      const p = bootPage();
      p.load([
        sku({
          atp: -120,
          state: "perlu_produksi",
          on_hand: 105,
          committed: 225,
          coatings: [{ coating: GLOSS, on_hand: 60 }, { coating: MATT, on_hand: 45 }],
        }),
      ]);
      p.setFilter("coating", `c:${GLOSS}`);
      const rows = p.rowsHtml();
      expect(rows).not.toContain("Maks.");
      expect(rows).toContain("−120"); // U+2212, §1.4
      // The view still says it is filtered — that guarantee does not lapse.
      expect(rows).toContain(`Disaring coating ${GLOSS}`);
    });
  });

  describe("3 · the sort — largest bucket, mixed distinguishable, total and deterministic", () => {
    const pop = (): Sku[] => [
      single(MATT, { sku_key: "m-pure", kode_barang: "K3" }),
      sku({
        sku_key: "g-mixed",
        kode_barang: "K2",
        coatings: [{ coating: GLOSS, on_hand: 70 }, { coating: MATT, on_hand: 35 }],
      }),
      single(GLOSS, { sku_key: "g-pure", kode_barang: "K1" }),
      sku({
        sku_key: "unknown-led",
        kode_barang: "K4",
        coatings: [{ coating: null, on_hand: 80 }, { coating: GLOSS, on_hand: 25 }],
      }),
      sku({ sku_key: "no-field", kode_barang: "K5", coatings: undefined, coating: undefined }),
    ];

    const order = (p: Page): string[] => {
      p.setFilter("sort", "coating");
      return [...p.rowsHtml().matchAll(/data-sku="([^"]+)"/g)].map((m) => m[1] as string);
    };

    it("sorts a mixed SKU on its LARGEST bucket, with pure SKUs ahead of mixed ones", () => {
      const p = bootPage();
      p.load(pop());
      expect(order(p)).toEqual([
        "g-pure", // GLOSS, single
        "g-mixed", // GLOSS largest (70) — after the pure GLOSS row, never among them
        "m-pure", // MATT
        "unknown-led", // unknown largest (80) sorts after every named coating
        "no-field", // no coatings[] at all sorts last of all
      ]);
    });

    it("is total and deterministic — the same order from any input order", () => {
      const base = pop();
      const first = order((() => { const p = bootPage(); p.load(base); return p; })());
      // Reversed, and rotated: a comparator with an inconsistent tie-break gives
      // a different answer per input permutation, and rows then swap places
      // between 30s polls.
      const rev = order((() => { const p = bootPage(); p.load([...base].reverse()); return p; })());
      const rot = order((() => { const p = bootPage(); p.load([...base.slice(2), ...base.slice(0, 2)]); return p; })());
      expect(rev).toEqual(first);
      expect(rot).toEqual(first);
    });

    it("breaks a dead tie on the sku_key, so equal keys cannot swap between polls", () => {
      const p = bootPage();
      // Byte-identical but for the key: only tail()'s final segment can order these.
      p.load([
        single(GLOSS, { sku_key: "zzz" }),
        single(GLOSS, { sku_key: "aaa" }),
      ]);
      expect(order(p)).toEqual(["aaa", "zzz"]);
      const cmp = p.run<number>(
        `(()=>{const c=cmpFor("coating");const a=SUMMARY.items[0],b=SUMMARY.items[1];` +
          `return (c(a,b)<0?-1:c(a,b)>0?1:0) + (c(b,a)<0?-1:c(b,a)>0?1:0);})()`,
      );
      expect(cmp).toBe(0); // antisymmetric: cmp(a,b) === −cmp(b,a), never 0/0
    });

    it("marks a mixed row so it is never silently interleaved among pure ones", () => {
      const p = bootPage();
      p.load(pop());
      const rows = p.rowsHtml();
      const mixedRow = rows.slice(rows.indexOf('data-sku="g-mixed"'));
      expect(mixedRow.slice(0, mixedRow.indexOf("</tr>"))).toContain("Campuran coating");
    });
  });

  describe("4 · mixed_coating_skus, where the other totals live", () => {
    it("surfaces the count and says why it matters, not just how many", () => {
      const p = bootPage();
      p.load([sku()], { skus: 1, tersedia: 1, mixed_coating_skus: 12 });
      expect(p.el("#totals").innerHTML).toContain("Campuran coating 12");
      const note = p.el("#mixNote").textContent;
      expect(p.el("#mixNote").style.display).toBe("");
      expect(note).toContain("lebih dari satu coating");
      expect(note).toContain("tidak semuanya coating yang sama");
    });

    it("renders nothing at all when the count is zero or the field is absent", () => {
      const p = bootPage();
      p.load([single(GLOSS)], { skus: 1, mixed_coating_skus: 0 });
      expect(p.el("#totals").innerHTML).not.toContain("Campuran coating");
      expect(p.el("#mixNote").style.display).toBe("none");
      p.load([single(GLOSS)], { skus: 1 }); // older payload, no such field
      expect(p.el("#totals").innerHTML).not.toContain("Campuran coating");
      expect(p.el("#mixNote").style.display).toBe("none");
    });
  });

  describe("degradation — the state the page is actually in today", () => {
    it("an ALL-UNKNOWN population renders cleanly: no chip column, no dead select, no blanks", () => {
      const p = bootPage();
      p.load(
        [
          single(null, { sku_key: "A" }),
          single(null, { sku_key: "B", kode_barang: "KODE-B" }),
        ],
        { skus: 2, tersedia: 2, mixed_coating_skus: 0 },
      );
      const rows = p.rowsHtml();
      expect(rows).not.toContain("undefined");
      expect(rows).not.toContain("null");
      // 812 identical "belum tercatat" chips are noise, not information...
      expect(rows).not.toContain("chip coat");
      // ...so the page says it once, in the list header, and explains itself.
      expect(p.el("#capBar").style.display).toBe("");
      expect(p.el("#capBar").textContent).toContain("Coating belum tercatat untuk semua SKU");
      expect(p.el("#capBar").textContent).toContain("sinkronisasi ERP berikutnya");
      // The select has nothing to choose between, so it is not shown at all —
      // never an empty dropdown (the same rule §5.1 gives Ukuran and Tebal).
      expect(p.run<unknown[]>(`coatOptions(SUMMARY.items)`)).toEqual([]);
      expect(p.el("#coating").style.display).toBe("none");
      // ...and the sort that cannot order anything is out of the DOM with it.
      expect(p.run<boolean>(`SORT_COAT_OPT.parentNode === $("#sort")`)).toBe(false);
    });

    it("a stored sort=coating falls back instead of leaving the select lying", () => {
      const p = bootPage();
      p.run(`flt.sort="coating"`);
      p.load([single(null)]);
      expect(p.run<string>(`flt.sort`)).toBe("warna");
    });

    it("a response with NO coatings field does not throw, and invents nothing", () => {
      const p = bootPage();
      const old = sku({ coatings: undefined, coating: undefined });
      delete old.coatings;
      delete old.coating;
      expect(() => p.load([old], { skus: 1 })).not.toThrow();
      const rows = p.rowsHtml();
      expect(rows).toContain('class="atp"'); // ...the row still renders in full
      expect(rows).toContain("Fisik 105 · Dipesan 25");
      expect(rows).not.toContain("undefined");
      expect(rows).not.toContain("chip coat");
      // Absent is not the same as unknown: we were never told, so we say nothing.
      expect(rows).not.toContain("Belum tercatat");
      expect(p.run<unknown[]>(`coatsOf(SUMMARY.items[0])`)).toEqual([]);
    });

    it("coatings:[] with only the scalar left degrades to the scalar, not to a blank", () => {
      const p = bootPage();
      p.load([sku({ coatings: [], coating: GLOSS })]);
      expect(p.rowsHtml()).toContain(`<span class="chip coat">${GLOSS}</span>`);
    });

    it("junk inside coatings[] is skipped rather than rendered", () => {
      const p = bootPage();
      p.load([
        sku({
          coatings: [null, { coating: GLOSS, on_hand: 60 }, "  ", { coating: "  ", on_hand: 45 }],
        }),
      ]);
      const rows = p.rowsHtml();
      expect(rows).not.toContain("undefined");
      expect(rows).toContain("Campuran coating");
      expect(rows).toContain(`${GLOSS} 60`);
      expect(rows).toContain("Belum tercatat 45"); // "  " trims to the unknown bucket
    });
  });

  describe("the ruling's blast radius — nothing else moved", () => {
    it("leaves the ATP arithmetic and the SKU key alone", () => {
      const p = bootPage();
      p.load([sku()]);
      const rows = p.rowsHtml();
      expect(rows).toContain("Fisik 105");
      expect(rows).toContain("Dipesan 25");
      expect(rows).toContain("KODE-A|004|0.3|4880|1220");
    });

    it("still refuses to hide a perlu_produksi row behind the empty toggle", () => {
      const p = bootPage();
      p.load([sku({ atp: -120, state: "perlu_produksi" })]);
      p.setFilter("hideZero", "");
      p.run(`flt.hideZero = true; renderRows();`);
      expect(p.rowsHtml()).toContain("data-sku=");
    });
  });
});
