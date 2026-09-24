import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-quotes-etoro-currency-"));

import { getDb, schema } from "@/lib/db";
import { setSecret } from "@/lib/secrets";
import { ETORO_QUOTE_CURRENCY, backfillHistory, latestQuote, previousClose, quoteHistory, refreshAll, repairEtoroQuoteCurrency, saveQuote } from "./quotes";

// --- fixtures ------------------------------------------------------------
const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_SEC = Math.floor(Date.parse(`${TODAY}T00:00:00Z`) / 1000);
const day = (offset: number) => new Date((TODAY_SEC + offset * 86400) * 1000).toISOString().slice(0, 10);
const INSTRUMENT_ID = 100000;

const candle = (d: string, close: number) => ({ fromDate: `${d}T00:00:00Z`, open: close, high: close, low: close, close, volume: 1 });

const state = { failClosing: false };
const calls: { path: string; params: URLSearchParams; headers: Record<string, string> }[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const router = (async (input: URL | RequestInfo, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : (input as URL).toString());
  // eToro: rates dragen geen valuta (bid/ask in USD), dagslot en candles evenmin
  if (url.hostname === "public-api.etoro.com") {
    const headers = (init?.headers as Record<string, string> | undefined) ?? {};
    calls.push({ path: url.pathname, params: url.searchParams, headers });
    if (headers["x-api-key"] !== "k" || headers["x-user-key"] !== "u") return new Response("unauthorized", { status: 401 });
    if (url.pathname === "/api/v2/market-data/rates") {
      const ids = (url.searchParams.get("instrumentIds") ?? "").split(",").map(Number);
      return json({ results: ids.filter((id) => id === INSTRUMENT_ID).map((id) => ({ instrumentId: id, bid: 70000, ask: 70010, date: `${TODAY}T12:00:00Z`, quoteType: "Live" })) });
    }
    if (url.pathname === "/api/v1/market-data/instruments/history/closing-price") {
      if (state.failClosing) return new Response("boom", { status: 500 });
      return json([{ instrumentId: INSTRUMENT_ID, officialClosingPrice: 69000, isMarketOpen: true, closingPrices: { daily: { price: 69500, date: `${day(-1)}T21:00:00Z` } } }]);
    }
    if (url.pathname === `/api/v1/market-data/instruments/${INSTRUMENT_ID}/history/candles/desc/OneDay/5`) {
      // nieuwste eerst, zoals eToro ze levert; de candle van vandaag wordt door backfillHistory overgeslagen
      return json({ candles: [{ candles: [candle(TODAY, 69999), candle(day(-1), 68500), candle(day(-2), 68000)] }] });
    }
    return new Response("not found", { status: 404 });
  }
  // Frankfurter (ECB)
  if (url.hostname === "api.frankfurter.dev") {
    if (url.pathname.includes("..")) {
      const [start, end] = url.pathname.slice(4).split("..");
      const rates: Record<string, Record<string, number>> = {};
      const d = new Date(start + "T00:00:00Z");
      const e = new Date(end + "T00:00:00Z");
      for (; d <= e; d.setUTCDate(d.getUTCDate() + 1)) rates[d.toISOString().slice(0, 10)] = { USD: 1.1, CHF: 0.95, GBP: 0.85 };
      return json({ base: "EUR", rates });
    }
    return json({ base: "EUR", date: TODAY, rates: { USD: 1.1, CHF: 0.95, GBP: 0.85 } });
  }
  return new Response("blocked", { status: 403 });
}) as typeof fetch;

beforeAll(() => {
  vi.stubGlobal("fetch", router);
  getDb();
  setSecret("etoroApiKey", "k");
  setSecret("etoroUserKey", "u");
});

const btc = () => getDb().select().from(schema.assets).where(eq(schema.assets.symbol, "BTC")).get()!;

describe("eToro-koersen worden altijd in USD opgeslagen, ongeacht assets.currency", () => {
  it("exporteert de eToro-quotevaluta als USD", () => {
    expect(ETORO_QUOTE_CURRENCY).toBe("USD");
  });

  it("refreshAll slaat mid en previousClose van een EUR-genoteerd eToro-asset op als USD", async () => {
    // een crypto-asset in EUR (bijv. uit een CSV-import) dat later eToro als feed kreeg: assets.currency blijft EUR
    getDb()
      .insert(schema.assets)
      .values({ symbol: "BTC", name: "Bitcoin", category: "crypto", currency: "EUR", priceSource: "etoro", sourceId: String(INSTRUMENT_ID), createdAt: new Date().toISOString() })
      .run();
    calls.length = 0;
    const report = await refreshAll("manual");

    expect(report.failed).toEqual([]);
    expect(report.updated).toBe(1);
    expect(report.fxDate).toBe(TODAY);
    const rates = calls.filter((c) => c.path === "/api/v2/market-data/rates");
    expect(rates).toHaveLength(1);
    expect(rates[0].params.get("instrumentIds")).toBe(String(INSTRUMENT_ID));
    expect(rates[0].headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);

    const a = btc();
    expect(a.currency).toBe("EUR"); // de fix raakt assets.currency niet aan
    expect(latestQuote(a.id)).toMatchObject({ day: TODAY, price: "70005", previousClose: "69500", currency: "USD", source: "etoro" });
  });

  it("refreshAll houdt USD als de dagslot-call mislukt (previousClose leeg)", async () => {
    state.failClosing = true;
    try {
      const report = await refreshAll("manual");
      expect(report.failed).toEqual([]);
      expect(report.updated).toBe(1);
      expect(latestQuote(btc().id)).toMatchObject({ day: TODAY, price: "70005", previousClose: null, currency: "USD", source: "etoro" });
    } finally {
      state.failClosing = false;
    }
  });

  it("backfillHistory schrijft de dagcandles als USD en laat de rij van vandaag staan", async () => {
    const a = btc();
    calls.length = 0;
    const n = await backfillHistory(a, 5);
    expect(n).toBe(2);
    expect(calls.map((c) => c.path)).toEqual([`/api/v1/market-data/instruments/${INSTRUMENT_ID}/history/candles/desc/OneDay/5`]);

    const rows = quoteHistory(a.id, day(-5)).map((r) => [r.day, r.price, r.currency, r.source, r.previousClose]);
    expect(rows).toEqual([
      [day(-2), "68000", "USD", "etoro", null],
      [day(-1), "68500", "USD", "etoro", null],
      [TODAY, "70005", "USD", "etoro", null], // de rij van refreshAll blijft staan
    ]);
    expect(btc().currency).toBe("EUR");
    expect(getDb().select().from(schema.priceQuotes).all().every((q) => q.currency === "USD")).toBe(true);
  });

  it("oudere eToro-rijen met het valutalabel van het asset (EUR) worden bij een verversronde herlabeld naar USD; andere bronnen blijven staan", async () => {
    const a = btc();
    // historie van vóór de fix: eToro-koersen (USD) opgeslagen als EUR; plus een handmatige EUR-koers die wél EUR is
    saveQuote(a.id, `${day(-4)}T21:00:00.000Z`, 66000, "EUR", "etoro");
    saveQuote(a.id, `${day(-3)}T21:00:00.000Z`, 67000, "EUR", "etoro");
    saveQuote(a.id, `${day(-6)}T12:00:00.000Z`, 60000, "EUR", "manual");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const report = await refreshAll("manual");
      expect(report.failed).toEqual([]);
      expect(log).toHaveBeenCalledWith("[koersen] 2 eToro-koersrij(en) herlabeld naar USD");
    } finally {
      log.mockRestore();
    }
    const rows = quoteHistory(a.id, day(-7)).map((r) => [r.day, r.price, r.currency, r.source]);
    expect(rows).toEqual([
      [day(-6), "60000", "EUR", "manual"], // geen eToro-rij: ongemoeid
      [day(-4), "66000", "USD", "etoro"],
      [day(-3), "67000", "USD", "etoro"],
      [day(-2), "68000", "USD", "etoro"],
      [day(-1), "68500", "USD", "etoro"],
      [TODAY, "70005", "USD", "etoro"],
    ]);
    expect(btc().currency).toBe("EUR"); // assets.currency blijft ook hier ongemoeid
    // idempotent, ook per asset (backfill-pad)
    expect(repairEtoroQuoteCurrency()).toBe(0);
    expect(repairEtoroQuoteCurrency(a.id)).toBe(0);
  });

  it("de reparatie per asset loopt mee met backfillHistory, ook voor dagen buiten het candle-venster", async () => {
    const a = btc();
    getDb().delete(schema.priceQuotes).where(eq(schema.priceQuotes.assetId, a.id)).run();
    saveQuote(a.id, `${day(-10)}T21:00:00.000Z`, 65000, "EUR", "etoro"); // legacy-label, buiten de 5 candles
    saveQuote(a.id, `${day(-1)}T21:00:00.000Z`, 68500, "EUR", "etoro"); // legacy-label
    saveQuote(a.id, `${TODAY}T12:00:00.000Z`, 70005, "USD", "etoro"); // na de fix, zonder dagslot
    expect(previousClose(a.id)).toBeNull(); // valutagrens: geen vorige slot
    await backfillHistory(a, 5);
    expect(quoteHistory(a.id, day(-12)).map((r) => [r.day, r.price, r.currency])).toEqual([
      [day(-10), "65000", "USD"],
      [day(-2), "68000", "USD"],
      [day(-1), "68500", "USD"],
      [TODAY, "70005", "USD"],
    ]);
    expect(previousClose(a.id)).toBe("68500");
  });
});
