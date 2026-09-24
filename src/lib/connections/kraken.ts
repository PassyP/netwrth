import crypto from "node:crypto";
import Decimal from "decimal.js";
import type { Currency, TxType } from "../db/schema";
import { CURRENCIES } from "../db/schema";
import type { BalanceRow, ConnectionProvider, Credentials, NormalizedTx, SyncOutput, TestOutput } from "./types";

/**
 * Kraken Spot REST API — https://docs.kraken.com/api/
 * Private endpoints: POST met headers API-Key en API-Sign.
 * API-Sign = HMAC-SHA512( path + SHA256(nonce + postData), base64decode(secret) ), base64.
 * Rate limit: teller max 15 (Starter) / 20 (Intermediate, Pro); TradesHistory en Ledgers tellen 2, rest 1; verval 0,33/s.
 */
const BASE = process.env.KRAKEN_BASE_URL || "https://api.kraken.com";
export const FIAT = new Set<string>(["EUR", "USD", "GBP", "CHF", "CAD", "JPY", "AUD"]);
const APP_CURRENCIES = new Set<string>(CURRENCIES);
/** Voorkeursvolgorde van de quote-munt voor de Kraken-koersbron. */
const QUOTE_PREFERENCE: readonly string[] = ["EUR", "USD", "GBP", "CHF"];

export function krakenSign(path: string, nonce: string, postData: string, secretB64: string): string {
  const sha = crypto.createHash("sha256").update(nonce + postData).digest();
  const hmac = crypto.createHmac("sha512", Buffer.from(secretB64, "base64"));
  hmac.update(Buffer.concat([Buffer.from(path, "utf8"), sha]));
  return hmac.digest("base64");
}

/** Kraken-assetcode → symbool in de app: XXBT/XBT → BTC, ZEUR → EUR, ETH2.S → ETH, DOT.S → DOT. */
export function normalizeKrakenAsset(code: string, altname?: string): string {
  let s = (altname ?? code).toUpperCase();
  if (!altname) {
    if (/^[XZ][A-Z]{3}$/.test(s) && s !== "XBT") s = s.slice(1); // XXBT → XBT, ZEUR → EUR
  }
  s = s.replace(/\.(S|M|F|P|B|HOLD)$/i, "");
  if (s === "XBT") return "BTC";
  if (s === "XDG") return "DOGE";
  if (s === "ETH2") return "ETH";
  if (s === "ETHW") return "ETHW";
  return s;
}

export interface KrakenTrade {
  ordertxid: string;
  pair: string;
  time: number;
  type: "buy" | "sell";
  ordertype: string;
  price: string;
  cost: string;
  fee: string;
  vol: string;
  margin?: string;
  misc?: string;
  trade_id?: number;
}

export interface KrakenLedger {
  refid: string;
  time: number;
  type: string;
  subtype?: string;
  aclass: string;
  asset: string;
  amount: string;
  fee: string;
  balance: string;
}

/** Handelspaar uit AssetPairs; `key` is de canonieke sleutel (XXBTZEUR), ook als het paar via altname is opgezocht. */
export interface KrakenPairInfo {
  key: string;
  altname: string;
  base: string;
  quote: string;
  status?: string; // online, cancel_only, post_only, limit_only, reduce_only
  aclass_base?: string; // "currency" voor crypto; "tokenized_asset" voor xStocks (AAPLx …), die de koersbron niet kent
}

interface KrakenResponse<T> {
  error: string[];
  result: T;
}

type FetchImpl = typeof fetch;

/** Eenvoudige tellerbegrenzer volgens het Kraken-model (max 15, verval 0,33/s). */
class Limiter {
  private counter = 0;
  private last = Date.now();
  constructor(private max = 15, private decayPerSec = 0.33, private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}
  async take(cost: number) {
    const now = Date.now();
    this.counter = Math.max(0, this.counter - ((now - this.last) / 1000) * this.decayPerSec);
    this.last = now;
    if (this.counter + cost > this.max) {
      const waitSec = (this.counter + cost - this.max) / this.decayPerSec;
      await this.sleep(Math.ceil(waitSec * 1000));
      this.counter = Math.max(0, this.counter - waitSec * this.decayPerSec);
      this.last = Date.now();
    }
    this.counter += cost;
  }
}

const limiters = new Map<string, Limiter>();
const lastNonce = new Map<string, number>();

export interface KrakenClientOptions {
  fetchImpl?: FetchImpl;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  initialNonce?: number;
}

export class KrakenClient {
  private fetchImpl: FetchImpl;
  private now: () => number;
  private limiter: Limiter;
  private assetsCache: Record<string, { altname: string }> | null = null;
  private pairsCache: Record<string, KrakenPairInfo> | null = null;
  private ohlcCache = new Map<string, Map<string, number>>(); // pair → day → close
  private tradePriceCache = new Map<string, number | null>(); // pair|dag → koers uit de publieke tradelijst

  /** Zonder creds (null) werken alleen de publieke endpoints; zie krakenPublicClient. */
  constructor(private creds: Credentials | null, opts: KrakenClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    const key = creds ? creds.apiKey.slice(0, 12) : "public";
    if (!limiters.has(key)) limiters.set(key, new Limiter(15, 0.33, opts.sleep));
    this.limiter = limiters.get(key)!;
    if (creds && opts.initialNonce && (lastNonce.get(key) ?? 0) < opts.initialNonce) lastNonce.set(key, opts.initialNonce);
  }

  nextNonce(): string {
    if (!this.creds) throw new Error("Kraken: privé-endpoint zonder API-key.");
    const key = this.creds.apiKey.slice(0, 12);
    const n = Math.max(this.now(), (lastNonce.get(key) ?? 0) + 1);
    lastNonce.set(key, n);
    return String(n);
  }

  get lastNonceValue(): number {
    return this.creds ? (lastNonce.get(this.creds.apiKey.slice(0, 12)) ?? 0) : 0;
  }

  async publicGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    await this.limiter.take(1);
    const url = new URL(`/0/public/${path}`, BASE);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    const data = (await res.json()) as KrakenResponse<T>;
    if (data.error?.length) throw new Error(`Kraken: ${data.error.join("; ")}`);
    return data.result;
  }

  async privatePost<T>(path: string, params: Record<string, string> = {}, attempt = 0): Promise<T> {
    const creds = this.creds;
    if (!creds) throw new Error("Kraken: privé-endpoint zonder API-key.");
    const heavy = path === "TradesHistory" || path === "Ledgers";
    await this.limiter.take(heavy ? 2 : 1);
    const uriPath = `/0/private/${path}`;
    const nonce = this.nextNonce();
    const body = new URLSearchParams({ nonce, ...params }).toString();
    const res = await this.fetchImpl(new URL(uriPath, BASE), {
      method: "POST",
      headers: {
        "API-Key": creds.apiKey,
        "API-Sign": krakenSign(uriPath, nonce, body, creds.apiSecret),
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(30000),
    });
    const data = (await res.json()) as KrakenResponse<T>;
    if (data.error?.length) {
      const msg = data.error.join("; ");
      if ((msg.includes("Rate limit") || msg.includes("Invalid nonce")) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        return this.privatePost<T>(path, params, attempt + 1);
      }
      if (msg.includes("Permission denied")) throw new Error(`Kraken: geen rechten voor ${path} — zet de leesrechten aan bij de API-key (${msg}).`);
      if (msg.includes("Invalid key") || msg.includes("Invalid signature")) throw new Error(`Kraken: key of secret ongeldig (${msg}).`);
      throw new Error(`Kraken ${path}: ${msg}`);
    }
    return data.result;
  }

  async assets(): Promise<Record<string, { altname: string }>> {
    if (!this.assetsCache) this.assetsCache = await this.publicGet<Record<string, { altname: string }>>("Assets");
    return this.assetsCache;
  }

  async pairs(): Promise<Record<string, KrakenPairInfo>> {
    if (!this.pairsCache) {
      const raw = await this.publicGet<Record<string, Omit<KrakenPairInfo, "key">>>("AssetPairs");
      // onder de canonieke sleutel én via altname vindbaar (zelfde object)
      const out: Record<string, KrakenPairInfo> = {};
      for (const [k, v] of Object.entries(raw)) {
        const entry: KrakenPairInfo = { ...v, key: k };
        out[k] = entry;
        out[v.altname] = entry;
      }
      this.pairsCache = out;
    }
    return this.pairsCache;
  }

  async symbolOf(code: string): Promise<string> {
    const assets = await this.assets().catch(() => ({}) as Record<string, { altname: string }>);
    return normalizeKrakenAsset(code, assets[code]?.altname);
  }

  private eurPairAlt(symbol: string): string {
    return `${symbol === "BTC" ? "XBT" : symbol === "DOGE" ? "XDG" : symbol}EUR`;
  }

  /** Dagslot van <asset>/EUR uit OHLC; alleen binnen het venster dat Kraken teruggeeft (zie priceInEur). */
  private async dailyCloseInEur(pairAlt: string, day: string): Promise<number | null> {
    if (!this.ohlcCache.has(pairAlt)) {
      const since = String(Math.floor(new Date(day + "T00:00:00Z").getTime() / 1000) - 3 * 86400);
      try {
        const r = await this.publicGet<Record<string, unknown>>("OHLC", { pair: pairAlt, interval: "1440", since });
        const m = new Map<string, number>();
        for (const [k, v] of Object.entries(r)) {
          if (k === "last" || !Array.isArray(v)) continue;
          for (const c of v as [number, string, string, string, string][]) m.set(new Date(c[0] * 1000).toISOString().slice(0, 10), Number(c[4]));
        }
        this.ohlcCache.set(pairAlt, m);
      } catch {
        this.ohlcCache.set(pairAlt, new Map());
      }
    }
    const m = this.ohlcCache.get(pairAlt)!;
    // laatste dag ≤ day
    let bestDay = "";
    let best: number | null = null;
    for (const [d, close] of m) {
      if (d <= day && d >= bestDay) {
        bestDay = d;
        best = close;
      }
    }
    return best;
  }

  /** Laatste publieke trade op of vlak vóór een moment (gecachet per pair en dag). */
  private async tradePriceInEur(pairAlt: string, atSec: number, day: string): Promise<number | null> {
    const key = `${pairAlt}|${day}`;
    if (!this.tradePriceCache.has(key)) {
      let price: number | null = null;
      try {
        const r = await this.publicGet<Record<string, unknown>>("Trades", { pair: pairAlt, since: String(Math.floor(atSec - 86400)) });
        for (const [k, v] of Object.entries(r)) {
          if (k === "last" || !Array.isArray(v)) continue;
          let first: number | null = null;
          let atOrBefore: number | null = null;
          for (const row of v as [string, string, number][]) {
            if (first == null) first = Number(row[0]);
            if (row[2] > atSec) break;
            atOrBefore = Number(row[0]);
          }
          // niets vóór het moment (dun verhandeld paar): de eerstvolgende trade is de dichtstbijzijnde koers
          price = atOrBefore ?? first;
        }
      } catch {
        price = null; // paar bestaat niet (meer)
      }
      this.tradePriceCache.set(key, price);
    }
    return this.tradePriceCache.get(key)!;
  }

  /**
   * Koers van <symbool>/EUR op een moment, voor crypto-naar-crypto trades en overboekingen.
   * OHLC geeft hoogstens 720 dagcandles terug, ongeacht `since`, dus voor oudere transacties (de eerste import haalt de
   * hele historie op) valt de app terug op de publieke tradelijst rond dat moment. Zonder die terugval kreeg alles van
   * vóór dat venster kostprijs 0.
   */
  async priceInEur(symbol: string, iso: string): Promise<number | null> {
    if (symbol === "EUR") return 1;
    const pairAlt = this.eurPairAlt(symbol);
    const day = iso.slice(0, 10);
    const close = await this.dailyCloseInEur(pairAlt, day);
    if (close != null) return close;
    return this.tradePriceInEur(pairAlt, Date.parse(iso) / 1000, day);
  }

  async balance(): Promise<Record<string, string>> {
    return this.privatePost<Record<string, string>>("Balance");
  }

  async tradesSince(startSec: number): Promise<(KrakenTrade & { id: string })[]> {
    const out: (KrakenTrade & { id: string })[] = [];
    let ofs = 0;
    for (let page = 0; page < 200; page++) {
      const params: Record<string, string> = { ofs: String(ofs), trades: "true" };
      if (startSec > 0) params.start = String(startSec);
      const r = await this.privatePost<{ count: number; trades: Record<string, KrakenTrade> }>("TradesHistory", params);
      const entries = Object.entries(r.trades ?? {});
      if (entries.length === 0) break;
      for (const [id, t] of entries) out.push({ ...t, id });
      ofs += entries.length;
      if (ofs >= (r.count ?? 0)) break;
    }
    return out.sort((a, b) => a.time - b.time);
  }

  async ledgerSince(startSec: number): Promise<(KrakenLedger & { id: string })[]> {
    const out: (KrakenLedger & { id: string })[] = [];
    let ofs = 0;
    for (let page = 0; page < 200; page++) {
      const params: Record<string, string> = { ofs: String(ofs) };
      if (startSec > 0) params.start = String(startSec);
      const r = await this.privatePost<{ count: number; ledger: Record<string, KrakenLedger> }>("Ledgers", params);
      const entries = Object.entries(r.ledger ?? {});
      if (entries.length === 0) break;
      for (const [id, l] of entries) out.push({ ...l, id });
      ofs += entries.length;
      if (ofs >= (r.count ?? 0)) break;
    }
    return out.sort((a, b) => a.time - b.time);
  }
}

/** Client voor alleen de publieke endpoints (koersen op een tijdstip voor bijv. on-chain overboekingen); geen key nodig. */
export function krakenPublicClient(opts: KrakenClientOptions = {}): KrakenClient {
  return new KrakenClient(null, opts);
}

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

function toCurrency(sym: string): Currency | null {
  return APP_CURRENCIES.has(sym) ? (sym as Currency) : null;
}

/** Valuta die Kraken wel verhandelt maar de app niet kent (CAD, JPY, AUD): geen positie en geen kas — alleen melden. */
function isForeignFiat(sym: string): boolean {
  return FIAT.has(sym) && !toCurrency(sym);
}

/** Koerspaar per Kraken-basiscode (XXBT) en per symbool (BTC), voor de Kraken-koersbron. */
export interface KrakenPriceHints {
  byCode: Map<string, string>;
  bySymbol: Map<string, string>;
}

/**
 * Bepaalt per basisasset het voorkeurspaar als koersbron: quote EUR > USD > GBP > CHF, alleen aclass_base "currency"
 * en sleutels zonder "." (dark pool) — dezelfde selectie als de pairlijst van de koersbron (src/lib/prices/kraken.ts),
 * anders zou een sync een paar aanwijzen dat de verversronde niet kent (tokenized assets zoals AAPLxEUR). De status
 * (online, cancel_only, post_only …) is net als daar géén filter: Kraken pauzeert de handel geregeld per pair of
 * exchange-breed terwijl Ticker en OHLC gewoon koersen blijven geven. Zou de status hier wél meetellen, dan kreeg elk
 * asset dat tijdens zo'n pauze voor het eerst binnenkomt blijvend een Yahoo-feed (een latere sync vult alleen een
 * ontbrekende bron aan) — voor munten die Yahoo niet onder <SYM>-EUR kent betekent dat helemaal geen koers.
 * De waarde is de canonieke AssetPairs-sleutel (XXBTZEUR, SOLEUR).
 */
export function krakenPriceHints(pairs: Record<string, KrakenPairInfo>, assets: Record<string, { altname: string }> = {}): KrakenPriceHints {
  const byCode = new Map<string, { key: string; rank: number }>();
  const bySymbol = new Map<string, { key: string; rank: number }>();
  const consider = (map: Map<string, { key: string; rank: number }>, id: string, key: string, rank: number) => {
    const cur = map.get(id);
    if (!cur || rank < cur.rank) map.set(id, { key, rank });
  };
  for (const [k, p] of Object.entries(pairs)) {
    if (k !== p.key || k.includes(".") || (p.aclass_base ?? "currency") !== "currency") continue;
    const rank = QUOTE_PREFERENCE.indexOf(normalizeKrakenAsset(p.quote, assets[p.quote]?.altname));
    if (rank < 0) continue;
    consider(byCode, p.base, k, rank);
    consider(bySymbol, normalizeKrakenAsset(p.base, assets[p.base]?.altname), k, rank);
  }
  const flatten = (m: Map<string, { key: string; rank: number }>) => new Map([...m].map(([id, v]) => [id, v.key]));
  return { byCode: flatten(byCode), bySymbol: flatten(bySymbol) };
}

/** Pairlijst ophalen (gecachet per client) of de sync afbreken met een duidelijke fout; zie normalizeKraken. */
async function requirePairs(client: KrakenClient): Promise<Record<string, KrakenPairInfo>> {
  try {
    return await client.pairs();
  } catch (e) {
    throw new Error(`Kraken: pairlijst (AssetPairs) niet beschikbaar — ${e instanceof Error ? e.message : String(e)}. Sync afgebroken zodat nieuwe assets niet zonder Kraken-koersbron worden aangemaakt; probeer later opnieuw.`);
  }
}

/** Werkelijke saldomutatie van een grootboekregel: Kraken boekt `amount` en schrijft `fee` daar apart van af. */
function ledgerDelta(l: KrakenLedger): Decimal {
  return new Decimal(l.amount).minus(l.fee);
}

/**
 * De twee grootboekregels van een trade: de basispoot beweegt met de richting van de order (koop = erbij), de
 * quote-poot tegengesteld. Hieruit volgen de echte aantallen én de assetcodes, ook voor paren die Kraken inmiddels
 * heeft geschrapt en dus niet meer in AssetPairs staan.
 */
function tradeLegs(t: KrakenTrade & { id: string }, entries: (KrakenLedger & { id: string })[]): { base: { asset: string; delta: Decimal }; quote: { asset: string; delta: Decimal } } | null {
  const rows = entries.filter((l) => l.type === "trade");
  if (rows.length !== 2) return null;
  const wantPositive = t.type === "buy";
  const base = rows.find((l) => new Decimal(l.amount).gte(0) === wantPositive);
  const quote = rows.find((l) => l !== base);
  if (!base || !quote || base.asset === quote.asset) return null;
  return { base: { asset: base.asset, delta: ledgerDelta(base) }, quote: { asset: quote.asset, delta: ledgerDelta(quote) } };
}

/**
 * Zet Kraken-trades en ledgerregels om naar transacties van de app. Zonder de pairlijst (AssetPairs) breekt de sync af:
 * de koersbron van nieuwe assets komt uit die lijst en de sync schrijft hem eenmalig weg (een latere sync vult alleen
 * "manual" aan), dus een tijdelijke storing zou BTC, ETH en alle alts blijvend op Yahoo zetten — en munten die Yahoo niet
 * onder <SYM>-EUR kent, elke verversronde laten mislukken. De cursor schuift dan niet op; de volgende sync haalt alles
 * opnieuw op. Ontbreekt een enkel paar in de lijst, dan blijft de naamsplitsing hieronder de terugval.
 */
export async function normalizeKraken(client: KrakenClient, trades: (KrakenTrade & { id: string })[], ledger: (KrakenLedger & { id: string })[], warnings: string[]): Promise<NormalizedTx[]> {
  const out: NormalizedTx[] = [];
  const pairs = await requirePairs(client);
  const assets = await client.assets().catch(() => ({}) as Awaited<ReturnType<KrakenClient["assets"]>>);
  // koersbron: Kraken-paar per basisasset (eenmaal per sync opgebouwd); een munt zonder bruikbaar fiatpaar valt terug op Yahoo
  const hints = krakenPriceHints(pairs, assets);
  const cryptoHint = (symbol: string, code: string): NormalizedTx["priceSource"] => {
    const key = hints.byCode.get(code) ?? hints.bySymbol.get(symbol);
    return key ? { source: "kraken", sourceId: key } : { source: "yahoo", sourceId: `${symbol}-EUR` };
  };

  // grootboekregels per referentie: de trade-regels zijn Kraken's eigen boeking en dus de bron voor de aantallen
  const withoutLedger: string[] = [];
  const ledgerByRef = new Map<string, (KrakenLedger & { id: string })[]>();
  for (const l of ledger) {
    if (!ledgerByRef.has(l.refid)) ledgerByRef.set(l.refid, []);
    ledgerByRef.get(l.refid)!.push(l);
  }

  for (const t of trades) {
    const tradeId = t.id;
    const legs = tradeLegs(t, ledgerByRef.get(tradeId) ?? []);
    let baseCode = legs?.base.asset ?? pairs[t.pair]?.base;
    let quoteCode = legs?.quote.asset ?? pairs[t.pair]?.quote;
    if (!baseCode || !quoteCode) {
      // val terug op een simpele splitsing van de pairnaam (XXBTZEUR → XXBT + ZEUR, XETHXXBT → XETH + XXBT); basis zo kort mogelijk
      const m = t.pair.match(/^(X?[A-Z0-9.]{3,5}?)(Z?(?:EUR|USD|GBP|CHF|CAD|JPY|AUD|USDT|USDC|DAI)|X?(?:XBT|ETH))$/);
      if (!m) {
        warnings.push(`Trade ${tradeId}: pair ${t.pair} niet herkend en geen grootboekregels, overgeslagen.`);
        continue;
      }
      baseCode = m[1];
      quoteCode = m[2];
    }
    // aantal = werkelijke saldomutatie. Kraken rekent de kosten van een trade soms in de basismunt af terwijl
    // `fee` altijd in de quote-munt staat: bij een koop komt er dan vol − kosten binnen, bij een verkoop gaat er
    // vol + kosten uit. Zonder het grootboek (oude of ontbrekende regels) blijft vol/cost de benadering.
    const baseQty = legs ? legs.base.delta.abs() : new Decimal(t.vol);
    // zonder grootboek: aannemen dat de kosten in de quote-munt zijn betaald (het gewone geval)
    const quoteQty = legs ? legs.quote.delta.abs() : new Decimal(t.cost)[t.type === "buy" ? "plus" : "minus"](t.fee);
    if (!legs) withoutLedger.push(`${tradeId} (${t.pair})`);
    if (baseQty.lte(0)) {
      warnings.push(`Trade ${tradeId} (${t.pair}): aantal 0 volgens het grootboek, overgeslagen.`);
      continue;
    }
    // Koers per stuk uit de werkelijke bedragen in plaats van uit t.price: Kraken rondt dat veld af, waardoor
    // aantal × koers bij grote orders centen naast het geboekte bedrag ligt. Zo komt kostprijs (aantal × koers +
    // kosten) respectievelijk opbrengst (− kosten) precies uit op wat er van de quote-munt af ging of bij kwam.
    const unitPrice = quoteQty[t.type === "buy" ? "minus" : "plus"](t.fee).div(baseQty);
    const base = await client.symbolOf(baseCode);
    const quote = await client.symbolOf(quoteCode);
    const day = iso(t.time).slice(0, 10);
    const qCcy = toCurrency(quote);
    if (qCcy) {
      if (FIAT.has(base)) {
        warnings.push(`Trade ${tradeId}: valutawissel ${base}/${quote} overgeslagen (geen positie).`);
        continue;
      }
      // kostprijs = aantal × koers + kosten; dat komt exact uit op het bedrag dat Kraken afschreef, ook als de
      // kosten in de basismunt zijn betaald (aantal is dan met die kosten verlaagd en `fee` is de tegenwaarde ervan)
      out.push({
        externalId: `kraken:trade:${tradeId}`,
        type: t.type,
        symbol: base,
        category: "crypto",
        providerAssetId: baseCode,
        priceSource: cryptoHint(base, baseCode),
        quantity: baseQty.toFixed(10),
        price: unitPrice.toFixed(14),
        currency: qCcy,
        fee: t.fee,
        executedAt: iso(t.time),
        note: `Kraken ${t.pair} ${t.ordertype}`,
      });
      continue;
    }
    if (isForeignFiat(quote) || isForeignFiat(base)) {
      warnings.push(`Trade ${tradeId}: ${base}/${quote} overgeslagen; de app kent ${isForeignFiat(quote) ? quote : base} niet als valuta.`);
      continue;
    }
    // crypto-naar-crypto: waarderen via de EUR-koers van de quote-munt op dat moment
    const quoteEur = await client.priceInEur(quote, iso(t.time));
    if (!quoteEur) {
      warnings.push(`Trade ${tradeId}: geen EUR-koers voor ${quote} op ${day}; handmatig controleren.`);
    }
    const qe = new Decimal(quoteEur ?? 0);
    const baseLeg: NormalizedTx = {
      externalId: `kraken:trade:${tradeId}:base`,
      type: t.type,
      symbol: base,
      category: "crypto",
      providerAssetId: baseCode,
      priceSource: cryptoHint(base, baseCode),
      quantity: baseQty.toFixed(10),
      // ruim in de decimalen: bij grote aantallen (honderdduizenden XRP/XLM) laat een afronding op 8 decimalen
      // centen verschil achter tussen deze poot en de tegenpost, en dus in de kas
      price: unitPrice.mul(qe).toFixed(14),
      currency: "EUR",
      fee: new Decimal(t.fee).mul(qe).toFixed(14),
      executedAt: iso(t.time),
      note: `Kraken ${t.pair} (via ${quote}/EUR ${qe.toFixed(2)})`,
    };
    const quoteLeg: NormalizedTx = {
      externalId: `kraken:trade:${tradeId}:quote`,
      type: t.type === "buy" ? "sell" : "buy",
      symbol: quote,
      category: "crypto",
      providerAssetId: quoteCode,
      priceSource: cryptoHint(quote, quoteCode),
      quantity: quoteQty.toFixed(10),
      price: qe.toFixed(14),
      currency: "EUR",
      fee: "0",
      executedAt: iso(t.time),
      note: `Kraken ${t.pair} tegenpost`,
    };
    out.push(baseLeg, quoteLeg);
  }

  if (withoutLedger.length) {
    warnings.push(
      `${withoutLedger.length} trade(s) zonder grootboekregels: aantal en kostprijs komen uit de trade zelf, dus kosten die in de basismunt zijn afgerekend ontbreken (${withoutLedger.slice(0, 5).join(", ")}${withoutLedger.length > 5 ? ", …" : ""}).`,
    );
  }

  // Ledger: stortingen, opnames, staking/earn-rewards, instant buy/sell (spend/receive) en overige saldomutaties.
  // Uitgangspunt: Kraken's saldo per asset is precies de som van zijn grootboekregels, dus elke regel die niet uit
  // TradesHistory komt moet een boeking opleveren — anders loopt de app blijvend uit de pas met het platform.
  const skipped: Record<string, number> = {};
  /** Overboeking zonder resultaat (delisting, spot ↔ staking, airdrop, correctie); interne verplaatsingen tussen
   *  assetcodes van dezelfde munt (XETH ↔ XETH.S) vallen tegen elkaar weg omdat beide op hetzelfde symbool uitkomen. */
  const balanceMove = async (l: KrakenLedger & { id: string }, sym: string, ccy: Currency | null, note: string) => {
    const delta = ledgerDelta(l);
    if (delta.isZero()) return;
    if (isForeignFiat(sym)) {
      warnings.push(`Ledger ${l.id}: ${delta.toFixed(8)} ${sym} niet geboekt; de app kent die valuta niet.`);
      return;
    }
    if (ccy) {
      out.push({ externalId: `kraken:ledger:${l.id}`, type: delta.gt(0) ? "deposit" : "withdrawal", symbol: "", quantity: "0", price: delta.abs().toFixed(8), currency: ccy, fee: "0", executedAt: iso(l.time), note });
      return;
    }
    const px = delta.gt(0) ? await client.priceInEur(sym, iso(l.time)) : 0;
    out.push({
      externalId: `kraken:ledger:${l.id}`,
      type: delta.gt(0) ? "transfer_in" : "transfer_out",
      symbol: sym,
      category: "crypto",
      providerAssetId: l.asset,
      priceSource: cryptoHint(sym, l.asset),
      quantity: delta.abs().toFixed(10),
      price: String(px ?? 0),
      currency: "EUR",
      fee: "0",
      executedAt: iso(l.time),
      note,
    });
  };

  for (const l of ledger) {
    const sym = await client.symbolOf(l.asset);
    const amount = new Decimal(l.amount);
    const fee = new Decimal(l.fee);
    const delta = ledgerDelta(l);
    const day = iso(l.time).slice(0, 10);
    const ccy = toCurrency(sym);
    switch (l.type) {
      case "deposit": {
        if (isForeignFiat(sym)) {
          warnings.push(`Storting ${l.id}: ${amount.toFixed(2)} ${sym} niet geboekt; de app kent die valuta niet.`);
        } else if (ccy) out.push({ externalId: `kraken:ledger:${l.id}`, type: "deposit", symbol: "", quantity: "0", price: amount.toFixed(8), currency: ccy, fee: fee.toFixed(8), executedAt: iso(l.time), note: "Kraken storting" });
        else {
          const px = await client.priceInEur(sym, iso(l.time));
          if (!px) warnings.push(`Overboeking ${l.id}: geen EUR-koers voor ${sym} op ${day}; kostprijs op 0 gezet.`);
          out.push({ externalId: `kraken:ledger:${l.id}`, type: "transfer_in", symbol: sym, category: "crypto", providerAssetId: l.asset, priceSource: cryptoHint(sym, l.asset), quantity: delta.toFixed(10), price: String(px ?? 0), currency: "EUR", fee: "0", executedAt: iso(l.time), note: "Kraken crypto-storting (kostprijs = dagkoers)" });
        }
        break;
      }
      case "withdrawal": {
        if (isForeignFiat(sym)) warnings.push(`Opname ${l.id}: ${amount.abs().toFixed(2)} ${sym} niet geboekt; de app kent die valuta niet.`);
        else if (ccy) out.push({ externalId: `kraken:ledger:${l.id}`, type: "withdrawal", symbol: "", quantity: "0", price: amount.abs().toFixed(8), currency: ccy, fee: fee.toFixed(8), executedAt: iso(l.time), note: "Kraken opname" });
        else out.push({ externalId: `kraken:ledger:${l.id}`, type: "transfer_out", symbol: sym, category: "crypto", providerAssetId: l.asset, priceSource: cryptoHint(sym, l.asset), quantity: delta.abs().toFixed(10), price: "0", currency: "EUR", fee: "0", executedAt: iso(l.time), note: `Kraken crypto-opname${fee.gt(0) ? ` (incl. ${fee.toFixed(8)} kosten)` : ""}` });
        break;
      }
      case "staking":
      case "earn": {
        const sub = (l.subtype ?? "").toLowerCase();
        if (l.type === "earn" && sub && sub !== "reward") {
          // allocation/deallocation = intern: de tegenpost staat op dezelfde munt (SOL ↔ SOL.F) en valt weg
          skipped[`earn:${sub}`] = (skipped[`earn:${sub}`] ?? 0) + 1;
          break;
        }
        if (isForeignFiat(sym)) {
          warnings.push(`Reward ${l.id}: ${delta.toFixed(8)} ${sym} niet geboekt; de app kent die valuta niet.`);
          break;
        }
        if (ccy) {
          out.push({ externalId: `kraken:ledger:${l.id}`, type: "interest", symbol: "", quantity: "0", price: delta.toFixed(8), currency: ccy, fee: "0", executedAt: iso(l.time), note: `Kraken ${l.type}-reward` });
          break;
        }
        if (delta.lte(0)) {
          await balanceMove(l, sym, ccy, `Kraken ${l.type}-correctie`);
          break;
        }
        out.push({ externalId: `kraken:ledger:${l.id}`, type: "staking", symbol: sym, category: "crypto", providerAssetId: l.asset, priceSource: cryptoHint(sym, l.asset), quantity: delta.toFixed(10), price: "0", currency: "EUR", fee: "0", executedAt: iso(l.time), note: `Kraken ${l.type}-reward` });
        break;
      }
      case "spend":
      case "receive": {
        // instant buy/sell via de app: spend (fiat of crypto) + receive (crypto of fiat) met dezelfde refid
        if (l.type === "receive") break; // verwerkt vanuit de spend-regel
        const group = ledgerByRef.get(l.refid) ?? [];
        const recv = group.find((g) => g.type === "receive");
        if (!recv) {
          warnings.push(`Ledger ${l.id}: spend zonder receive; als losse saldomutatie geboekt.`);
          await balanceMove(l, sym, ccy, "Kraken spend zonder tegenpost");
          break;
        }
        const recvSym = await client.symbolOf(recv.asset);
        const recvCcy = toCurrency(recvSym);
        const recvDelta = ledgerDelta(recv); // werkelijk bijgeschreven
        const spentDelta = delta.abs(); // werkelijk afgeschreven, inclusief kosten
        if (ccy && !recvCcy) {
          // fiat uitgegeven, crypto ontvangen = aankoop; kostprijs = aantal × koers + kosten = het hele afgeschreven bedrag
          out.push({ externalId: `kraken:ledger:${l.refid}`, type: "buy", symbol: recvSym, category: "crypto", providerAssetId: recv.asset, priceSource: cryptoHint(recvSym, recv.asset), quantity: recvDelta.toFixed(10), price: amount.abs().div(recvDelta).toFixed(10), currency: ccy, fee: fee.toFixed(8), executedAt: iso(l.time), note: "Kraken instant buy" });
        } else if (!ccy && recvCcy) {
          // crypto uitgegeven, fiat ontvangen = verkoop; opbrengst = aantal × koers − kosten = het bijgeschreven bedrag
          out.push({ externalId: `kraken:ledger:${l.refid}`, type: "sell", symbol: sym, category: "crypto", providerAssetId: l.asset, priceSource: cryptoHint(sym, l.asset), quantity: spentDelta.toFixed(10), price: new Decimal(recv.amount).div(spentDelta).toFixed(10), currency: recvCcy, fee: new Decimal(recv.fee).toFixed(8), executedAt: iso(l.time), note: "Kraken instant sell" });
        } else if (!ccy && !recvCcy && !isForeignFiat(sym) && !isForeignFiat(recvSym)) {
          // crypto-naar-crypto via de app: beide poten via de EUR-koers van de uitgegeven munt
          const px = await client.priceInEur(sym, iso(l.time));
          if (!px) warnings.push(`Ledger ${l.refid}: geen EUR-koers voor ${sym} op ${day}; kostprijs van ${recvSym} op 0 gezet.`);
          const pe = new Decimal(px ?? 0);
          out.push({ externalId: `kraken:ledger:${l.refid}:out`, type: "sell", symbol: sym, category: "crypto", providerAssetId: l.asset, priceSource: cryptoHint(sym, l.asset), quantity: spentDelta.toFixed(10), price: pe.toFixed(8), currency: "EUR", fee: "0", executedAt: iso(l.time), note: `Kraken ${sym} → ${recvSym}` });
          out.push({ externalId: `kraken:ledger:${l.refid}:in`, type: "buy", symbol: recvSym, category: "crypto", providerAssetId: recv.asset, priceSource: cryptoHint(recvSym, recv.asset), quantity: recvDelta.toFixed(10), price: recvDelta.isZero() ? "0" : spentDelta.mul(pe).div(recvDelta).toFixed(10), currency: "EUR", fee: "0", executedAt: iso(l.time), note: `Kraken ${sym} → ${recvSym}` });
        } else {
          warnings.push(`Ledger ${l.refid}: valutawissel ${sym} → ${recvSym} overgeslagen (geen positie).`);
        }
        break;
      }
      case "trade":
        break; // komt uit TradesHistory
      case "transfer":
      case "adjustment":
        // delisting-omzetting, spot ↔ staking/futures, airdrops en correcties: echte saldomutaties
        await balanceMove(l, sym, ccy, `Kraken ${l.type}${l.subtype ? ` (${l.subtype})` : ""}`);
        break;
      default:
        // onbekend type: toch boeken, anders wijkt het saldo blijvend af van Kraken
        skipped[l.type] = (skipped[l.type] ?? 0) + 1;
        await balanceMove(l, sym, ccy, `Kraken ${l.type}${l.subtype ? ` (${l.subtype})` : ""}`);
    }
  }
  for (const [k, n] of Object.entries(skipped)) warnings.push(`${n} ledgerregel(s) van type ${k}: intern of onbekend type.`);
  return out;
}

export async function krakenBalances(client: KrakenClient): Promise<BalanceRow[]> {
  const raw = await client.balance();
  const sums = new Map<string, Decimal>();
  for (const [code, amt] of Object.entries(raw)) {
    const sym = await client.symbolOf(code);
    sums.set(sym, (sums.get(sym) ?? new Decimal(0)).plus(amt));
  }
  // 0,00000001 is de kleinste eenheid die de app bijhoudt en dus geen stof: laat je die weg, dan meldt de afstemming
  // een verschil voor een saldo dat Kraken wél rapporteert (bijv. een airdrop van 1 satoshi-eenheid).
  return [...sums.entries()].filter(([, v]) => v.abs().gte("0.00000001")).map(([currency, v]) => ({ currency, amount: v.toFixed(8) }));
}

export function makeKrakenProvider(opts: KrakenClientOptions = {}): ConnectionProvider {
  return {
    id: "kraken",
    label: "Kraken",
    credentials: "keys",
    keyLabels: { apiKey: "API Key", apiSecret: "Private Key" },
    helpUrl: "https://www.kraken.com/u/security/api",
    async test(creds, ctx): Promise<TestOutput> {
      const client = new KrakenClient(creds, { ...opts, initialNonce: Number(ctx.cursor.nonce ?? 0) });
      try {
        const bal = await krakenBalances(client);
        let trades = 0;
        try {
          const r = await client.privatePost<{ count: number }>("TradesHistory", { ofs: "0" });
          trades = r.count ?? 0;
        } catch (e) {
          return { ok: false, message: `Saldo gelezen, maar trades niet: ${e instanceof Error ? e.message : String(e)}` };
        }
        try {
          await client.privatePost<{ count: number }>("Ledgers", { ofs: "0" });
        } catch (e) {
          return { ok: false, message: `Saldo en trades gelezen, maar ledger niet: ${e instanceof Error ? e.message : String(e)}` };
        }
        return { ok: true, message: `Verbinding OK: ${bal.length} saldi, ${trades} trades`, details: { balances: bal, trades } };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    async sync(creds, ctx): Promise<SyncOutput> {
      const client = new KrakenClient(creds, { ...opts, initialNonce: Number(ctx.cursor.nonce ?? 0) });
      const warnings: string[] = [];
      const lastTrade = Number(ctx.cursor.lastTradeTime ?? 0);
      const lastLedger = Number(ctx.cursor.lastLedgerTime ?? 0);
      await requirePairs(client); // eerst: zonder pairlijst geen sync (en geen private calls tegen de rate limit)
      const trades = await client.tradesSince(lastTrade);
      const ledger = await client.ledgerSince(lastLedger);
      ctx.log(`Kraken: ${trades.length} trades en ${ledger.length} ledgerregels sinds cursor`);
      const transactions = await normalizeKraken(client, trades, ledger, warnings);
      const balances = await krakenBalances(client);
      return {
        transactions,
        balances,
        cursor: {
          lastTradeTime: trades.length ? Math.max(lastTrade, ...trades.map((t) => t.time)) : lastTrade,
          lastLedgerTime: ledger.length ? Math.max(lastLedger, ...ledger.map((l) => l.time)) : lastLedger,
          nonce: client.lastNonceValue,
        },
        warnings,
      };
    },
  };
}

export const krakenProvider = makeKrakenProvider();
export type { TxType };
