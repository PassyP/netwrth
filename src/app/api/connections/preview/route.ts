import { z } from "zod";
import { eq } from "drizzle-orm";
import { handler, json } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { PROVIDERS } from "@/lib/db/schema";
import { countReplaceable, previewPlatform } from "@/lib/connections/sync";

const input = z.object({ provider: z.enum(PROVIDERS), label: z.string().max(60).default(""), portfolioId: z.coerce.number().int().positive(), platformId: z.coerce.number().int().positive().optional() });

/**
 * Wizard stap 4: op welk platform de koppeling komt en hoeveel handmatige en geïmporteerde transacties "Vervangen" daar
 * in dit portfolio zou verwijderen. Er wordt niets aangemaakt.
 */
export const POST = handler(async (req) => {
  const body = input.parse(await req.json());
  let platform: { platformId: number | null; name: string; type: string };
  if (body.platformId) {
    const p = getDb().select().from(schema.platforms).where(eq(schema.platforms.id, body.platformId)).get();
    if (!p) return json({ error: "Platform niet gevonden." }, { status: 404 });
    platform = { platformId: p.id, name: p.name, type: p.type };
  } else {
    platform = previewPlatform(body.provider, body.label);
  }
  const replaceable = platform.platformId != null ? countReplaceable(platform.platformId, body.portfolioId) : 0;
  return json({ ...platform, exists: platform.platformId != null, replaceable });
});
