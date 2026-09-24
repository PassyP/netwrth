import { z } from "zod";
import { handler, json } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { getSettings } from "@/lib/settings";
import { connectBitcoinNode } from "@/lib/bitcoin/node";
import { discoverAccounts } from "@/lib/bitcoin/discover";
import { EsploraError } from "@/lib/bitcoin/esplora";

const input = z.object({ keys: z.array(z.string().max(120)).min(1).max(20), allTypes: z.boolean().optional() });

/**
 * Accountontdekking vóór het opslaan (wizard en bewerken): stateless, de xpubs komen niet terug in het antwoord en
 * worden niet gelogd; een fout van de node noemt alleen host en status.
 */
export const POST = handler(async (req) => {
  const body = input.parse(await req.json());
  let node;
  try {
    node = await connectBitcoinNode(getSettings());
  } catch (e) {
    // geen node ingesteld = invoer/instelling (400); node onbereikbaar = tijdelijk (503); geen serverfout
    throw new ApiError(e instanceof Error ? e.message : String(e), e instanceof EsploraError ? 503 : 400);
  }
  const r = await discoverAccounts(body.keys, { client: node.client, allTypes: body.allTypes });
  return json({ candidates: r.candidates, warnings: [...node.warnings, ...r.warnings], source: node.source, tipHeight: node.tipHeight });
});
