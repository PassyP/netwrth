import { z } from "zod";
import { handler, json } from "@/lib/api";
import { getSettings } from "@/lib/settings";
import { makeEsploraClient, probeNode, requireBitcoinApiUrl } from "@/lib/bitcoin/esplora";

const input = z.object({ url: z.string().trim().max(300).optional() });

/** Verbindingstest voor de Bitcoin-node: de meegegeven URL (nog niet opgeslagen) of anders de ingestelde. */
export const POST = handler(async (req) => {
  const body = input.parse(await req.json().catch(() => ({})));
  try {
    const baseUrl = requireBitcoinApiUrl(body.url || getSettings().bitcoinApiUrl);
    // zelfde geduld als een echte sync met een publieke node: die antwoorden soms pas na tientallen seconden
    return json(await probeNode(makeEsploraClient({ baseUrl, timeoutMs: 60_000 })));
  } catch (e) {
    return json({ ok: false, message: e instanceof Error ? e.message : String(e) });
  }
});
