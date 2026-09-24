import { handler, json, idFromParams } from "@/lib/api";
import { updateTransaction, deleteTransaction } from "@/lib/transactions";

export const PATCH = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  return json(await updateTransaction(id, await req.json()));
});

export const DELETE = handler(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  deleteTransaction(id);
  return json({ ok: true });
});
