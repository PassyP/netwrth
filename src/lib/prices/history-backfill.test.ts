import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-history-backfill-"));

import { getDb, schema } from "@/lib/db";
import { computeHistory } from "@/lib/history";
import { backfillOlderHistory, ensureHistoryCoverage, historyCoverage, historyGaps, needsOlderHistory, quoteHistory, saveBackfilledQuote, saveQuote, yahooHistoryTickers } from "./quotes";

// --- fixtures ------------------------------------------------------------
const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_SEC = Math.floor(Date.parse(`${TODAY}T00:00:00Z`) / 1000);
const day = (offset: number) => new Date((TODAY_SEC + offset * 86400) * 1000).toISOString().slice(0, 10);
const sec = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);

// Yahoo-reeksen per ticker: één dagcandle per dag vanaf `start`, slot = basis + dagindex sinds start
const yahooSeries: Record<string, { currency: string; start: string; base: number }> = {
  "BTC-EUR": { currency: "EUR", start: "2016-01-01", base: 1000 },
  "BTC-USD": { currency: "USD", start: "2015-01-01", base: 1100 },
  "AAA-EUR": { currency: "EUR", start: "2017-11-06", base: 1 },
  "BBB-USD": { currency: "USD", start: "2024-01-01", base: 0.01 }, // geen BBB-EUR bij Yahoo, en de reeks begint ná de eerste transactie
};
const state = { failEth: false };
const calls: { symbol: string; params: Record<string, string> }[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const router = (async (input: URL | RequestInfo) => {
  const url = new URL(typeof input === "string" ? input : (input as URL).toString());
  if (url.hostname === "query1.finance.yahoo.com" && url.pathname.startsWith("/v8/finance/chart/")) {
    const symbol = decodeURIComponent(url.pathname.slice("/v8/finance/chart/".length));
    const params = Object.fromEntries(url.searchParams);
    calls.push({ symbol, params });
    if (symbol.startsWith("ETH-") && state.failEth) return new Response("boom", { status: 500 });
    const s = yahooSeries[symbol];
    if (!s) return json({ chart: { result: null, error: { code: "Not Found", description: `No data found for ${symbol}` } } });
    // zoals Yahoo: range=max → maandcandles, ongeacht interval; een periode → dagcandles binnen [period1, period2)
    if (params.range === "max") return json({ chart: { result: [{ meta: { currency: s.currency, symbol, dataGranularity: "1mo" }, timestamp: [sec(s.start)], indicators: { quote: [{ close: [s.base] }] } }], error: null } });
    const p1 = Math.max(Number(params.period1), sec(s.start));
    const p2 = Math.min(Number(params.period2), TODAY_SEC + 86400);
    const timestamp: number[] = [];
    const close: number[] = [];
    for (let t = p1; t < p2; t += 86400) {
      timestamp.push(t);
      close.push(s.base + (t - sec(s.start)) / 86400);
    }
    return json({ chart: { result: [{ meta: { currency: s.currency, symbol, dataGranularity: "1d" }, timestamp, indicators: { quote: [{ close }] } }], error: null } });
  }
  return new Response("blocked", { status: 403 });
}) as typeof fetch;

let portfolioId: number;
let platformId: number;
const assetIds: Record<string, number> = {};

function addAsset(symbol: string, name: string, priceSource: "kraken" | "yahoo" | "etoro" | "manual", sourceId: string | null, category = "crypto", currency = "USD") {
  const r = getDb().insert(schema.assets).values({ symbol, name, category: category as "crypto", currency: currency as "USD", priceSource, sourceId, createdAt: new Date().toISOString() }).run();
  assetIds[symbol] = Number(r.lastInsertRowid);
  return assetIds[symbol];
}
function addBuy(assetId: number, executedAt: string, quantity: string, price: string) {
  getDb().insert(schema.transactions).values({ portfolioId, assetId, platformId, type: "buy", quantity, price, currency: "EUR", fee: "0", executedAt, fxEur: "1", fxUsd: "1.1", source: "manual", createdAt: new Date().toISOString() }).run();
}
const asset = (symbol: string) => getDb().select().from(schema.assets).where(eq(schema.assets.id, assetIds[symbol])).get()!;
const rowsOf = (symbol: string) => quoteHistory(assetIds[symbol], "1900-01-01");

beforeAll(() => {
  vi.stubGlobal("fetch", router);
  const db = getDb();
  portfolioId = Number(db.insert(schema.portfolios).values({ name: "Test", createdAt: new Date().toISOString() }).run().lastInsertRowid);
  platformId = Number(db.insert(schema.platforms).values({ name: "Wallet", type: "wallet" }).run().lastInsertRowid);
  // wisselkoers nodig voor de historie (EUR → USD); één rij vóór alle dagen volstaat
  db.insert(schema.fxRates).values({ date: "2010-01-01", currency: "USD", ratePerEur: "1.1" }).run();

  // BTC via Kraken (EUR-pair): een jaar Kraken-koersen, maar een aankoop uit 2017
  addAsset("BTC", "Bitcoin", "kraken", "XXBTZEUR");
  for (let i = 365; i >= 1; i--) saveQuote(assetIds.BTC, `${day(-i)}T21:00:00.000Z`, 60000 + i, "EUR", "kraken");
  addBuy(assetIds.BTC, "2017-10-02T10:00:00.000Z", "3", "4000");
  addBuy(assetIds.BTC, `${day(-10)}T10:00:00.000Z`, "0.2", "60000");
});

describe("Oudere koershistorie via Yahoo", () => {
  it("yahooHistoryTickers: crypto als munt-valuta in de valuta van de feed, Yahoo-asset met eigen ticker, aandelen niet", () => {
    expect(yahooHistoryTickers({ symbol: "btc", category: "crypto", currency: "USD", priceSource: "kraken", sourceId: "XXBTZEUR" }, "EUR")).toEqual(["BTC-EUR", "BTC-USD"]);
    expect(yahooHistoryTickers({ symbol: "ETH", category: "crypto", currency: "USD", priceSource: "etoro", sourceId: "1002" }, null)).toEqual(["ETH-USD"]);
    expect(yahooHistoryTickers({ symbol: "VWRL", category: "etf", currency: "GBP", priceSource: "yahoo", sourceId: "VWRL.L" }, "GBP")).toEqual(["VWRL.L"]);
    expect(yahooHistoryTickers({ symbol: "ACME", category: "stock", currency: "USD", priceSource: "etoro", sourceId: "4242" }, "USD")).toEqual([]);
    expect(yahooHistoryTickers({ symbol: "BTC", category: "crypto", currency: "USD", priceSource: "manual", sourceId: null }, null)).toEqual([]);
  });

  it("zonder oudere koersen ligt de waarde vóór de koersfeed op kostprijs", () => {
    const pts = computeHistory(portfolioId);
    const p = pts.find((x) => x.date === "2017-11-01")!;
    expect(p.value.EUR).toBe(p.invested.EUR);
    expect(p.invested.EUR).toBe("12000.00");
    expect(historyGaps().map((g) => [g.asset.symbol, g.firstDay])).toEqual([["BTC", "2017-10-02"]]);
  });

  it("backfillOlderHistory vraagt een periode (geen range=max) en vult alleen de dagen vóór de eerste Kraken-rij uit de EUR-ticker", async () => {
    calls.length = 0;
    const n = await backfillOlderHistory(asset("BTC"), "2017-10-02");
    expect(calls).toHaveLength(1);
    expect(calls[0].symbol).toBe("BTC-EUR");
    expect(calls[0].params).toEqual({ period1: String(sec("2017-09-25")), period2: String(sec(day(-366)) + 86400), interval: "1d" });
    const rows = rowsOf("BTC");
    const yahooRows = rows.filter((r) => r.source === "yahoo");
    const krakenRows = rows.filter((r) => r.source === "kraken");
    expect(n).toBe(yahooRows.length);
    expect(yahooRows[0].day).toBe("2017-09-25"); // een week vóór de eerste transactie
    expect(yahooRows[yahooRows.length - 1].day).toBe(day(-366)); // tot de dag vóór de eerste Kraken-rij
    expect(yahooRows.every((r) => r.currency === "EUR")).toBe(true);
    expect(krakenRows).toHaveLength(365); // de rijen van de eigen bron zijn niet overschreven
    expect(krakenRows[0].day).toBe(day(-365));
    // en de historie waardeert 2017 nu tegen de Yahoo-slotkoers in plaats van kostprijs
    const q = rows.find((r) => r.day === "2017-11-01")!;
    const p = computeHistory(portfolioId).find((x) => x.date === "2017-11-01")!;
    expect(p.value.EUR).toBe((3 * Number(q.price)).toFixed(2));
    expect(p.invested.EUR).toBe("12000.00");
  });

  it("is daarna klaar: geen gat meer, geen Yahoo-call", async () => {
    calls.length = 0;
    expect(historyGaps()).toEqual([]);
    expect(await backfillOlderHistory(asset("BTC"), "2017-10-02")).toBe(0);
    expect(calls).toEqual([]);
  });

  it("saveBackfilledQuote laat rijen van de feed en handmatige koersen staan en overschrijft eerdere Yahoo-rijen", () => {
    expect(saveBackfilledQuote(assetIds.BTC, `${day(-1)}T21:00:00.000Z`, 1, "EUR")).toBe(false);
    expect(quoteHistory(assetIds.BTC, day(-1))[0]).toMatchObject({ source: "kraken", price: "60001" });
    saveQuote(assetIds.BTC, "2017-09-26T12:00:00.000Z", "1234", "EUR", "manual");
    expect(saveBackfilledQuote(assetIds.BTC, "2017-09-26T21:00:00.000Z", 1, "EUR")).toBe(false);
    expect(rowsOf("BTC").find((r) => r.day === "2017-09-26")).toMatchObject({ source: "manual", price: "1234" });
    expect(saveBackfilledQuote(assetIds.BTC, "2017-09-27T21:00:00.000Z", 1, "EUR")).toBe(true);
    expect(rowsOf("BTC").find((r) => r.day === "2017-09-27")).toMatchObject({ source: "yahoo", price: "1" });
  });

  it("een te grove oude reeks (weekcandles van range=max) geldt als gat en wordt met dagkoersen overschreven", async () => {
    // AAA: Kraken-koersen van de laatste 30 dagen, transactie in 2018, en een eerdere aanvulling met één rij per week
    addAsset("AAA", "Munt A", "kraken", "AAAEUR");
    for (let i = 30; i >= 1; i--) saveQuote(assetIds.AAA, `${day(-i)}T21:00:00.000Z`, 0.5, "EUR", "kraken");
    addBuy(assetIds.AAA, "2018-01-10T10:00:00.000Z", "1000", "2");
    let weekly = 0;
    for (let d = "2018-01-08"; d < day(-31); d = new Date(Date.parse(d + "T00:00:00Z") + 7 * 86400 * 1000).toISOString().slice(0, 10)) {
      saveQuote(assetIds.AAA, `${d}T21:00:00.000Z`, 9.99, "EUR", "yahoo");
      weekly++;
    }
    const cov = historyCoverage(asset("AAA"), "2018-01-10", TODAY);
    expect(cov).toMatchObject({ firstRow: "2018-01-08", feedStart: day(-30), from: "2018-01-03", to: day(-30) });
    expect(cov.rows).toBeLessThan(weekly + 1);
    expect(needsOlderHistory(cov, "2018-01-10")).toBe(true);
    expect(historyGaps().map((g) => g.asset.symbol)).toEqual(["AAA"]);

    calls.length = 0;
    const r = await ensureHistoryCoverage();
    expect(calls.map((c) => c.symbol)).toEqual(["AAA-EUR"]);
    expect(r.assets).toEqual(["AAA"]);
    const rows = rowsOf("AAA");
    const old = rows.filter((row) => row.day < day(-30));
    expect(old.length).toBe(Math.round((Date.parse(day(-30)) - Date.parse("2018-01-03")) / 86400000)); // elke dag één rij
    expect(old.every((row) => row.source === "yahoo" && row.price !== "9.99")).toBe(true); // de weekrijen zijn overschreven
    expect(rows.filter((row) => row.source === "kraken")).toHaveLength(30);
    expect(historyGaps()).toEqual([]);
    expect(needsOlderHistory(historyCoverage(asset("AAA"), "2018-01-10", TODAY), "2018-01-10")).toBe(false);
  });

  it("ensureHistoryCoverage: valt terug op de USD-ticker, meldt een fout, en probeert een afgehandeld gat niet opnieuw", async () => {
    // BBB: Kraken-koersen van de laatste week, transactie in 2023; Yahoo kent alleen BBB-USD en die reeks begint in 2024
    addAsset("BBB", "Munt B", "kraken", "BBBEUR");
    for (let i = 7; i >= 1; i--) saveQuote(assetIds.BBB, `${day(-i)}T21:00:00.000Z`, 0.02, "EUR", "kraken");
    addBuy(assetIds.BBB, "2023-03-01T10:00:00.000Z", "1000", "0.05");
    // ETH: Yahoo geeft een serverfout
    addAsset("ETH", "Ether", "kraken", "XETHZEUR");
    saveQuote(assetIds.ETH, `${day(-1)}T21:00:00.000Z`, 3000, "EUR", "kraken");
    addBuy(assetIds.ETH, "2020-01-01T10:00:00.000Z", "1", "100");
    // ACME: aandeel via eToro, geen Yahoo-ticker → geen gat
    addAsset("ACME", "Acme Corp", "etoro", "4242", "stock");
    addBuy(assetIds.ACME, "2020-01-01T10:00:00.000Z", "1", "100");
    expect(historyGaps().map((g) => [g.asset.symbol, g.firstDay])).toEqual([
      ["BBB", "2023-03-01"],
      ["ETH", "2020-01-01"],
    ]);

    state.failEth = true;
    calls.length = 0;
    const r1 = await ensureHistoryCoverage();
    expect(calls.map((c) => c.symbol)).toEqual(["BBB-EUR", "BBB-USD", "ETH-EUR", "ETH-USD"]);
    expect(r1.assets).toEqual(["BBB"]);
    expect(r1.failed).toEqual([{ asset: "ETH", error: "Yahoo 500 voor ETH-USD" }]);
    const bbb = rowsOf("BBB");
    expect(bbb[0]).toMatchObject({ day: "2024-01-01", currency: "USD", source: "yahoo" });
    expect(bbb.filter((row) => row.source === "yahoo")).toHaveLength(r1.filled);
    expect(bbb.filter((row) => row.source === "kraken")).toHaveLength(7);

    // BBB houdt een gat (Yahoo reikt niet tot 2023) en ETH is mislukt: beide worden binnen het uur niet opnieuw geprobeerd
    expect(historyGaps().map((g) => g.asset.symbol)).toEqual(["BBB", "ETH"]);
    calls.length = 0;
    const r2 = await ensureHistoryCoverage();
    expect(calls).toEqual([]);
    expect(r2).toEqual({ filled: 0, assets: [], failed: [] });

    // een oudere transactie is een nieuw gat en wordt wél opnieuw geprobeerd (eerst de EUR-ticker: de laatste rij is de Kraken-rij in EUR)
    addBuy(assetIds.BBB, "2022-06-01T10:00:00.000Z", "10", "0.1");
    calls.length = 0;
    await ensureHistoryCoverage();
    expect(calls.map((c) => c.symbol)).toEqual(["BBB-EUR", "BBB-USD"]);
  });
});
