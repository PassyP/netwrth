import { z } from "zod";
import { count } from "drizzle-orm";
import { handler, json } from "@/lib/api";
import { getDb, schema } from "@/lib/db";

/** Alle portfolios, met hoeveel transacties en koppelingen erin boeken (Instellingen → Portfolios). */
export const GET = handler(async () => {
  const db = getDb();
  const tx = new Map(db.select({ id: schema.transactions.portfolioId, n: count() }).from(schema.transactions).groupBy(schema.transactions.portfolioId).all().map((r) => [r.id, Number(r.n)]));
  const conn = new Map(db.select({ id: schema.connections.portfolioId, n: count() }).from(schema.connections).groupBy(schema.connections.portfolioId).all().map((r) => [r.id, Number(r.n)]));
  return json(
    db
      .select()
      .from(schema.portfolios)
      .orderBy(schema.portfolios.id)
      .all()
      .map((p) => ({ ...p, txCount: tx.get(p.id) ?? 0, connectionCount: conn.get(p.id) ?? 0 }))
  );
});

const input = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(500).nullable().optional() });

export const POST = handler(async (req) => {
  const body = input.parse(await req.json());
  const row = getDb().insert(schema.portfolios).values({ name: body.name, description: body.description ?? null, createdAt: new Date().toISOString() }).returning().get();
  return json(row, { status: 201 });
});
