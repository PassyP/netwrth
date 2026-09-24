import { handler, json, idFromParams } from "@/lib/api";
import { addValuation } from "@/lib/assets";

export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  addValuation(id, await req.json());
  return json({ ok: true }, { status: 201 });
});
