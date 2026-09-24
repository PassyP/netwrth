/**
 * Gratis feed: Yahoo Finance (onofficieel). Kent onder meer VUSA.L, VWRL.L en EQQQ.L.
 * Geen API-key nodig; koersen in de noteringsvaluta (GBp = pence → gedeeld door 100 naar GBP).
 */
const UA = "Mozilla/5.0 (compatible; Netwrth/1.0)";

export interface YahooQuote {
  symbol: string;
  price: number;
  previousClose: number | null;
  currency: string;
  time: string; // ISO
  name?: string;
  exchange?: string;
}

export interface YahooCandle {
  date: string; // YYYY-MM-DD
  close: number;
}

function normalizeCurrency(ccy: string | undefined): { currency: string; factor: number } {
  if (!ccy) return { currency: "USD", factor: 1 };
  if (ccy === "GBp" || ccy === "GBX") return { currency: "GBP", factor: 0.01 };
  return { currency: ccy.toUpperCase(), factor: 1 };
}

interface ChartResponse {
  chart: {
    result: {
      meta: {
        currency?: string;
        symbol: string;
        exchangeName?: string;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketTime?: number;
        gmtoffset?: number; // seconden t.o.v. UTC in de tijdzone van de beurs (0 bij crypto)
        longName?: string;
        shortName?: string;
        dataGranularity?: string; // 1d, 1wk, 1mo …: wat Yahoo werkelijk leverde
      };
      timestamp?: number[];
      indicators?: { quote?: { close?: (number | null)[] }[] };
    }[] | null;
    error: { code: string; description: string } | null;
  };
}

type ChartResult = NonNullable<ChartResponse["chart"]["result"]>[number];

async function chart(symbol: string, params: Record<string, string>): Promise<ChartResponse["chart"]["result"]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Yahoo ${res.status} voor ${symbol}`);
  const data = (await res.json()) as ChartResponse;
  if (data.chart.error) throw new Error(`Yahoo: ${data.chart.error.description}`);
  return data.chart.result;
}

export async function getQuote(symbol: string): Promise<YahooQuote> {
  const result = await chart(symbol, { range: "5d", interval: "1d" });
  const r = result?.[0];
  if (!r) throw new Error(`Yahoo: geen data voor ${symbol}`);
  const meta = r.meta;
  const { currency, factor } = normalizeCurrency(meta.currency);
  const closes = (r.indicators?.quote?.[0]?.close ?? []).filter((c): c is number => typeof c === "number");
  const price = meta.regularMarketPrice ?? closes[closes.length - 1];
  if (price == null) throw new Error(`Yahoo: geen koers voor ${symbol}`);
  const time = meta.regularMarketTime ?? Math.floor(Date.now() / 1000);
  const prev = previousSessionClose(r, time);
  return {
    symbol: meta.symbol,
    price: price * factor,
    previousClose: prev != null ? prev * factor : null,
    currency,
    time: new Date(time * 1000).toISOString(),
    name: meta.longName ?? meta.shortName,
    exchange: meta.exchangeName,
  };
}

/**
 * Slot van de laatste handelsdag vóór de sessie van de koers (de dag van `time`, regularMarketTime): de laatste
 * dagcandle met een slot op een eerdere dag. meta.chartPreviousClose is de slot vóór het héle venster, bij range=5d vijf
 * handelsdagen terug, en telt pas (na meta.previousClose) als het venster geen eerdere slot heeft. Een lege slot (null,
 * levert Yahoo soms midden in de reeks) wordt overgeslagen: dan geldt de dag daarvoor. Dagen tellen in de tijdzone van
 * de beurs (gmtoffset): in Sydney opent een candle in UTC nog op de avond ervoor. Crypto handelt 24/7 met candles om
 * 00:00 UTC, dus daar is het de slot van gisteren (UTC), net als de open van vandaag bij Kraken.
 */
function previousSessionClose(r: ChartResult, time: number): number | null {
  const ts = r.timestamp ?? [];
  const closes = r.indicators?.quote?.[0]?.close ?? [];
  const offset = r.meta.gmtoffset ?? 0;
  const dayOf = (t: number) => new Date((t + offset) * 1000).toISOString().slice(0, 10);
  const session = dayOf(time);
  for (let i = ts.length - 1; i >= 0; i--) {
    const c = closes[i];
    if (typeof c === "number" && dayOf(ts[i]) < session) return c;
  }
  return r.meta.previousClose ?? r.meta.chartPreviousClose ?? null;
}

export async function getDailyHistory(symbol: string, range = "1y"): Promise<{ currency: string; candles: YahooCandle[] }> {
  const result = await chart(symbol, { range, interval: "1d" });
  const r = result?.[0];
  if (!r) throw new Error(`Yahoo: geen historie voor ${symbol}`);
  return toCandles(r);
}

/**
 * Dagslotkoersen tussen twee dagen (inclusief). Met `range=max` geeft Yahoo stilzwijgend week- of maandcandles terug
 * (dataGranularity 1wk/1mo, ook bij interval=1d); met een periode (period1/period2) blijven het dagcandles, ook over
 * meer dan tien jaar. Gooit als Yahoo toch een grovere reeks levert.
 */
export async function getDailyHistoryBetween(symbol: string, fromDay: string, toDay: string): Promise<{ currency: string; candles: YahooCandle[] }> {
  const period1 = Math.floor(Date.parse(`${fromDay}T00:00:00Z`) / 1000);
  const period2 = Math.floor(Date.parse(`${toDay}T00:00:00Z`) / 1000) + 86400;
  const result = await chart(symbol, { period1: String(period1), period2: String(period2), interval: "1d" });
  const r = result?.[0];
  if (!r) throw new Error(`Yahoo: geen historie voor ${symbol}`);
  const g = r.meta.dataGranularity;
  if (g && g !== "1d") throw new Error(`Yahoo: geen dagkoersen voor ${symbol} (${g})`);
  return toCandles(r);
}

function toCandles(r: ChartResult): { currency: string; candles: YahooCandle[] } {
  const { currency, factor } = normalizeCurrency(r.meta.currency);
  const ts = r.timestamp ?? [];
  const closes = r.indicators?.quote?.[0]?.close ?? [];
  const candles: YahooCandle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c !== "number") continue;
    candles.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: c * factor });
  }
  return { currency, candles };
}

export interface YahooSearchResult {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
}

export async function search(query: string): Promise<YahooSearchResult[]> {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`;
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Yahoo search ${res.status}`);
  const data = (await res.json()) as { quotes?: { symbol: string; shortname?: string; longname?: string; exchDisp?: string; exchange?: string; quoteType?: string }[] };
  return (data.quotes ?? []).map((q) => ({
    symbol: q.symbol,
    name: q.longname ?? q.shortname ?? q.symbol,
    exchange: q.exchDisp ?? q.exchange ?? "",
    type: q.quoteType ?? "",
  }));
}

/**
 * Yahoo noteert crypto als <munt>-<valuta> (BTC-USD, ETH-EUR, ETH-BTC). Geeft munt en noteringsvaluta terug, of null
 * als de ticker die vorm niet heeft. Alleen voor crypto gebruiken: bij aandelen is het streepje een aandelenklasse (BRK-B).
 */
export function parseCryptoTicker(ticker: string): { base: string; quote: string } | null {
  const m = /^([A-Z0-9]{1,15})-([A-Z]{3,5})$/i.exec(ticker.trim());
  return m ? { base: m[1].toUpperCase(), quote: m[2].toUpperCase() } : null;
}

/** "Bitcoin USD" → "Bitcoin": Yahoo plakt de noteringsvaluta achter de naam van een munt. */
export function stripQuoteFromName(name: string, quote: string): string {
  const stripped = name.replace(new RegExp(`\\s+${quote}$`, "i"), "").trim();
  return stripped || name;
}
