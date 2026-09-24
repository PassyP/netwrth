import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { getSecret } from "../secrets";
import { getDb, schema } from "../db";

/**
 * eToro Public API — https://api-portal.etoro.com/
 * Headers: x-api-key, x-user-key, x-request-id (UUID per request).
 * Limiet marktdata: 120 requests per 60 s (gedeeld). Bij 429 wachten we met backoff.
 */
const BASE = process.env.ETORO_BASE_URL || "https://public-api.etoro.com";

export class EtoroError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Keys voor marktdata: de globale keys uit Instellingen, anders die van een eToro-koppeling. */
export function resolveEtoroKeys(): { apiKey: string; userKey: string } | null {
  const apiKey = getSecret("etoroApiKey");
  const userKey = getSecret("etoroUserKey");
  if (apiKey && userKey) return { apiKey, userKey };
  for (const c of getDb().select().from(schema.connections).where(eq(schema.connections.provider, "etoro")).all()) {
    const k = getSecret(`conn:${c.id}:apiKey`);
    const u = getSecret(`conn:${c.id}:apiSecret`);
    if (k && u) return { apiKey: k, userKey: u };
  }
  return null;
}

export function etoroConfigured(): boolean {
  return resolveEtoroKeys() !== null;
}

async function request<T>(path: string, params?: Record<string, string>, attempt = 0): Promise<T> {
  const keys = resolveEtoroKeys();
  if (!keys) throw new EtoroError(401, "eToro API-keys ontbreken; vul ze in bij Instellingen → Koersen en planning → Koersbronnen.");
  const { apiKey, userKey } = keys;
  const url = new URL(path, BASE);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-api-key": apiKey,
      "x-user-key": userKey,
      "x-request-id": crypto.randomUUID(),
    },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 429 && attempt < 4) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return request<T>(path, params, attempt + 1);
  }
  if (!res.ok && res.status !== 206) {
    const text = await res.text().catch(() => "");
    throw new EtoroError(res.status, `eToro ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface EtoroSearchResult {
  instrumentId: number;
  displayName: string;
  type: string;
  symbol: string;
  exchangeId: number | null;
  image?: { uri?: string; backgroundColor?: string } | null;
}

export async function searchInstruments(query: string, limit = 10): Promise<EtoroSearchResult[]> {
  const data = await request<{ results: EtoroSearchResult[] }>("/api/v2/market-data/instruments/search", {
    query: query.slice(0, 100),
    limit: String(Math.min(50, Math.max(1, limit))),
  });
  return data.results ?? [];
}

export interface EtoroRate {
  instrumentId: number;
  bid: number;
  ask: number;
  date: string;
  quoteType: string;
}

/** Bid/ask voor meerdere instrumenten in één call. */
export async function getRates(instrumentIds: number[]): Promise<EtoroRate[]> {
  if (instrumentIds.length === 0) return [];
  const out: EtoroRate[] = [];
  for (let i = 0; i < instrumentIds.length; i += 500) {
    const chunk = instrumentIds.slice(i, i + 500);
    const data = await request<{ results: EtoroRate[] }>("/api/v2/market-data/rates", { instrumentIds: chunk.join(",") });
    out.push(...(data.results ?? []));
  }
  return out;
}

export interface EtoroCandle {
  fromDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Dagcandles (nieuwste eerst → wij sorteren oplopend). */
export async function getDailyCandles(instrumentId: number, count = 365): Promise<EtoroCandle[]> {
  const n = Math.min(1000, Math.max(1, count));
  const data = await request<{ candles: { candles: EtoroCandle[] }[] }>(
    `/api/v1/market-data/instruments/${instrumentId}/history/candles/desc/OneDay/${n}`
  );
  const candles = data.candles?.[0]?.candles ?? [];
  return [...candles].sort((a, b) => (a.fromDate < b.fromDate ? -1 : 1));
}

export interface EtoroClosing {
  instrumentId: number;
  officialClosingPrice: number;
  isMarketOpen: boolean;
  closingPrices?: { daily?: { price: number; date: string } };
}

export async function getClosingPrices(instrumentIds: number[]): Promise<EtoroClosing[]> {
  if (instrumentIds.length === 0) return [];
  return request<EtoroClosing[]>("/api/v1/market-data/instruments/history/closing-price", { instrumentIds: instrumentIds.join(",") });
}

/** Testknop in Instellingen: één zoek-call. */
export async function testConnection(): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await searchInstruments("BTC", 1);
    return { ok: true, message: `Verbinding OK (${r.length} resultaat voor "BTC": ${r[0]?.displayName ?? "-"})` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
