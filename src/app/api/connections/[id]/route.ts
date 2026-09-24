import { eq } from "drizzle-orm";
import { z } from "zod";
import { handler, json, idFromParams } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { getDb, schema } from "@/lib/db";
import { getSecret } from "@/lib/secrets";
import { deleteConnection, hasOwnKeys, switchToSharedKeys, updateConnectionKeys } from "@/lib/connections/sync";

const patch = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  accountType: z.enum(["real", "demo"]).optional(),
  receiptCost: z.enum(["market", "none"]).optional(),
  apiKey: z.string().trim().min(4).max(500).optional(),
  apiSecret: z.string().trim().min(4).max(500).optional(),
  /** eToro: terug naar de gedeelde koers-keys (de eigen keys van de koppeling vervallen) */
  useSharedKeys: z.literal(true).optional(),
});

export const PATCH = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  const body = patch.parse(await req.json());
  const db = getDb();
  const conn = db.select().from(schema.connections).where(eq(schema.connections.id, id)).get();
  if (!conn) throw new ApiError("Koppeling niet gevonden.", 404);
  if (body.useSharedKeys) {
    if (conn.provider !== "etoro") throw new ApiError("Alleen een eToro-koppeling kan de gedeelde koers-keys gebruiken.", 400);
    if (body.apiKey || body.apiSecret) throw new ApiError("Kies gedeelde keys óf vul eigen keys in, niet allebei.", 400);
    // de eigen keys vervallen: zonder gedeelde set zou de koppeling (en de eToro-koersen) geen keys meer hebben
    if (!getSecret("etoroApiKey") || !getSecret("etoroUserKey")) throw new ApiError("Er zijn nog geen gedeelde eToro-keys; vul ze eerst in bij Koersen en planning.", 400);
  }
  // van gedeelde naar eigen keys: één key alleen zou een halve set opleveren en de koppeling breken
  if (conn.provider === "etoro" && !hasOwnKeys(id) && !!body.apiKey !== !!body.apiSecret) throw new ApiError("Vul beide eigen keys in (API Key en User Key).", 400);
  const set: Record<string, string> = {};
  if (body.label) set.label = body.label;
  if (body.accountType) set.accountType = body.accountType;
  if (body.receiptCost) set.receiptCost = body.receiptCost;
  if (Object.keys(set).length) db.update(schema.connections).set(set).where(eq(schema.connections.id, id)).run();
  if (body.useSharedKeys) switchToSharedKeys(id);
  else updateConnectionKeys(id, body.apiKey, body.apiSecret);
  return json(db.select().from(schema.connections).where(eq(schema.connections.id, id)).get());
});

export const DELETE = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  const withTx = new URL(req.url).searchParams.get("transactions") === "1";
  deleteConnection(id, withTx);
  return json({ ok: true });
});
