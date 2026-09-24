import { eq } from "drizzle-orm";
import { z } from "zod";
import { handler, json, idFromParams } from "@/lib/api";
import { getDb, schema } from "@/lib/db";

const patch = z.object({ name: z.string().trim().min(1).max(100).optional(), description: z.string().max(500).nullable().optional(), archived: z.boolean().optional() });

export const PATCH = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  const body = patch.parse(await req.json());
  getDb().update(schema.portfolios).set(body).where(eq(schema.portfolios.id, id)).run();
  return json(getDb().select().from(schema.portfolios).where(eq(schema.portfolios.id, id)).get());
});

export const DELETE = handler(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  const db = getDb();
  const count = db.select().from(schema.transactions).where(eq(schema.transactions.portfolioId, id)).all().length;
  if (count > 0) return json({ error: `Portfolio heeft nog ${count} transacties; archiveer het of verwijder eerst de transacties.` }, { status: 400 });
  db.delete(schema.portfolios).where(eq(schema.portfolios.id, id)).run();
  return json({ ok: true });
});
