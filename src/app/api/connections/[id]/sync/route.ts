import { handler, json, idFromParams } from "@/lib/api";
import { runSync } from "@/lib/connections/sync";

export const POST = handler(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  return json(await runSync(id, "manual"));
});
