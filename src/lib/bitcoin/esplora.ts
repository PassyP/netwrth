/**
 * Leesclient voor de Esplora/mempool-REST-API van de eigen node (Umbrel mempool-app, dezelfde paden als mempool.space).
 * Geen key nodig, geen rate limit op een eigen node; wel bescheiden concurrency en time-outs. Foutmeldingen noemen alleen
 * host en HTTP-status — nooit een adres, want meldingen komen in logs, de UI en push-berichten terecht.
 */
export interface EsploraStats {
  funded_txo_count: number;
  funded_txo_sum: number; // satoshi
  spent_txo_count: number;
  spent_txo_sum: number;
  tx_count: number;
}

export interface EsploraAddressStats {
  address: string;
  chain_stats: EsploraStats;
  mempool_stats: EsploraStats;
}

export interface EsploraPrevout {
  scriptpubkey_address?: string;
  value: number;
}

export interface EsploraVin {
  txid: string;
  vout: number;
  is_coinbase: boolean;
  prevout: EsploraPrevout | null;
}

export interface EsploraVout {
  scriptpubkey_address?: string;
  value: number;
}

export interface EsploraTxStatus {
  confirmed: boolean;
  block_height?: number;
  block_time?: number; // unix-seconden
}

export interface EsploraTx {
  txid: string;
  vin: EsploraVin[];
  vout: EsploraVout[];
  fee: number; // satoshi
  status: EsploraTxStatus;
}

/**
 * Herkenbare User-Agent: publieke mempool-instanties weigeren de standaard-UA van Node ("node") met HTTP 429, los van
 * het aantal verzoeken; met een eigen naam antwoorden ze normaal.
 */
export const USER_AGENT = "Netwrth/0.1 (portfolio-tracker; Esplora-client)";

/** Tijdelijke storingen die een herhaalpoging verdienen; een geweigerde verbinding of onbekende host niet (die zijn meteen duidelijk). */
const TRANSIENT = new Set(["TimeoutError", "AbortError", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]);

function causeOf(e: unknown): string {
  return (e as { cause?: { code?: string } })?.cause?.code ?? (e instanceof Error ? e.name : String(e));
}

export class EsploraError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly kind: "network" | "timeout" | "http" | "parse"
  ) {
    super(message);
    this.name = "EsploraError";
  }
}

/** Zonder slash of "/api" aan het eind: de paden hieronder beginnen zelf met /api. */
export function normalizeBitcoinApiUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "")
    .replace(/\/+$/, "");
}

export function requireBitcoinApiUrl(url: string | null | undefined): string {
  const u = url ? normalizeBitcoinApiUrl(url) : "";
  if (!u) throw new Error("Geen Bitcoin-node ingesteld: vul de URL van de mempool-app in bij Instellingen → Platforms en koppelingen → Bitcoin-node (bijv. http://10.21.21.26:3006).");
  if (!/^https?:\/\//i.test(u)) throw new Error("De URL van de Bitcoin-node moet met http:// of https:// beginnen.");
  return u;
}

export interface EsploraClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  concurrency?: number; // standaard 6
  timeoutMs?: number; // standaard 15 s
  maxPages?: number; // standaard 500 pagina's per adres
  /** basiswachttijd na HTTP 429 (verdubbelt per poging, Retry-After gaat voor) of een netwerkfout/time-out; standaard 3 s */
  retryDelayMs?: number;
  /** herhalingen bij een netwerkfout of time-out (standaard 2); HTTP 429 krijgt er altijd 5 */
  retries?: number;
  /** minimale tussentijd tussen twee verzoeken (publieke node met rate limit); standaard 0 */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface EsploraClient {
  readonly baseUrl: string;
  /** Hoogte van de laatste blok (ook de verbindingstest). */
  tipHeight(): Promise<number>;
  addressStats(address: string): Promise<EsploraAddressStats>;
  /**
   * Alle transacties van een adres: mempool plus bevestigd, gepagineerd met after_txid tot een lege pagina. De
   * paginagrootte wordt niet aangenomen (Esplora 25, mempool-backend in Electrum-modus 10).
   */
  addressTxs(address: string): Promise<EsploraTx[]>;
  /** Parallel met een vaste bovengrens; volgorde van het resultaat = volgorde van de invoer. */
  mapLimit<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]>;
}

export function makeEsploraClient(opts: EsploraClientOptions): EsploraClient {
  const baseUrl = normalizeBitcoinApiUrl(opts.baseUrl);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const timeoutMs = opts.timeoutMs ?? 15000;
  const maxPages = opts.maxPages ?? 500;
  const retryDelayMs = opts.retryDelayMs ?? 3000;
  const retries = opts.retries ?? 2;
  const minIntervalMs = opts.minIntervalMs ?? 0;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  let nextSlot = 0;
  /** Verdeelt de verzoeken in de tijd (ook over de parallelle workers heen). */
  async function gate() {
    if (!minIntervalMs) return;
    const t = now();
    const slot = Math.max(t, nextSlot);
    nextSlot = slot + minIntervalMs;
    if (slot > t) await sleep(slot - t);
  }
  const host = (() => {
    try {
      return new URL(baseUrl).host;
    } catch {
      return baseUrl;
    }
  })();

  async function get(path: string, label: string, attempt = 0): Promise<string> {
    let res: Response;
    await gate();
    try {
      res = await fetchImpl(`${baseUrl}${path}`, { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const cause = causeOf(e);
      if (attempt < retries && TRANSIENT.has(cause)) {
        await sleep(retryDelayMs * (attempt + 1)); // time-out of reset (trage publieke node): even wachten en opnieuw
        return get(path, label, attempt + 1);
      }
      if (cause === "TimeoutError")
        throw new EsploraError(`Bitcoin-node ${host} antwoordt niet binnen ${Math.round(timeoutMs / 1000)} s (time-out): de node is traag of remt dit IP af; publieke nodes doen dat na veel verzoeken. Probeer het later opnieuw of kies een andere node.`, null, "timeout");
      // .local-namen (Bonjour/mDNS) werken alleen op de eigen computer: in een container (Umbrel-app) zijn ze onbekend of
      // wijzen ze naar de container zelf, waar niets op de poort luistert
      if ((cause === "ENOTFOUND" || cause === "ECONNREFUSED") && /\.local(:\d+)?$/i.test(host))
        throw new EsploraError(`Bitcoin-node ${host} niet bereikbaar (${cause}): een .local-naam werkt niet binnen een container zoals de Umbrel-app. Gebruik daar het IP-adres; voor de mempool-app op Umbrel is dat http://10.21.21.26:3006.`, null, "network");
      throw new EsploraError(`Bitcoin-node niet bereikbaar op ${host} (${cause}).`, null, "network");
    }
    if (res.status === 429 && attempt < 5) {
      // publieke node remt af: Retry-After volgen, anders verdubbelend wachten (3, 6, 12, 24, 48 s bij de standaard)
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 120_000) : retryDelayMs * 2 ** attempt;
      await sleep(wait);
      return get(path, label, attempt + 1);
    }
    if (!res.ok) throw new EsploraError(`Bitcoin-node ${host}: HTTP ${res.status} bij ${label}.`, res.status, "http");
    return res.text();
  }

  async function getJson<T>(path: string, label: string, check: (v: unknown) => v is T): Promise<T> {
    const text = await get(path, label);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new EsploraError(`Bitcoin-node ${host}: geen JSON bij ${label} (is dit de URL van de mempool-app?).`, null, "parse");
    }
    if (!check(data)) throw new EsploraError(`Bitcoin-node ${host}: onverwacht antwoord bij ${label}.`, null, "parse");
    return data;
  }

  const isStats = (v: unknown): v is EsploraAddressStats => {
    const o = v as EsploraAddressStats;
    return !!o && typeof o === "object" && !!o.chain_stats && typeof o.chain_stats.tx_count === "number" && !!o.mempool_stats && typeof o.mempool_stats.tx_count === "number";
  };
  const isTxList = (v: unknown): v is EsploraTx[] => Array.isArray(v) && v.every((t) => t && typeof t.txid === "string" && Array.isArray(t.vin) && Array.isArray(t.vout) && !!t.status);

  async function mapLimit<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  return {
    baseUrl,
    async tipHeight() {
      const text = (await get("/api/blocks/tip/height", "blokhoogte")).trim();
      const h = Number(text);
      if (!Number.isInteger(h) || h <= 0) throw new EsploraError(`Bitcoin-node ${host}: geen blokhoogte ontvangen (is dit de URL van de mempool-app?).`, null, "parse");
      return h;
    },
    addressStats(address) {
      return getJson(`/api/address/${address}`, "adres", isStats);
    },
    async addressTxs(address) {
      const out = new Map<string, EsploraTx>();
      // neemt een pagina op; geeft het aantal nieuwe transacties en de laatste bevestigde txid van de pagina terug
      const absorb = (list: EsploraTx[]) => {
        let fresh = 0;
        let lastConfirmed: string | null = null;
        for (const tx of list) {
          if (!out.has(tx.txid)) {
            out.set(tx.txid, tx);
            fresh++;
          }
          if (tx.status.confirmed) lastConfirmed = tx.txid;
        }
        return { fresh, lastConfirmed };
      };
      let { lastConfirmed } = absorb(await getJson(`/api/address/${address}/txs`, "adrestransacties", isTxList));
      // Vervolgpagina's: de mempool-backend kent `?after_txid=` op /txs, standaard-Esplora (Blockstream) kent
      // /txs/chain/:last_seen_txid en negeert de query. De eerste stijl die nieuwe transacties oplevert, wordt aangehouden.
      let style: "query" | "path" | null = null;
      const fetchPage = async (which: "query" | "path", last: string): Promise<EsploraTx[]> => {
        if (which === "query") return getJson(`/api/address/${address}/txs?after_txid=${last}`, "adrestransacties", isTxList);
        try {
          return await getJson(`/api/address/${address}/txs/chain/${last}`, "adrestransacties", isTxList);
        } catch (e) {
          if (e instanceof EsploraError && e.kind === "http" && e.status === 404) return []; // node zonder deze route
          throw e;
        }
      };
      for (let page = 1; page < maxPages && lastConfirmed; page++) {
        let next: { fresh: number; lastConfirmed: string | null } | null = null;
        const styles: ("query" | "path")[] = style ? [style] : ["query", "path"];
        for (const which of styles) {
          const r = absorb(await fetchPage(which, lastConfirmed));
          if (r.fresh > 0) {
            style = which;
            next = r;
            break;
          }
        }
        if (!next) break; // geen van beide stijlen levert nog iets: einde van de historie
        lastConfirmed = next.lastConfirmed;
      }
      return [...out.values()];
    },
    mapLimit,
  };
}

/**
 * Adres voor de verbindingstest: geldig maar nooit gebruikt (P2WPKH met als hash de eerste 20 bytes van
 * sha256("netwrth adresindex-probe")), zodat de lookup op elke Esplora/mempool-backend meteen antwoordt met tx_count 0.
 * Niet het genesis-adres: dat heeft tienduizenden transacties, en Electrs (romanz, de Electrum-server van Umbrel) handelt
 * verzoeken één voor één af en doet daar ~10 minuten over per aanroep; mempool vraagt balans én historie en breekt niets
 * af, dus elke test legde de node urenlang vast.
 */
export const PROBE_ADDRESS = "bc1qvxa227a088uu97kc74ysak5vrlachqalshxm7c";

export interface ProbeResult {
  ok: boolean;
  message: string;
  height?: number;
}

/** Verbindingstest: blokhoogte én een adreslookup, want zonder Electrs geeft de mempool-app wel blokken maar geen adressen. */
export async function probeNode(client: EsploraClient): Promise<ProbeResult> {
  let height: number;
  try {
    height = await client.tipHeight();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  try {
    await client.addressStats(PROBE_ADDRESS);
  } catch (e) {
    if (e instanceof EsploraError && e.kind === "http" && [404, 500, 501].includes(e.status ?? 0)) {
      return { ok: false, message: `Node bereikbaar (blokhoogte ${height}), maar adreslookups werken niet (HTTP ${e.status}): de mempool-app heeft de Electrs-app nodig, en die moet klaar zijn met indexeren.`, height };
    }
    // de blokhoogte komt uit het geheugen van de mempool-app; een adres gaat via Electrs, dat dan vastzit of bezig is
    if (e instanceof EsploraError && e.kind === "timeout") {
      return { ok: false, message: `Node bereikbaar (blokhoogte ${height}), maar een adreslookup antwoordt niet: de Electrum-server achter de mempool-app (Electrs) is bezet of vastgelopen. Herstart de Electrs-app op je Umbrel en test opnieuw.`, height };
    }
    return { ok: false, message: e instanceof Error ? e.message : String(e), height };
  }
  return { ok: true, message: `Node bereikbaar: blokhoogte ${height}, adresindex OK.`, height };
}
