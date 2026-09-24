import { z } from "zod";
import { handler, json, idFromParams } from "@/lib/api";
import { setManualPrice } from "@/lib/assets";

const input = z.object({ price: z.string().regex(/^\d+(\.\d+)?$/), currency: z.string().min(3).max(3), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  const body = input.parse(await req.json());
  setManualPrice(id, body.price, body.currency, body.date);
  return json({ ok: true }, { status: 201 });
});
