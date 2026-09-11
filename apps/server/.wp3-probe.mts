import Fastify from "fastify";
import { stockAtpRoutes } from "./src/routes/stock-atp.js";
import { stockRoutes } from "./src/routes/stock.js";
const app = Fastify({ logger: false });
await app.register(stockAtpRoutes); await app.register(stockRoutes);
const get = async (u: string) => (await app.inject({ method: "GET", url: u })).json();
const s = await get("/api/stock/summary") as { totals: unknown; items: Record<string, unknown>[] };
console.log("totals:", JSON.stringify(s.totals));
for (const it of s.items) console.log("item:", JSON.stringify({ sku_key: it.sku_key, on_hand: it.on_hand, committed: it.committed, adjustment: it.adjustment, atp: it.atp, state: it.state, stale_committed: it.stale_committed }));
console.log("shortfall:", JSON.stringify(await get("/api/stock/shortfall?limit=5")));
const ex = await get("/api/stock/exceptions?limit=5") as { total: number; items: Record<string, unknown>[] };
console.log("exceptions total:", ex.total, ex.items.map(i => ({ so_line_id: i.so_line_id, sku_key: i.sku_key, qty_balance: i.qty_balance, unmatched: i.unmatched, reason: i.reason })));
const und = await get("/api/stock/stale-commitments?segment=undated&limit=5") as { total: number; items: Record<string, unknown>[] };
console.log("segment=undated total:", und.total, JSON.stringify(und.items.map(i => ({ so_line_id: i.so_line_id, qty_balance: i.qty_balance, undated: i.undated, state: i.state }))));
console.log("archive GETs:");
for (const p of ["/api/stock/uploads", "/api/stock/bookings", "/api/stock/rep-stats"]) {
  const r = await app.inject({ method: "GET", url: p });
  console.log(" ", r.statusCode, p, r.body.slice(0, 70));
}
await app.close(); process.exit(0);
