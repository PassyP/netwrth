import { z } from "zod";
import { handler, json, idFromParams } from "@/lib/api";
import { deletePlatform, PLATFORM_TYPES, updatePlatform } from "@/lib/platforms";

const patch = z.object({ name: z.string().trim().min(1).max(60).optional(), type: z.enum(PLATFORM_TYPES).optional() });

export const PATCH = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  return json(updatePlatform(id, patch.parse(await req.json())));
});

/** ?everything=1: ook alle transacties en koppelingen van het platform verwijderen (bevestigd in de UI). */
export const DELETE = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const withEverything = new URL(req.url).searchParams.get("everything") === "1";
  const removed = deletePlatform(await idFromParams(ctx), { withEverything });
  return json({ ok: true, ...removed });
});
