import { eq } from "drizzle-orm";
import { z } from "zod";
import { handler, json, idFromParams } from "@/lib/api";
import { getDb, schema } from "@/lib/db";

const patch = z.object({ status: z.enum(["active", "off"]).optional() });

export const PATCH = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  const body = patch.parse(await req.json());
  getDb().update(schema.alerts).set({ ...body, triggeredAt: null, triggeredPrice: null }).where(eq(schema.alerts.id, id)).run();
  return json(getDb().select().from(schema.alerts).where(eq(schema.alerts.id, id)).get());
});

export const DELETE = handler(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  getDb().delete(schema.alerts).where(eq(schema.alerts.id, id)).run();
  return json({ ok: true });
});
