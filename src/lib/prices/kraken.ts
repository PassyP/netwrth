/**
 * Kraken als koersbron: publieke Spot REST API, geen key nodig — https://docs.kraken.com/api/
 * sourceId van een asset = canonieke AssetPairs-sleutel (XXBTZEUR, SOLEUR); providerIds.kraken = base-code (XXBT).
 * Koersen in de quote-valuta van het pair; "previousClose" = de open van vandaag (00:00 UTC) — in een 24/7-markt
 * een bruikbare benadering van de slotkoers van gisteren.
 * Publieke rate limit ≈ 1 verzoek/s per IP; per instantie een token bucket (1/s, burst 3).
 */
import { FIAT, normalizeKrakenAsset } from "@/lib/connections/kraken";
import { CURRENCIES } from "@/lib/db/schema";

const BASE = process.env.KRAKEN_BASE_URL || "https://api.kraken.com";
const PAIRS_TTL_MS = 3_600_000;
const PAIRS_RETRY_MS = 60_000;
const TICKER_CHUNK = 50;
const MAX_OHLC_DAYS = 720;
const QUOTE_PREFERENCE = ["EUR", "USD", "GBP", "CHF"];
const APP_CURRENCIES = new Set<string>(CURRENCIES);

export interface KrakenPair {
  key: string; // canonieke sleutel, bijv. XXBTZEUR
  altname: string; // bijv. XBTEUR
  wsname: string; // bijv. XBT/EUR
  base: string; // Kraken-code, bijv. XXBT
  quote: string; // Kraken-code, bijv. ZEUR
  symbol: string; // symbool in de app, bijv. BTC
  currency: string; // quote-valuta in de app, bijv. EUR
  status: string;
}

export interface KrakenSearchResult {
  symbol: string;
  pairKey: string;
  wsname: string;
  currency: string;
  baseCode: string;
}

export interface KrakenQuote {
  pairKey: string; // canonieke sleutel (ook als er op altname/wsname is gevraagd)
  price: number;
  previousClose: number | null;
  currency: string;
  time: string; // ISO
}

export interface KrakenCandle {
  date: string; // YYYY-MM-DD
  close: number;
}

export interface KrakenMarketOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  pairsTtlMs?: number;
  /** Wachttijd voor een nieuwe ophaalpoging van de pairlijst nadat die mislukte (standaard 1 minuut). */
  pairsRetryMs?: number;
}

export interface KrakenMarket {
  /**
   * Canonieke sleutel → pair; gecachet (TTL 1 uur). Na de TTL komt de oude lijst meteen terug en wordt op de achtergrond
   * ververst (stale-while-revalidate); na een mislukte verversing volgt pas na een korte wachttijd een nieuwe poging.
   * Alleen aclass_base "currency" en sleutels zonder "." (geen dark pool). De status (online, cancel_only, post_only …)
   * is geen filter: Kraken pauzeert de handel geregeld per pair of exchange-breed terwijl Ticker en OHLC gewoon koersen
   * blijven geven, en een pair dat tijdelijk uit de lijst valt zou een uur lang niet te waarderen zijn. Een lege
   * pairlijst geldt als mislukte verversing: de oude lijst blijft staan.
   */
  pairs(): Promise<Map<string, KrakenPair>>;
  /** Op sleutel, altname of wsname (hoofdletterongevoelig). Ook onbruikbare en gepauzeerde pairs (zie krakenPairIssue) worden gevonden. */
  resolvePair(id: string): Promise<KrakenPair | null>;
  /**
   * Minimaal 2 tekens; alleen bruikbare pairs met status "online" (een gepauzeerd pair blijft wel te waarderen, maar
   * bieden we niet aan als nieuwe bron); één resultaat per asset met voorkeursvaluta EUR > USD > GBP > CHF; exacte match
   * eerst; max 10.
   */
  search(query: string): Promise<KrakenSearchResult[]>;
  /** Ticker in blokken van 50; map op de gevraagde sleutel; onbekende en onbruikbare pairs ontbreken gewoon. */
  getQuotes(pairKeys: string[]): Promise<Map<string, KrakenQuote>>;
  /** Dagcandles (OHLC 1440) over maximaal 720 dagen, oplopend, zonder de (onvolledige) candle van vandaag. Gooit bij een onbekend of onbruikbaar pair. */
  getDailyHistory(pairKey: string, days: number): Promise<{ currency: string; candles: KrakenCandle[] }>;
}

/**
 * Waarom een pair niet als koersbron kan dienen, of null als het bruikbaar is. De waardering rekent met de valuta van de
 * quote en kent alleen de app-valuta's; een pair in USDT, BTC, CAD … zou de positie op 0 waarderen. Valutaparen
 * (EUR/USD, GBP/USD) zijn geen crypto en horen niet in de zoekresultaten.
 */
export function krakenPairIssue(pair: KrakenPair): string | null {
  if (!APP_CURRENCIES.has(pair.currency)) return `${pair.wsname} noteert in ${pair.currency}; kies een paar in ${CURRENCIES.join(", ")}`;
  if (FIAT.has(pair.symbol)) return `${pair.wsname} is een valutapaar, geen crypto`;
  return null;
}

interface KrakenResponse<T> {
  error?: string[];
  result: T;
}

interface RawPair {
  altname?: string;
  wsname?: string;
  aclass_base?: string;
  base?: string;
  aclass_quote?: string;
  quote?: string;
  status?: string;
}

interface RawAsset {
  altname?: string;
}

interface RawTicker {
  c?: string[];
  o?: string;
}

type RawCandle = [number, string, string, string, string, string, string, number];

interface PairIndex {
  at: number;
  byKey: Map<string, KrakenPair>;
  byAlias: Map<string, KrakenPair>; // sleutel, altname en wsname in hoofdletters
}

/** Token bucket: `rate` tokens/s, burst `capacity`. Bij tekort wacht de aanroeper zijn plek in de (virtuele) wachtrij af. */
class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private capacity: number,
    private rate: number,
    private now: () => number,
    private sleep: (ms: number) => Promise<void>,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  async take(): Promise<void> {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    this.tokens -= 1;
    if (this.tokens < 0) await this.sleep(Math.ceil((-this.tokens * 1000) / this.rate));
  }
}

function matchTier(pair: KrakenPair, q: string): { tier: number; exactPair: boolean } | null {
  const exactPair = pair.key.toUpperCase() === q || pair.altname.toUpperCase() === q || pair.wsname.toUpperCase() === q || `${pair.symbol}/${pair.currency}` === q || `${pair.symbol}${pair.currency}` === q;
  if (exactPair || pair.symbol === q) return { tier: 0, exactPair };
  if (pair.symbol.startsWith(q)) return { tier: 1, exactPair: false };
  const wsBase = pair.wsname.split("/")[0].toUpperCase();
  if (wsBase.includes(q) || pair.base.toUpperCase().includes(q)) return { tier: 2, exactPair: false };
  return null;
}

class KrakenMarketImpl implements KrakenMarket {
  private fetchImpl: typeof fetch;
  private now: () => Date;
  private ttl: number;
  private retryMs: number;
  private limiter: TokenBucket;
  private index: PairIndex | null = null;
  private loading: Promise<PairIndex> | null = null;
  private nextLoadAt = 0; // vóór dit moment geen nieuwe ophaalpoging: na succes at + TTL, na een fout nu + retryMs
  private lastError: Error | null = null;

  constructor(opts: KrakenMarketOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());
    this.ttl = opts.pairsTtlMs ?? PAIRS_TTL_MS;
    this.retryMs = opts.pairsRetryMs ?? PAIRS_RETRY_MS;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.limiter = new TokenBucket(3, 1, () => this.now().getTime(), sleep);
  }

  private async publicGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    await this.limiter.take();
    const url = new URL(`/0/public/${path}`, BASE);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    let data: KrakenResponse<T> | null = null;
    try {
      data = JSON.parse(text) as KrakenResponse<T>;
    } catch {
      data = null;
    }
    if (data?.error?.length) throw new Error(`Kraken: ${data.error.join("; ")}`);
    if (!res.ok || !data) throw new Error(`Kraken ${path}: HTTP ${res.status}`);
    return data.result;
  }

  private async loadIndex(): Promise<PairIndex> {
    const [raw, assets] = await Promise.all([
      this.publicGet<Record<string, RawPair>>("AssetPairs"),
      this.publicGet<Record<string, RawAsset>>("Assets").catch(() => ({}) as Record<string, RawAsset>), // alleen voor altnames; zonder valt normalizeKrakenAsset terug op de code
    ]);
    const byKey = new Map<string, KrakenPair>();
    for (const [key, p] of Object.entries(raw)) {
      if (key.includes(".") || !p.base || !p.quote) continue;
      if ((p.aclass_base ?? "currency") !== "currency") continue; // status is bewust geen filter, zie KrakenMarket.pairs()
      const altname = p.altname ?? key;
      byKey.set(key, {
        key,
        altname,
        wsname: p.wsname ?? altname,
        base: p.base,
        quote: p.quote,
        symbol: normalizeKrakenAsset(p.base, assets[p.base]?.altname),
        currency: normalizeKrakenAsset(p.quote, assets[p.quote]?.altname),
        status: p.status ?? "online",
      });
    }
    const byAlias = new Map<string, KrakenPair>();
    for (const pair of byKey.values()) byAlias.set(pair.key.toUpperCase(), pair);
    for (const pair of byKey.values()) if (!byAlias.has(pair.altname.toUpperCase())) byAlias.set(pair.altname.toUpperCase(), pair);
    for (const pair of byKey.values()) if (!byAlias.has(pair.wsname.toUpperCase())) byAlias.set(pair.wsname.toUpperCase(), pair);
    return { at: this.now().getTime(), byKey, byAlias };
  }

  /**
   * Eén ophaalactie tegelijk (gelijktijdige aanroepers delen dezelfde promise); werkt index, nextLoadAt en lastError bij.
   * Een lege pairlijst is nooit een geldige toestand (Kraken noteert honderden pairs) en telt als mislukking, zodat een
   * bestaande index nooit door niets wordt vervangen en de herkansingswachttijd geldt.
   */
  private load(): Promise<PairIndex> {
    if (!this.loading) {
      this.loading = this.loadIndex()
        .then((idx) => {
          if (idx.byKey.size === 0) throw new Error("Kraken: lege pairlijst");
          this.index = idx;
          this.lastError = null;
          this.nextLoadAt = idx.at + this.ttl;
          return idx;
        })
        .catch((e: unknown) => {
          this.lastError = e instanceof Error ? e : new Error(String(e));
          this.nextLoadAt = this.now().getTime() + this.retryMs;
          throw this.lastError;
        })
        .finally(() => {
          this.loading = null;
        });
    }
    return this.loading;
  }

  /**
   * Stale-while-revalidate: een verlopen index komt meteen terug en wordt op de achtergrond ververst, zodat zoeken,
   * toevoegen en de verversronde nooit op Kraken hoeven te wachten zodra er ooit een lijst is opgehaald — ook niet als
   * Kraken traag is of de verversing achter een lange wachtrij van de rate limiter staat. Zonder index wacht de
   * aanroeper op de gedeelde ophaalactie; mislukt die, dan krijgt elke aanroeper binnen het herkansingsvenster dezelfde
   * fout terug zonder Kraken opnieuw te belasten.
   */
  private async getIndex(): Promise<PairIndex> {
    const due = this.now().getTime() >= this.nextLoadAt;
    if (this.index) {
      if (due) this.load().catch(() => undefined); // achtergrond; een fout staat in lastError en verschuift nextLoadAt
      return this.index;
    }
    if (!due && !this.loading && this.lastError) throw this.lastError;
    return this.load();
  }

  private lookup(idx: PairIndex, id: string): KrakenPair | null {
    return idx.byKey.get(id) ?? idx.byAlias.get(id.trim().toUpperCase()) ?? null;
  }

  async pairs(): Promise<Map<string, KrakenPair>> {
    return (await this.getIndex()).byKey;
  }

  async resolvePair(id: string): Promise<KrakenPair | null> {
    return this.lookup(await this.getIndex(), id);
  }

  async search(query: string): Promise<KrakenSearchResult[]> {
    const q = query.trim().toUpperCase();
    if (q.length < 2) return [];
    const idx = await this.getIndex();
    const best = new Map<string, { pair: KrakenPair; rank: number; tier: number }>(); // per symbool
    for (const pair of idx.byKey.values()) {
      if (krakenPairIssue(pair)) continue; // geen crypto-, stablecoin- of exotisch-gequoteerde pairs, geen valutaparen
      if (pair.status !== "online") continue; // gepauzeerd (cancel_only, post_only …): niet aanbieden als nieuwe bron; bestaande bronnen blijven werken
      const ccyRank = QUOTE_PREFERENCE.indexOf(pair.currency);
      if (ccyRank < 0) continue;
      const m = matchTier(pair, q);
      if (!m) continue;
      const rank = m.exactPair ? -1 : ccyRank; // expliciet gevraagd pair (bijv. "btcusd") wint van de valutavoorkeur
      const cur = best.get(pair.symbol);
      if (!cur || rank < cur.rank) best.set(pair.symbol, { pair, rank, tier: Math.min(m.tier, cur?.tier ?? m.tier) });
      else if (m.tier < cur.tier) cur.tier = m.tier;
    }
    return [...best.values()]
      .sort((a, b) => a.tier - b.tier || (a.pair.symbol < b.pair.symbol ? -1 : a.pair.symbol > b.pair.symbol ? 1 : 0))
      .slice(0, 10)
      .map(({ pair }) => ({ symbol: pair.symbol, pairKey: pair.key, wsname: pair.wsname, currency: pair.currency, baseCode: pair.base }));
  }

  async getQuotes(pairKeys: string[]): Promise<Map<string, KrakenQuote>> {
    const out = new Map<string, KrakenQuote>();
    if (pairKeys.length === 0) return out;
    const idx = await this.getIndex();
    const wanted = new Map<string, string[]>(); // canonieke sleutel → gevraagde ids
    for (const id of pairKeys) {
      const pair = this.lookup(idx, id);
      if (!pair || krakenPairIssue(pair)) continue; // onbruikbaar pair: niet opvragen, ontbreekt in het antwoord
      const ids = wanted.get(pair.key) ?? [];
      if (!ids.includes(id)) ids.push(id);
      wanted.set(pair.key, ids);
    }
    const keys = [...wanted.keys()];
    const time = this.now().toISOString();
    for (let i = 0; i < keys.length; i += TICKER_CHUNK) {
      const chunk = keys.slice(i, i + TICKER_CHUNK);
      const result = await this.publicGet<Record<string, RawTicker>>("Ticker", { pair: chunk.join(",") });
      for (const [key, t] of Object.entries(result)) {
        const pair = this.lookup(idx, key);
        const ids = pair ? wanted.get(pair.key) : undefined;
        if (!pair || !ids) continue;
        const price = Number(t?.c?.[0]);
        if (!Number.isFinite(price) || price <= 0) continue;
        const open = Number(t.o);
        const previousClose = Number.isFinite(open) && open > 0 ? open : null;
        for (const id of ids) out.set(id, { pairKey: pair.key, price, previousClose, currency: pair.currency, time });
      }
    }
    return out;
  }

  async getDailyHistory(pairKey: string, days: number): Promise<{ currency: string; candles: KrakenCandle[] }> {
    const pair = await this.resolvePair(pairKey);
    if (!pair) throw new Error(`Kraken: onbekend pair ${pairKey}`);
    const issue = krakenPairIssue(pair);
    if (issue) throw new Error(`Kraken: ${issue}`);
    const span = Math.min(Math.max(Math.floor(Number(days) || 1), 1), MAX_OHLC_DAYS);
    const since = Math.floor(this.now().getTime() / 1000) - span * 86400;
    const result = await this.publicGet<Record<string, RawCandle[] | number>>("OHLC", { pair: pair.key, interval: "1440", since: String(since) });
    const rows = result[pair.key] ?? Object.entries(result).find(([k, v]) => k !== "last" && Array.isArray(v))?.[1];
    const today = this.now().toISOString().slice(0, 10);
    const candles: KrakenCandle[] = [];
    for (const c of Array.isArray(rows) ? rows : []) {
      const date = new Date(Number(c[0]) * 1000).toISOString().slice(0, 10);
      const close = Number(c[4]);
      if (date >= today || !Number.isFinite(close) || close <= 0) continue;
      candles.push({ date, close });
    }
    candles.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { currency: pair.currency, candles };
  }
}

export function makeKrakenMarket(opts: KrakenMarketOptions = {}): KrakenMarket {
  return new KrakenMarketImpl(opts);
}

export const krakenMarket: KrakenMarket = makeKrakenMarket();
