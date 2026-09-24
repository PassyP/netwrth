/**
 * Keuze van de Bitcoin-node volgens de instellingen: de eigen node (Umbrel mempool-app) is de bron; staat de terugval
 * aan en is de eigen node onbereikbaar (of niet ingesteld), dan de publieke node. Een publieke node ziet de adressen
 * van de wallet — daarom is de terugval standaard uit en meldt elke sync wanneer hij is gebruikt.
 */
import { makeEsploraClient, requireBitcoinApiUrl, type EsploraClient } from "./esplora";

export interface BitcoinNodeSettings {
  bitcoinApiUrl: string;
  bitcoinFallbackEnabled: boolean;
  bitcoinFallbackUrl: string;
}

export interface BitcoinNodeChoice {
  client: EsploraClient;
  source: "own" | "fallback";
  tipHeight: number;
  /** melding voor het syncrapport als de publieke node is gebruikt */
  warnings: string[];
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Publieke nodes hanteren een rate limit en vertragen antwoorden soms tot tientallen seconden: minder gelijktijdig, ruime time-out. */
const FALLBACK_CONCURRENCY = 2;
const FALLBACK_TIMEOUT_MS = 90_000;
const FALLBACK_MIN_INTERVAL_MS = 1000; // 1 verzoek/s: publieke instanties blokkeren een IP al bij ~100 verzoeken per minuut (blockstream.info, mempool.emzy.de)

export async function connectBitcoinNode(settings: BitcoinNodeSettings, fetchImpl?: typeof fetch): Promise<BitcoinNodeChoice> {
  const fallbackUrl = settings.bitcoinFallbackEnabled ? requireBitcoinApiUrl(settings.bitcoinFallbackUrl) : null;
  let ownError: Error | null = null;
  const own = settings.bitcoinApiUrl.trim();
  if (own) {
    const client = makeEsploraClient({ baseUrl: requireBitcoinApiUrl(own), fetchImpl });
    try {
      return { client, source: "own", tipHeight: await client.tipHeight(), warnings: [] };
    } catch (e) {
      ownError = e instanceof Error ? e : new Error(String(e));
      if (!fallbackUrl) throw ownError;
    }
  } else if (!fallbackUrl) {
    requireBitcoinApiUrl(""); // gooit de standaardmelding "Geen Bitcoin-node ingesteld"
  }
  const client = makeEsploraClient({ baseUrl: fallbackUrl!, fetchImpl, concurrency: FALLBACK_CONCURRENCY, timeoutMs: FALLBACK_TIMEOUT_MS, minIntervalMs: FALLBACK_MIN_INTERVAL_MS });
  let tipHeight: number;
  try {
    tipHeight = await client.tipHeight();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(ownError ? `Eigen node: ${ownError.message} Publieke node ook niet bereikbaar: ${msg}` : `Publieke node: ${msg}`);
  }
  const why = ownError ? `Eigen node onbereikbaar (${ownError.message})` : "Geen eigen node ingesteld";
  return { client, source: "fallback", tipHeight, warnings: [`${why}; teruggevallen op de publieke node ${hostOf(fallbackUrl!)}. Let op: die node ziet de adressen van je wallet.`] };
}
