// Selaras ERP ontology sweep — one-off, read-only. Pulls every table's columns,
// a recent-row sample, row counts and activity counts, profiles columns, and
// prints one compact line per table to the deploy log (prefix "ONT|").
// Full JSON is served at /<ACCESS_TOKEN>/all.json while the service lives.

const BASE = Bun.env.SELARAS_BASE ?? "https://selaras2.io/kencana/api";
const KEY = Bun.env.SELARAS_KEY ?? "";
const TOK = Bun.env.SELARAS_TOKEN ?? "";
const ACCESS = Bun.env.ACCESS_TOKEN ?? "";
const SAMPLE = Number(Bun.env.SAMPLE_ROWS ?? "300");
const CONC = Number(Bun.env.CONCURRENCY ?? "2");

const PII = /(phone|telp|telepon|kontak|^hp$|_hp|nik|ktp|npwp|email|alamat|address|latitude|longitude|rekening|password|token|secret|ship_to|bill_to|contact_person|penerima|pic)/i;

type Prof = Record<string, unknown>;
const results: Prof[] = [];
const status: any = { state: "starting", done: 0, total: 0, errors: 0, startedAt: new Date().toISOString(), finishedAt: "" };

const GAP = Number(Bun.env.GAP_MS ?? "1300");
let gate = Promise.resolve();
let lastAt = 0;
function slot(): Promise<void> {
  const p = gate.then(async () => {
    const wait = lastAt + GAP - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    lastAt = Date.now();
  });
  gate = p;
  return p;
}
status.n429 = 0;
async function get(path: string, tries = 7): Promise<{ status: number; body: any }> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    await slot();
    try {
      const r = await fetch(BASE + path, {
        headers: { "X-Secret-Key": KEY, "X-Secret-Token": TOK },
        signal: AbortSignal.timeout(90_000),
      });
      const text = await r.text();
      let body: any = text;
      try { body = JSON.parse(text); } catch {}
      if (r.status === 429) {
        status.n429++;
        const ra = Number(r.headers.get("retry-after") ?? "0");
        last = { status: 429, body: "rate limited" };
        await Bun.sleep(Math.max(ra * 1000, 15000 * (i + 1)));
        continue;
      }
      if (r.status >= 500) { last = { status: r.status, body }; await Bun.sleep(3000 * (i + 1)); continue; }
      return { status: r.status, body };
    } catch (e) {
      last = { status: 0, body: String(e) };
      await Bun.sleep(3000 * (i + 1));
    }
  }
  return last;
}

const day = (n: number) => {
  const d = new Date(Date.now() - n * 86400_000 + 7 * 3600_000); // WIB
  return d.toISOString().slice(0, 10) + " 00:00:00";
};

async function count(t: string, q: string): Promise<number | null> {
  const r = await get(`/table/${encodeURIComponent(t)}?limit=1&${q}`);
  if (r.status !== 200 || !r.body?.meta) return null;
  return Number(r.body.meta.total);
}

function short(v: unknown, n = 24): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return (s ?? "").replace(/[\s|;,{}]+/g, " ").trim().slice(0, n);
}

function profileRows(rows: any[]) {
  const keys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r ?? {})) keys.add(k);
  const out: Record<string, any> = {};
  for (const k of keys) {
    let filled = 0;
    const vals = new Map<string, number>();
    let maxDate = "", minDate = "";
    for (const r of rows) {
      const v = r?.[k];
      if (v === null || v === undefined || v === "" || (typeof v === "string" && v.trim() === "")) continue;
      filled++;
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      if (vals.size < 60 || vals.has(s)) vals.set(s, (vals.get(s) ?? 0) + 1);
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        const d = s.slice(0, 10);
        if (!maxDate || d > maxDate) maxDate = d;
        if (!minDate || d < minDate) minDate = d;
      }
    }
    const pii = PII.test(k);
    const distinct = vals.size >= 60 ? "60+" : vals.size;
    const top = pii ? [] : [...vals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, c]) => [short(v, 40), c]);
    out[k] = { fill: rows.length ? Math.round((filled / rows.length) * 100) : 0, distinct, top, pii, minDate, maxDate };
  }
  return out;
}

function compactLine(p: any): string {
  const cols: string[] = [];
  for (const c of p.columns ?? []) {
    const prof = p.profile?.[c.name];
    let s = c.name;
    if (c.label && c.label.toLowerCase().replace(/[^a-z0-9]/g, "") !== c.name.toLowerCase().replace(/[^a-z0-9]/g, "")) s += `"${short(c.label, 22)}"`;
    s += `:${prof ? prof.fill : "-"}`;
    if (c.lookup) s += `>${c.lookup}`;
    if (prof && !prof.pii && prof.fill > 0 && typeof prof.distinct === "number" && prof.distinct <= 6 && !c.lookup && !/(_id|_at)$/.test(c.name)) {
      s += `{${prof.top.map((t: any) => `${t[0]}`).join("/")}}`;
    } else if (prof?.maxDate && /date|tanggal|_at$|tgl/i.test(c.name)) {
      s += `[..${prof.maxDate}]`;
    }
    cols.push(s);
  }
  return [
    "ONT",
    p.table,
    short(p.name, 50),
    short(p.module, 30),
    `rows=${p.total ?? "?"}`,
    `u30=${p.upd30 ?? "?"}`,
    `u365=${p.upd365 ?? "?"}`,
    `first=${p.firstCreated ?? "?"}`,
    `last=${p.lastUpdated ?? "?"}`,
    p.error ? `ERR=${short(p.error, 80)}` : "",
    cols.join(" "),
  ].join("|");
}

async function sweepTable(t: any) {
  const table: string = t.table ?? t.name;
  const p: any = { table, name: t.name, description: t.description, module: t.module };
  try {
    const c = await get(`/table/${encodeURIComponent(table)}/columns`);
    const rawCols: any[] = Array.isArray(c.body?.columns) ? c.body.columns : [];
    if (!status.colShapeLogged && rawCols.length) {
      console.log("COLSHAPE|" + JSON.stringify(rawCols.slice(0, 3)).slice(0, 1500));
      status.colShapeLogged = true;
    }
    p.columns = rawCols.map((x) => {
      const name = x.name ?? x.column ?? x.column_name ?? x.field ?? "?";
      const lk = x.lookup ?? x.reference ?? x.references ?? x.relation ?? null;
      let lookup = "";
      if (lk) {
        if (!status.lookShapeLogged) { console.log("LOOKSHAPE|" + JSON.stringify(x).slice(0, 800)); status.lookShapeLogged = true; }
        if (typeof lk === "string") lookup = lk;
        else {
          const tbl = lk.table ?? lk.ref_table ?? lk.reference_table ?? Object.values(lk).find((v: any) => typeof v === "string" && /^tbl_|^users$/.test(v)) ?? "?";
          const others = Object.entries(lk).filter(([k, v]) => typeof v === "string" && v !== tbl && !/response|label/i.test(k)).map(([, v]) => v);
          lookup = `${tbl}.${others.join(",")}`;
        }
      }
      return { name, label: x.label ?? x.column_label ?? "", type: x.type ?? x.data_type ?? "", lookup, raw: x };
    });

    let s = await get(`/table/${encodeURIComponent(table)}?limit=${SAMPLE}&order_by=updated_at&order_dir=desc`);
    if (s.status !== 200) s = await get(`/table/${encodeURIComponent(table)}?limit=${SAMPLE}`);
    if (s.status !== 200) throw new Error(`sample ${s.status} ${short(s.body, 120)}`);
    const rows: any[] = s.body.data ?? [];
    p.total = s.body.meta?.total ?? null;
    p.sampleN = rows.length;
    p.profile = profileRows(rows);
    p.lastUpdated = rows[0]?.updated_at ?? rows[0]?.created_at ?? null;
    if (!p.columns.length && rows.length) p.columns = Object.keys(rows[0]).map((k) => ({ name: k, label: "", type: "", lookup: "" }));

    if (p.total > 0) {
      p.upd30 = await count(table, `updated_at__gte=${encodeURIComponent(day(30))}`);
      p.upd365 = await count(table, `updated_at__gte=${encodeURIComponent(day(365))}`);
      const f = await get(`/table/${encodeURIComponent(table)}?limit=1&order_by=created_at&order_dir=asc&fields=created_at`);
      p.firstCreated = f.body?.data?.[0]?.created_at ?? null;
    }
  } catch (e) {
    p.error = String(e);
    status.errors++;
  }
  results.push(p);
  status.done++;
  console.log(compactLine(p));
}

async function run() {
  if (!KEY || !TOK) { status.state = "missing-credentials"; console.log("WAITING: set SELARAS_KEY / SELARAS_TOKEN"); return; }
  status.state = "listing";
  const t = await get("/tables");
  const tables: any[] = t.body?.tables ?? t.body?.data ?? [];
  console.log(`TABLES|status=${t.status}|count=${tables.length}|first=${JSON.stringify(tables[0] ?? t.body).slice(0, 400)}`);
  status.total = tables.length;
  status.state = "sweeping";
  const queue = [...tables];
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (queue.length) {
        const next = queue.shift();
        if (next) await sweepTable(next);
      }
    }),
  );
  status.state = "done";
  status.finishedAt = new Date().toISOString();
  console.log(`DONE|tables=${results.length}|errors=${status.errors}|${status.startedAt}..${status.finishedAt}`);
}

Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/health") return Response.json({ ok: true });
    if (!ACCESS || !u.pathname.startsWith(`/${ACCESS}/`)) return new Response("not found", { status: 404 });
    const rest = u.pathname.slice(ACCESS.length + 2);
    const cors = { "Access-Control-Allow-Origin": "*" };
    if (rest === "status") return Response.json(status, { headers: cors });
    if (rest === "q") {
      const path = u.searchParams.get("path") ?? "";
      if (!path.startsWith("/table") && path !== "/tables") return new Response("bad path", { status: 400, headers: cors });
      const r = await get(path);
      return Response.json(r.body, { status: r.status, headers: cors });
    }
    if (rest === "all.json") return Response.json(results.map(({ columns, ...r }: any) => ({ ...r, columns: columns?.map(({ raw, ...c }: any) => c) })), { headers: cors });
    if (rest === "compact.txt") return new Response(results.map(compactLine).join("\n"), { headers: cors });
    if (rest.startsWith("t/")) {
      const p = results.find((r: any) => r.table === decodeURIComponent(rest.slice(2)));
      return p ? Response.json(p, { headers: cors }) : new Response("no", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  },
});

if (Bun.env.RUN_SWEEP === "1") run().catch((e) => { status.state = "crashed"; console.log("CRASH|" + String(e)); });
