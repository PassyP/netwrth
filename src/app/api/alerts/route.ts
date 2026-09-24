import { z } from "zod";
import { eq } from "drizzle-orm";
import { handler, json } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { CURRENCIES } from "@/lib/db/schema";

export const GET = handler(async () => {
  const db = getDb();
  const assets = new Map(db.select().from(schema.assets).all().map((a) => [a.id, a]));
  const rows = db.select().from(schema.alerts).all().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return json(rows.map((r) => ({ ...r, asset: assets.get(r.assetId) ?? null })));
});

const input = z.object({
  assetId: z.coerce.number().int().positive(),
  condition: z.enum(["above", "below"]),
  threshold: z.union([z.string(), z.number()]).transform((v) => String(v).replace(",", ".")).refine((v) => /^\d+(\.\d+)?$/.test(v), "geen geldig getal"),
  currency: z.enum(CURRENCIES),
});

export const POST = handler(async (req) => {
  const body = input.parse(await req.json());
  const db = getDb();
  const asset = db.select().from(schema.assets).where(eq(schema.assets.id, body.assetId)).get();
  if (!asset) return json({ error: "Asset niet gevonden" }, { status: 404 });
  const row = db.insert(schema.alerts).values({ ...body, status: "active", channel: "app", createdAt: new Date().toISOString() }).returning().get();
  return json(row, { status: 201 });
});
