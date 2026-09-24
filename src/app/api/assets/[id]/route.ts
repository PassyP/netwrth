import { eq } from "drizzle-orm";
import { handler, json, idFromParams } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { updateAsset, primeAssetPrice } from "@/lib/assets";
import { latestQuote, previousClose } from "@/lib/prices/quotes";
import { computePortfolio } from "@/lib/portfolio";

export const GET = handler(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  const db = getDb();
  const asset = db.select().from(schema.assets).where(eq(schema.assets.id, id)).get();
  if (!asset) return json({ error: "Asset niet gevonden" }, { status: 404 });
  const view = computePortfolio(null);
  const positions = view.positions.filter((p) => p.assetId === id);
  const transactions = db.select().from(schema.transactions).where(eq(schema.transactions.assetId, id)).all().sort((a, b) => (a.executedAt < b.executedAt ? 1 : -1));
  const valuations = db.select().from(schema.valuations).where(eq(schema.valuations.assetId, id)).all().sort((a, b) => (a.date < b.date ? 1 : -1));
  const alerts = db.select().from(schema.alerts).where(eq(schema.alerts.assetId, id)).all();
  return json({ asset, quote: latestQuote(id), previousClose: previousClose(id), positions, transactions, valuations, alerts });
});

export const PATCH = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  const body = await req.json();
  const asset = await updateAsset(id, body);
  if (body.priceSource || body.sourceId) void primeAssetPrice(asset);
  return json(asset);
});

export const DELETE = handler(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  const db = getDb();
  const n = db.select().from(schema.transactions).where(eq(schema.transactions.assetId, id)).all().length;
  if (n > 0) return json({ error: `Asset heeft nog ${n} transacties.` }, { status: 400 });
  db.delete(schema.assets).where(eq(schema.assets.id, id)).run();
  return json({ ok: true });
});
