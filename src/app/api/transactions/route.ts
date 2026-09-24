import { handler, json } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { createTransaction } from "@/lib/transactions";

export const GET = handler(async (req) => {
  const p = new URL(req.url).searchParams;
  const db = getDb();
  let rows = db.select().from(schema.transactions).all();
  const portfolioId = p.get("portfolioId");
  if (portfolioId && portfolioId !== "all") rows = rows.filter((r) => r.portfolioId === Number(portfolioId));
  if (p.get("assetId")) rows = rows.filter((r) => r.assetId === Number(p.get("assetId")));
  if (p.get("platformId")) rows = rows.filter((r) => r.platformId === Number(p.get("platformId")));
  if (p.get("type")) rows = rows.filter((r) => r.type === p.get("type"));
  rows.sort((a, b) => (a.executedAt < b.executedAt ? 1 : a.executedAt > b.executedAt ? -1 : b.id - a.id));
  const assets = new Map(db.select().from(schema.assets).all().map((a) => [a.id, a]));
  const platforms = new Map(db.select().from(schema.platforms).all().map((a) => [a.id, a]));
  const portfolios = new Map(db.select().from(schema.portfolios).all().map((a) => [a.id, a]));
  return json(
    rows.map((r) => ({
      ...r,
      asset: r.assetId ? assets.get(r.assetId) ?? null : null,
      platformName: platforms.get(r.platformId)?.name ?? "?",
      portfolioName: portfolios.get(r.portfolioId)?.name ?? "?",
    }))
  );
});

export const POST = handler(async (req) => {
  const row = await createTransaction(await req.json());
  return json(row, { status: 201 });
});

export const dynamic = "force-dynamic";
