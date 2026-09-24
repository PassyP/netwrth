import { handler } from "@/lib/api";
import { getDb, schema } from "@/lib/db";

export const GET = handler(async () => {
  const db = getDb();
  const assets = new Map(db.select().from(schema.assets).all().map((a) => [a.id, a]));
  const platforms = new Map(db.select().from(schema.platforms).all().map((a) => [a.id, a]));
  const portfolios = new Map(db.select().from(schema.portfolios).all().map((a) => [a.id, a]));
  const rows = db.select().from(schema.transactions).all().sort((a, b) => (a.executedAt < b.executedAt ? -1 : 1));
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["id", "portfolio", "platform", "type", "symbol", "isin", "quantity", "price", "currency", "fee", "executedAt", "fxEur", "fxUsd", "note"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const a = r.assetId ? assets.get(r.assetId) : null;
    lines.push([r.id, portfolios.get(r.portfolioId)?.name, platforms.get(r.platformId)?.name, r.type, a?.symbol, a?.isin, r.quantity, r.price, r.currency, r.fee, r.executedAt, r.fxEur, r.fxUsd, r.note].map(esc).join(","));
  }
  return new Response(lines.join("\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="transacties-${new Date().toISOString().slice(0, 10)}.csv"` } });
});
