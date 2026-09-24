import { z } from "zod";
import { handler, json, idFromParams } from "@/lib/api";
import { bookCorrection } from "@/lib/connections/sync";

const input = z.object({ symbol: z.string().min(1).max(20) });

export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  const { symbol } = input.parse(await req.json());
  const txId = await bookCorrection(id, symbol);
  return json({ ok: true, transactionId: txId }, { status: 201 });
});
