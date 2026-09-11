/* WP-3/WP-4 acceptance harness. Registers stockAtpRoutes exactly as index.ts will. */
import Fastify from "fastify";
import { stockAtpRoutes } from "./src/routes/stock-atp.js";
import { stockRoutes } from "./src/routes/stock.js";

const app = Fastify({ logger: false });
await app.register(stockAtpRoutes);
await app.register(stockRoutes);

const SKU = "ACP-4MM|004|0.3|4880|1220";
async function hit(method: string, url: string, body?: unknown) {
  const res = await app.inject({ method: method as "GET", url, payload: body as object | undefined });
  let json: unknown = null;
  try { json = res.json(); } catch { json = res.body; }
  return { status: res.statusCode, json };
}

const summary = await hit("GET", "/api/stock/summary");
const s = summary.json as { freshness: unknown; totals: unknown; items: { sku_key: string }[] };
const bg = s.items.find((i) => i.sku_key === SKU);
console.log("=== GET /api/stock/summary — status", summary.status, "===");
console.log(JSON.stringify({ freshness: s.freshness, totals: s.totals, items: [bg] }, null, 2));

console.log("\n=== GET /api/stock/sku/" + encodeURIComponent(SKU) + " ===");
const detail = await hit("GET", `/api/stock/sku/${encodeURIComponent(SKU)}`);
const d = detail.json as Record<string, unknown[]> & { item: unknown };
console.log("status", detail.status);
console.log(JSON.stringify({
  item: d.item,
  live_commitments_count: d.live_commitments.length,
  live_commitments_sample: d.live_commitments.slice(0, 1),
  stale_commitments_count: d.stale_commitments.length,
  stale_commitments_sample: d.stale_commitments.slice(0, 1),
  adjustments: d.adjustments,
  on_hand_rows_count: d.on_hand_rows.length,
  on_hand_rows_sample: d.on_hand_rows.slice(0, 1),
}, null, 2));

console.log("\n=== GET /api/stock/stale-commitments?page=1&limit=2&sort=eta_asc ===");
console.log(JSON.stringify((await hit("GET", "/api/stock/stale-commitments?page=1&limit=2&sort=eta_asc")).json, null, 2));

console.log("\n=== GET /api/stock/shortfall / exceptions / sync-status ===");
console.log("shortfall  ", JSON.stringify((await hit("GET", "/api/stock/shortfall?page=1&limit=5")).json));
console.log("exceptions ", JSON.stringify((await hit("GET", "/api/stock/exceptions?page=1&limit=5")).json));
console.log("sync-status", JSON.stringify((await hit("GET", "/api/stock/sync-status")).json));

console.log("\n=== WRITES ===");
console.log("adj no reason ", JSON.stringify(await hit("POST", "/api/stock/adjustments", { sku_key: SKU, qty_delta: -50, actor: "ppic" })));
console.log("adj zero delta", JSON.stringify(await hit("POST", "/api/stock/adjustments", { sku_key: SKU, qty_delta: 0, reason: "opname", actor: "ppic" })));
console.log("adj ok        ", JSON.stringify(await hit("POST", "/api/stock/adjustments", { sku_key: SKU, qty_delta: -50, reason: "Opname 11 Sep: 50 lembar rusak", actor: "ppic" })));

console.log("\nclose a STALE line (expect atp_delta 0):");
console.log(JSON.stringify((await hit("POST", "/api/stock/stale-commitments/BGTEST-L-S1/close", { actor: "ppic", reason: "Phantom 2020, sudah dikirim" })).json, null, 2));
console.log("\nclose a LIVE line (expect atp_delta = +qty_balance):");
console.log(JSON.stringify((await hit("POST", "/api/stock/stale-commitments/BGTEST-L-A1/close", { actor: "ppic", reason: "Dibatalkan pelanggan" })).json, null, 2));
console.log("\nreinstate it:");
console.log(JSON.stringify((await hit("POST", "/api/stock/stale-commitments/BGTEST-L-A1/reinstate", { actor: "ppic" })).json, null, 2));

console.log("\nbatch close — count mismatch guard:");
console.log(JSON.stringify(await hit("POST", "/api/stock/stale-commitments/close-batch", { so_line_ids: ["BGTEST-L-S2", "BGTEST-L-S3"], reason: "ST-R22 delivered but not closed", actor: "ppic", expected_count: 3 })));
console.log("batch close — ok:");
console.log(JSON.stringify((await hit("POST", "/api/stock/stale-commitments/close-batch", { so_line_ids: ["BGTEST-L-S2", "BGTEST-L-S3", "NOPE-1"], reason: "ST-R22 delivered but not closed", actor: "ppic", expected_count: 3 })).json, null, 2));
console.log("segment=closed:", JSON.stringify((await hit("GET", "/api/stock/stale-commitments?segment=closed&limit=10")).json as { total: number }));

console.log("\n=== 410 tombstones (ST-R15) ===");
for (const p of ["/api/stock/uploads", "/api/stock/bookings", "/api/stock/bookings/9/verify", "/api/stock/bookings/9/cancel", "/api/stock/bookings/9/complete", "/api/stock/bookings/9/fulfill"]) {
  const r = await hit("POST", p, {});
  console.log(r.status, p, JSON.stringify(r.json));
}
console.log("\n=== archive reads still alive (ST-R14) ===");
for (const p of ["/api/stock/uploads", "/api/stock/bookings", "/api/stock/rep-stats"]) {
  const r = await hit("GET", p);
  console.log(r.status, p, JSON.stringify(r.json).slice(0, 90));
}
console.log("\nPOST /api/stock/sync:", JSON.stringify(await hit("POST", "/api/stock/sync", { actor: "ppic" })));

await app.close();
process.exit(0);
