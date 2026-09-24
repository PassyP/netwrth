import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-kraken-pipeline-"));

// De standaardinstantie legt globalThis.fetch bij het laden van de module vast (vóór vi.stubGlobal). Daarom hier een
// instantie die de globale fetch pas bij de aanroep opzoekt, zonder wachttijden van de rate limiter.
vi.mock("@/lib/prices/kraken", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/prices/kraken")>();
  return { ...mod, krakenMarket: mod.makeKrakenMarket({ fetchImpl: (input, init) => fetch(input, init), sleep: async () => undefined }) };
});

import { getDb, schema } from "../db";
import { addAssetFromInput, primeAssetPrice, searchAssetCandidates, updateAsset, upsertAsset } from "../assets";
import { commitImport, genericToDrafts, type ColumnMapping } from "../importers";
import { computePortfolio } from "../portfolio";
import { deleteSecret, setSecret } from "../secrets";
import { backfillHistory, latestQuote, previousClose, quoteHistory, refreshAll, saveQuote } from "./quotes";

// --- fixtures ------------------------------------------------------------
const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_SEC = Math.floor(Date.parse(`${TODAY}T00:00:00Z`) / 1000);
const day = (offset: number) => new Date((TODAY_SEC + offset * 86400) * 1000).toISOString().slice(0, 10);

const pair = (altname: string, wsname: string, base: string, quote: string) => ({ altname, wsname, aclass_base: "currency", base, aclass_quote: "currency", quote, status: "online", pair_decimals: 1, lot_decimals: 8 });
const krakenPairs: Record<string, ReturnType<typeof pair>> = {
  XXBTZEUR: pair("XBTEUR", "XBT/EUR", "XXBT", "ZEUR"),
  XXBTZUSD: pair("XBTUSD", "XBT/USD", "XXBT", "ZUSD"),
  XETHZEUR: pair("ETHEUR", "ETH/EUR", "XETH", "ZEUR"),
  SOLEUR: pair("SOLEUR", "SOL/EUR", "SOL", "ZEUR"),
  SOLUSD: pair("SOLUSD", "SOL/USD", "SOL", "ZUSD"),
  ADAEUR: pair("ADAEUR", "ADA/EUR", "ADA", "ZEUR"),
  LINKEUR: pair("LINKEUR", "LINK/EUR", "LINK", "ZEUR"), // symbool dat ook een aandeel is (Interlink Electronics, LINK/USD)
  XBTUSDT: pair("XBTUSDT", "XBT/USDT", "XXBT", "USDT"), // onbruikbaar: quote buiten de app-valuta's
  XETHXXBT: pair("ETHXBT", "ETH/XBT", "XETH", "XXBT"), // onbruikbaar: crypto-quoted
};
const krakenAssets = { XXBT: { altname: "XBT" }, XETH: { altname: "ETH" }, SOL: { altname: "SOL" }, ADA: { altname: "ADA" }, LINK: { altname: "LINK" }, USDT: { altname: "USDT" }, ZEUR: { altname: "EUR" }, ZUSD: { altname: "USD" } };
const tickers: Record<string, { c: string; o: string }> = {
  XXBTZEUR: { c: "60000.5", o: "59000.0" },
  XXBTZUSD: { c: "70000.0", o: "69000.0" },
  XETHZEUR: { c: "3000.0", o: "2950.0" },
  SOLEUR: { c: "150.25", o: "149.0" },
  SOLUSD: { c: "175.0", o: "174.0" },
};
const candle = (t: number, close: string) => [t, close, close, close, close, close, "1.0", 1];
// Yahoo-chart per ticker (getQuote én getDailyHistory lezen hetzelfde endpoint): noteringsvaluta, koers van vandaag en slot van gisteren
const yahooCharts: Record<string, { currency: string; price: number; prev: number }> = {
  "XYZ-EUR": { currency: "EUR", price: 12.5, prev: 12 },
  "ABC.AS": { currency: "EUR", price: 40, prev: 39 },
  "VOLV-B.ST": { currency: "SEK", price: 250, prev: 248 }, // noteringsvaluta buiten de app-valuta's
};
// eToro-rates per instrument-id (USD, zonder valuta in het antwoord)
const etoroRates: Record<string, { bid: number; ask: number }> = { "424242": { bid: 100, ask: 102 } };

const state = { failTicker: false };
const calls: { path: string; params: URLSearchParams }[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const router = (async (input: URL | RequestInfo) => {
  const url = new URL(typeof input === "string" ? input : (input as URL).toString());
  if (url.hostname === "api.kraken.com") {
    calls.push({ path: url.pathname, params: url.searchParams });
    switch (url.pathname) {
      case "/0/public/AssetPairs":
        return json({ error: [], result: krakenPairs });
      case "/0/public/Assets":
        return json({ error: [], result: krakenAssets });
      case "/0/public/Ticker": {
        if (state.failTicker) return json({ error: ["EService:Unavailable"], result: {} });
        const result: Record<string, unknown> = {};
        for (const k of (url.searchParams.get("pair") ?? "").split(",")) {
          const t = tickers[k];
          if (!t) return json({ error: ["EQuery:Unknown asset pair"], result: {} });
          result[k] = { a: [t.c, "1", "1.000"], b: [t.c, "1", "1.000"], c: [t.c, "0.10000000"], v: ["10", "20"], p: [t.c, t.c], t: [5, 10], l: [t.o, t.o], h: [t.c, t.c], o: t.o };
        }
        return json({ error: [], result });
      }
      case "/0/public/OHLC": {
        const k = url.searchParams.get("pair") ?? "";
        if (!krakenPairs[k]) return json({ error: ["EQuery:Unknown asset pair"], result: {} });
        return json({ error: [], result: { [k]: [candle(TODAY_SEC - 2 * 86400, "58000.0"), candle(TODAY_SEC - 86400, "59000.0"), candle(TODAY_SEC, "60000.0")], last: TODAY_SEC } });
      }
    }
    return json({ error: ["EGeneral:Unknown endpoint"], result: {} });
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
  // Yahoo: alleen voor "btc" treffers (om de identiteitsregel bij niet-Kraken-kandidaten te testen): crypto als munt-valuta,
  // een ticker in een andere munt (onbruikbaar) en een aandeel met "BTC" in het symbool
  if (url.hostname === "query1.finance.yahoo.com" && url.pathname === "/v1/finance/search") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const quotes = [
      { symbol: "BTC-USD", shortname: "Bitcoin USD", quoteType: "CRYPTOCURRENCY", exchDisp: "CCC" },
      { symbol: "BTC-EUR", shortname: "Bitcoin EUR", quoteType: "CRYPTOCURRENCY", exchDisp: "CCC" },
      { symbol: "ETH-BTC", shortname: "Ethereum BTC", quoteType: "CRYPTOCURRENCY", exchDisp: "CCC" },
      { symbol: "BTCS", longname: "BTCS Inc.", quoteType: "EQUITY", exchDisp: "NasdaqCM" },
    ];
    return json({ quotes: q === "btc" || q === "bitcoin" ? quotes : [] });
  }
  // Yahoo chart (getQuote: range=5d, getDailyHistory: range=1y): twee dagen, meta in de noteringsvaluta van de ticker
  if (url.hostname === "query1.finance.yahoo.com" && url.pathname.startsWith("/v8/finance/chart/")) {
    const symbol = decodeURIComponent(url.pathname.slice("/v8/finance/chart/".length));
    const c = yahooCharts[symbol];
    if (!c) return json({ chart: { result: null, error: { code: "Not Found", description: `No data found for ${symbol}` } } });
    const meta = { currency: c.currency, symbol, exchangeName: "TST", regularMarketPrice: c.price, chartPreviousClose: c.prev, regularMarketTime: TODAY_SEC + 3600, shortName: symbol };
    return json({ chart: { result: [{ meta, timestamp: [TODAY_SEC - 86400, TODAY_SEC], indicators: { quote: [{ close: [c.prev, c.price] }] } }], error: null } });
  }
  // eToro: rates (bid/ask per instrument) en een lege candle-historie
  if (url.hostname === "public-api.etoro.com") {
    if (url.pathname === "/api/v2/market-data/rates") {
      const ids = (url.searchParams.get("instrumentIds") ?? "").split(",");
      return json({ results: ids.filter((id) => etoroRates[id]).map((id) => ({ instrumentId: Number(id), bid: etoroRates[id].bid, ask: etoroRates[id].ask, date: new Date().toISOString(), quoteType: "Live" })) });
    }
    if (/^\/api\/v1\/market-data\/instruments\/\d+\/history\/candles\//.test(url.pathname)) return json({ candles: [{ candles: [] }] });
  }
  return new Response("blocked", { status: 403 });
}) as typeof fetch;

beforeAll(() => {
  vi.stubGlobal("fetch", router);
  getDb();
});

const assetBySymbol = (symbol: string) => getDb().select().from(schema.assets).all().find((a) => a.symbol === symbol)!;

describe("Kraken in de koerspijplijn", () => {
  it("addAssetFromInput maakt een nieuw Kraken-crypto-asset aan (in USD genoteerd) met paarsleutel en base-code", async () => {
    const sol = await addAssetFromInput({ symbol: "sol", name: "Solana", category: "crypto", currency: "EUR", priceSource: "kraken", sourceId: "SOLEUR" });
    // crypto staat net als bij de koppelingen in USD genoteerd; de koers (EUR, van het paar) bepaalt de waarderingsvaluta
    expect(sol).toMatchObject({ symbol: "SOL", name: "Solana", category: "crypto", currency: "USD", priceSource: "kraken", sourceId: "SOLEUR" });
    expect(JSON.parse(sol.providerIds ?? "{}")).toEqual({ kraken: "SOL" });
  });

  it("zoeken: Kraken-kandidaat wijst naar het bestaande crypto-asset met een andere bron en leent naam en logo", async () => {
    const btc = upsertAsset({ symbol: "BTC", name: "Bitcoin", category: "crypto", currency: "USD", priceSource: "etoro", sourceId: "100000", logoUrl: "https://x/btc.png" });
    getDb().update(schema.assets).set({ providerIds: JSON.stringify({ etoro: "100000" }) }).where(eq(schema.assets.id, btc.id)).run();

    const { candidates, errors } = await searchAssetCandidates("btc");
    expect(errors).toEqual([]);
    const kraken = candidates.filter((c) => c.source === "kraken");
    expect(kraken).toHaveLength(1); // één kandidaat per munt, EUR boven USD
    expect(kraken[0]).toMatchObject({ symbol: "BTC", name: "Bitcoin", currency: "EUR", sourceId: "XXBTZEUR", exchange: "Kraken", type: "crypto", logoUrl: "https://x/btc.png", categoryGuess: "crypto", existingAssetId: btc.id });
    // ook een Yahoo-/eToro-crypto-kandidaat wijst naar het bestaande crypto-asset (bron-upgrade, geen tweede BTC): de Yahoo-ticker
    // (BTC-USD) is het bron-id, het symbool de munt, de naam zonder valuta; ETH-BTC (koers in BTC) valt af, het aandeel BTCS blijft
    const viaYahoo = candidates.filter((c) => c.source === "yahoo");
    expect(viaYahoo.map((c) => [c.symbol, c.sourceId, c.name, c.currency, c.categoryGuess, c.existingAssetId])).toEqual([
      ["BTC", "BTC-USD", "Bitcoin", "USD", "crypto", btc.id],
      ["BTC", "BTC-EUR", "Bitcoin", "EUR", "crypto", btc.id],
      ["BTCS", "BTCS", "BTCS Inc.", "USD", "stock", undefined],
    ]);
    expect(candidates.some((c) => c.current)).toBe(false); // BTC volgt eToro; eToro is hier niet geconfigureerd
    // zoeken op de naam: Kraken kent geen namen, maar de munt uit de Yahoo-treffers (BTC) wordt alsnog bij Kraken opgezocht
    const byName = await searchAssetCandidates("bitcoin");
    expect(byName.candidates.filter((c) => c.source === "kraken")).toHaveLength(1);
    expect(byName.candidates.find((c) => c.source === "kraken")).toMatchObject({ symbol: "BTC", sourceId: "XXBTZEUR", name: "Bitcoin", existingAssetId: btc.id });
    expect(byName.candidates[0]).toMatchObject({ source: "local", assetId: btc.id }); // asset heet "Bitcoin": gewone lokale treffer

    // SOL gebruikt Kraken al → de kandidaat blijft zichtbaar als huidige bron, naast de lokale rij
    const sol = await searchAssetCandidates("sol");
    const solLocal = sol.candidates.find((c) => c.source === "local")!;
    expect(sol.candidates.find((c) => c.source === "kraken")).toMatchObject({ symbol: "SOL", name: "Solana", sourceId: "SOLEUR", existingAssetId: solLocal.assetId, current: true });

    // nog onbekend → kandidaat zonder existingAssetId, naam = symbool
    const eth = await searchAssetCandidates("eth");
    const ke = eth.candidates.find((c) => c.source === "kraken")!;
    expect(ke).toMatchObject({ symbol: "ETH", name: "ETH", currency: "EUR", sourceId: "XETHZEUR", logoUrl: null });
    expect(ke.existingAssetId).toBeUndefined();
  });

  it("addAssetFromInput waardeert het bestaande BTC/USD-asset op naar Kraken zonder valuta of naam aan te raken", async () => {
    const before = assetBySymbol("BTC");
    const upgraded = await addAssetFromInput({ symbol: "BTC", name: "Bitcoin (Kraken)", category: "crypto", currency: "EUR", priceSource: "kraken", sourceId: "XXBTZEUR" });
    expect(upgraded.id).toBe(before.id);
    expect(upgraded).toMatchObject({ priceSource: "kraken", sourceId: "XXBTZEUR", currency: "USD", name: "Bitcoin", logoUrl: "https://x/btc.png" });
    expect(JSON.parse(upgraded.providerIds ?? "{}")).toEqual({ etoro: "100000", kraken: "XXBT" });
    expect(getDb().select().from(schema.assets).all().filter((a) => a.symbol === "BTC")).toHaveLength(1);

    // alle bronnen blijven zichtbaar: Kraken als huidige bron (naam en logo van het asset), Yahoo als wissel
    const { candidates } = await searchAssetCandidates("btc");
    expect(candidates.find((c) => c.source === "kraken")).toMatchObject({ symbol: "BTC", name: "Bitcoin", logoUrl: "https://x/btc.png", existingAssetId: upgraded.id, current: true });
    expect(candidates.find((c) => c.source === "yahoo")).toMatchObject({ symbol: "BTC", sourceId: "BTC-USD", existingAssetId: upgraded.id });
    expect(candidates.find((c) => c.source === "yahoo")!.current).toBeUndefined();
    // zoeken op de naam vindt het asset ook als alleen de bronnen de naam kennen (asset heet "BTC", zoals de Kraken-sync het
    // aanmaakt): de lokale rij komt er dan bij, en de Kraken-kandidaat leent de naam van de Yahoo-kandidaat
    getDb().update(schema.assets).set({ name: "BTC" }).where(eq(schema.assets.id, upgraded.id)).run();
    try {
      const byName = await searchAssetCandidates("btc");
      expect(byName.candidates[0]).toMatchObject({ source: "local", assetId: upgraded.id, symbol: "BTC", name: "BTC" });
      expect(byName.candidates.filter((c) => c.source === "local")).toHaveLength(1);
      expect(byName.candidates.find((c) => c.source === "kraken")).toMatchObject({ name: "Bitcoin", existingAssetId: upgraded.id, current: true });
    } finally {
      getDb().update(schema.assets).set({ name: "Bitcoin" }).where(eq(schema.assets.id, upgraded.id)).run();
    }
  });

  it("existingAssetId wordt afgedwongen: nooit een tweede asset, ook niet met een andere categorie; mismatch of een bron zonder feed geeft een fout", async () => {
    const btc = assetBySymbol("BTC");
    const again = await addAssetFromInput({ symbol: "BTC", name: "Bitcoin", category: "commodity", currency: "EUR", priceSource: "kraken", sourceId: "XXBTZEUR", existingAssetId: btc.id });
    expect(again.id).toBe(btc.id);
    expect(again).toMatchObject({ category: "crypto", currency: "USD", name: "Bitcoin", priceSource: "kraken", sourceId: "XXBTZEUR" });
    expect(getDb().select().from(schema.assets).all().filter((a) => a.symbol === "BTC")).toHaveLength(1);
    await expect(addAssetFromInput({ symbol: "SOL", name: "Solana", category: "crypto", currency: "EUR", priceSource: "kraken", sourceId: "SOLEUR", existingAssetId: btc.id })).rejects.toThrow("Bestaand asset niet gevonden of geen crypto-asset met dit symbool.");
    await expect(addAssetFromInput({ symbol: "BTC", name: "Bitcoin", category: "crypto", currency: "USD", priceSource: "manual", existingAssetId: btc.id })).rejects.toThrow("Er bestaat al een crypto-asset BTC; alleen een koersfeed (Kraken, eToro of Yahoo) kan daarop worden gezet.");
    expect(assetBySymbol("BTC")).toMatchObject({ priceSource: "kraken", sourceId: "XXBTZEUR" });
  });

  it("identiteitsregel voor elke bron: een eToro- of Yahoo-kandidaat maakt geen tweede crypto-asset maar zet de feed op het bestaande asset", async () => {
    // BTC staat in USD op Kraken: een eToro-keuze wisselt alleen de bron; naam, valuta en providerIds blijven staan
    const btc = assetBySymbol("BTC");
    const viaEtoro = await addAssetFromInput({ symbol: "BTC", name: "Bitcoin (eToro)", category: "crypto", currency: "USD", priceSource: "etoro", sourceId: "100000" });
    expect(viaEtoro.id).toBe(btc.id);
    expect(viaEtoro).toMatchObject({ priceSource: "etoro", sourceId: "100000", name: "Bitcoin", currency: "USD" });
    expect(JSON.parse(viaEtoro.providerIds ?? "{}")).toEqual({ etoro: "100000", kraken: "XXBT" });
    // een crypto-asset in EUR (bijv. ooit uit een CSV-import) wordt ook gevonden: geen tweede DOGE, geen valutawijziging
    const doge = upsertAsset({ symbol: "DOGE", name: "Dogecoin", category: "crypto", currency: "EUR", priceSource: "manual" });
    const viaYahoo = await addAssetFromInput({ symbol: "DOGE", name: "Dogecoin USD", category: "crypto", currency: "USD", priceSource: "yahoo", sourceId: "DOGE-USD" });
    expect(viaYahoo.id).toBe(doge.id);
    expect(viaYahoo).toMatchObject({ priceSource: "yahoo", sourceId: "DOGE-USD", currency: "EUR", name: "Dogecoin" });
    expect(getDb().select().from(schema.assets).all().filter((a) => a.symbol === "DOGE")).toHaveLength(1);
    // handmatig aanmaken met een bestaand crypto-symbool wordt geweigerd in plaats van stilzwijgend de feed te overschrijven
    await expect(addAssetFromInput({ symbol: "DOGE", name: "Doge", category: "crypto", currency: "EUR", priceSource: "manual" })).rejects.toThrow("Er bestaat al een crypto-asset DOGE");
    expect(assetBySymbol("DOGE")).toMatchObject({ priceSource: "yahoo", sourceId: "DOGE-USD" });
    // de Kraken-kandidaat brengt BTC weer op Kraken (vervolgtests)
    const back = await addAssetFromInput({ symbol: "BTC", name: "Bitcoin", category: "crypto", currency: "EUR", priceSource: "kraken", sourceId: "XXBTZEUR" });
    expect(back).toMatchObject({ id: btc.id, priceSource: "kraken", sourceId: "XXBTZEUR", currency: "USD" });
    expect(getDb().select().from(schema.assets).all().filter((a) => a.symbol === "BTC")).toHaveLength(1);
    getDb().delete(schema.assets).where(eq(schema.assets.id, doge.id)).run();
  });

  it("Yahoo-crypto: de ticker (BTC-USD) is het bron-id en de munt het symbool — geen tweede asset naast BTC; een ticker in een andere munt of van een andere munt wordt geweigerd", async () => {
    const btc = assetBySymbol("BTC");
    // zoals de zoekresultaten van vóór de normalisatie het aanleverden: symbool = ticker
    const viaTicker = await addAssetFromInput({ symbol: "BTC-USD", name: "Bitcoin USD", category: "crypto", currency: "USD", priceSource: "yahoo", sourceId: "BTC-USD" });
    expect(viaTicker.id).toBe(btc.id);
    expect(viaTicker).toMatchObject({ symbol: "BTC", name: "Bitcoin", priceSource: "yahoo", sourceId: "BTC-USD", currency: "USD" });
    expect(getDb().select().from(schema.assets).all().filter((a) => a.symbol.startsWith("BTC"))).toHaveLength(1);
    // ook met existingAssetId (de badge) past het genormaliseerde symbool bij het asset
    expect((await addAssetFromInput({ symbol: "BTC-EUR", name: "Bitcoin EUR", category: "crypto", currency: "EUR", priceSource: "yahoo", sourceId: "BTC-EUR", existingAssetId: btc.id })).sourceId).toBe("BTC-EUR");
    // nieuw asset: symbool = munt, naam zonder valuta, in USD genoteerd; zonder bron-id wordt de ticker het bron-id
    const ltc = await addAssetFromInput({ symbol: "LTC-EUR", name: "Litecoin EUR", category: "crypto", currency: "EUR", priceSource: "yahoo", sourceId: "LTC-EUR" });
    expect(ltc).toMatchObject({ symbol: "LTC", name: "Litecoin", currency: "USD", priceSource: "yahoo", sourceId: "LTC-EUR" });
    const ada = await addAssetFromInput({ symbol: "ada-usd", name: "Cardano USD", category: "crypto", currency: "USD", priceSource: "yahoo" });
    expect(ada).toMatchObject({ symbol: "ADA", name: "Cardano", sourceId: "ADA-USD" });
    // onbruikbaar (koers in BTC) of van een andere munt: geweigerd, geen asset
    await expect(addAssetFromInput({ symbol: "ETH-BTC", name: "Ethereum BTC", category: "crypto", currency: "USD", priceSource: "yahoo", sourceId: "ETH-BTC" })).rejects.toThrow("Yahoo-ticker ETH-BTC noteert in BTC; kies een ticker in EUR, USD, CHF, GBP (bijv. ETH-EUR).");
    await expect(addAssetFromInput({ symbol: "ETH", name: "Ether", category: "crypto", currency: "USD", priceSource: "yahoo", sourceId: "SOL-EUR" })).rejects.toThrow("Yahoo-ticker SOL-EUR hoort bij SOL, niet bij ETH.");
    expect(getDb().select().from(schema.assets).all().some((a) => a.symbol === "ETH")).toBe(false);
    await expect(updateAsset(btc.id, { priceSource: "yahoo", sourceId: "ETH-BTC" })).rejects.toThrow("noteert in BTC");
    await expect(updateAsset(btc.id, { sourceId: "SOL-EUR" })).rejects.toThrow("hoort bij SOL, niet bij BTC");
    // aandelen met een streepje (BRK-B) worden niet als crypto-ticker gelezen
    const brk = await addAssetFromInput({ symbol: "BRK-B", name: "Berkshire Hathaway", category: "stock", currency: "USD", priceSource: "yahoo", sourceId: "BRK-B" });
    expect(brk).toMatchObject({ symbol: "BRK-B", name: "Berkshire Hathaway" });
    // opruimen en BTC terug op Kraken voor de vervolgtests
    for (const id of [ltc.id, ada.id, brk.id]) getDb().delete(schema.assets).where(eq(schema.assets.id, id)).run();
    const back = await addAssetFromInput({ symbol: "BTC", name: "Bitcoin", category: "crypto", currency: "EUR", priceSource: "kraken", sourceId: "XXBTZEUR" });
    expect(back).toMatchObject({ id: btc.id, priceSource: "kraken", sourceId: "XXBTZEUR", name: "Bitcoin" });
  });

  it("weigert een onbekend Kraken-paar, een paar van een andere munt en een ontbrekend paar bij toevoegen en bewerken", async () => {
    const btc = assetBySymbol("BTC");
    await expect(addAssetFromInput({ symbol: "BTC", name: "Bitcoin", category: "crypto", currency: "USD", priceSource: "kraken", sourceId: "100000" })).rejects.toThrow("Kraken-paar 100000 is onbekend");
    await expect(addAssetFromInput({ symbol: "BTC", name: "Bitcoin", category: "crypto", currency: "USD", priceSource: "kraken", sourceId: "SOLEUR" })).rejects.toThrow("Kraken-paar SOL/EUR hoort bij SOL, niet bij BTC.");
    await expect(addAssetFromInput({ symbol: "BTC", name: "Bitcoin", category: "crypto", currency: "USD", priceSource: "kraken" })).rejects.toThrow("Kraken als koersbron vereist een paar");
    await expect(addAssetFromInput({ symbol: "LINK", name: "Chainlink", category: "crypto", currency: "USD", priceSource: "kraken", sourceId: "ADAEUR" })).rejects.toThrow("hoort bij ADA, niet bij LINK");
    expect(getDb().select().from(schema.assets).all().some((a) => a.symbol === "LINK")).toBe(false);
    // bewerken: bron wisselen met een achtergebleven eToro-id, een paar van een andere munt, een leeg paar of een ander symbool
    await expect(updateAsset(btc.id, { priceSource: "kraken", sourceId: "100000" })).rejects.toThrow("Kraken-paar 100000 is onbekend");
    await expect(updateAsset(btc.id, { sourceId: "SOLEUR" })).rejects.toThrow("Kraken-paar SOL/EUR hoort bij SOL, niet bij BTC.");
    await expect(updateAsset(btc.id, { sourceId: null })).rejects.toThrow("Kraken als koersbron vereist een paar");
    await expect(updateAsset(btc.id, { symbol: "SOL" })).rejects.toThrow("Kraken-paar XBT/EUR hoort bij BTC, niet bij SOL.");
    expect(assetBySymbol("BTC")).toMatchObject({ id: btc.id, priceSource: "kraken", sourceId: "XXBTZEUR", providerIds: JSON.stringify({ etoro: "100000", kraken: "XXBT" }) });
    expect(getDb().select().from(schema.assets).all().filter((a) => a.symbol === "BTC")).toHaveLength(1);
  });

  it("weigert een Kraken-paar buiten de app-valuta's bij toevoegen en bewerken", async () => {
    await expect(addAssetFromInput({ symbol: "BTC", name: "Bitcoin", category: "crypto", currency: "USD", priceSource: "kraken", sourceId: "XBTUSDT" })).rejects.toThrow("Kraken-paar XBTUSDT: XBT/USDT noteert in USDT; kies een paar in EUR, USD, CHF, GBP.");
    await expect(addAssetFromInput({ symbol: "ETH", name: "Ether", category: "crypto", currency: "USD", priceSource: "kraken", sourceId: "ETHXBT" })).rejects.toThrow(/noteert in BTC/);
    expect(getDb().select().from(schema.assets).all().some((a) => a.symbol === "ETH")).toBe(false);
    const btc = assetBySymbol("BTC");
    await expect(updateAsset(btc.id, { sourceId: "XBTUSDT" })).rejects.toThrow(/noteert in USDT/);
    await expect(updateAsset(btc.id, { priceSource: "kraken", sourceId: "ethxbt" })).rejects.toThrow(/noteert in BTC/);
    expect(assetBySymbol("BTC")).toMatchObject({ priceSource: "kraken", sourceId: "XXBTZEUR" }); // ongewijzigd
  });

  it("updateAsset laat de koersbron staan als de PATCH hem weglaat, en vult providerIds.kraken aan bij een nieuwe Kraken-bron", async () => {
    const btc = assetBySymbol("BTC");
    const renamed = await updateAsset(btc.id, { name: "Bitcoin!" });
    expect(renamed).toMatchObject({ name: "Bitcoin!", priceSource: "kraken", sourceId: "XXBTZEUR" });
    expect(await updateAsset(btc.id, { name: "Bitcoin" })).toMatchObject({ name: "Bitcoin", priceSource: "kraken" });
    const ada = upsertAsset({ symbol: "ADA", name: "Cardano", category: "crypto", currency: "USD", priceSource: "manual" });
    const onKraken = await updateAsset(ada.id, { priceSource: "kraken", sourceId: "adaeur" });
    expect(onKraken).toMatchObject({ priceSource: "kraken", sourceId: "adaeur" });
    expect(JSON.parse(onKraken.providerIds ?? "{}")).toEqual({ kraken: "ADA" });
    getDb().delete(schema.assets).where(eq(schema.assets.id, ada.id)).run(); // niet meenemen in de verversronde hieronder
  });

  it("bronwissel weg van Kraken/eToro: een achtergebleven bron-id (het bewerkvenster vult het huidige id voor) wordt geweigerd, een passend id niet", async () => {
    const btc = assetBySymbol("BTC");
    expect(btc).toMatchObject({ priceSource: "kraken", sourceId: "XXBTZEUR" });
    // naar eToro: alleen een numeriek instrumentId (anders belandt NaN in de gezamenlijke rates-call)
    await expect(updateAsset(btc.id, { priceSource: "etoro", sourceId: "XXBTZEUR" })).rejects.toThrow("eToro-id XXBTZEUR is geen instrumentId");
    await expect(updateAsset(btc.id, { priceSource: "etoro", sourceId: null })).rejects.toThrow("eToro als koersbron vereist een numeriek instrumentId");
    // naar Yahoo: geen leeg id, geen Kraken-paar van de vorige bron (ongeacht hoofdletters)
    await expect(updateAsset(btc.id, { priceSource: "yahoo", sourceId: "XXBTZEUR" })).rejects.toThrow("XXBTZEUR is het Kraken-paar van de vorige bron");
    await expect(updateAsset(btc.id, { priceSource: "yahoo", sourceId: "xxbtzeur" })).rejects.toThrow("Kraken-paar van de vorige bron");
    await expect(updateAsset(btc.id, { priceSource: "yahoo", sourceId: null })).rejects.toThrow("Yahoo als koersbron vereist een symbool");
    expect(assetBySymbol("BTC")).toMatchObject({ priceSource: "kraken", sourceId: "XXBTZEUR" }); // ongewijzigd
    // geldige wissels
    expect(await updateAsset(btc.id, { priceSource: "etoro", sourceId: "100000" })).toMatchObject({ priceSource: "etoro", sourceId: "100000" });
    await expect(updateAsset(btc.id, { priceSource: "yahoo", sourceId: "100000" })).rejects.toThrow("Yahoo-symbool 100000 lijkt een eToro-instrumentId"); // eToro-id achtergebleven
    expect(await updateAsset(btc.id, { priceSource: "yahoo", sourceId: "BTC-EUR" })).toMatchObject({ priceSource: "yahoo", sourceId: "BTC-EUR" });
    // zonder wijziging van bron of id (naam bewerken, ook via het venster dat alles meestuurt) wordt niets gecontroleerd: een oude Yahoo-rij zonder id blijft bewerkbaar
    getDb().update(schema.assets).set({ sourceId: null }).where(eq(schema.assets.id, btc.id)).run();
    expect(await updateAsset(btc.id, { name: "Bitcoin!" })).toMatchObject({ name: "Bitcoin!", priceSource: "yahoo", sourceId: null });
    expect(await updateAsset(btc.id, { name: "Bitcoin", priceSource: "yahoo", sourceId: null })).toMatchObject({ name: "Bitcoin", priceSource: "yahoo", sourceId: null });
    // toevoegen kent dezelfde controle
    await expect(addAssetFromInput({ symbol: "NEWC", name: "Nieuw", category: "stock", currency: "USD", priceSource: "etoro", sourceId: "NEWC" })).rejects.toThrow("eToro-id NEWC is geen instrumentId");
    await expect(addAssetFromInput({ symbol: "NEWC", name: "Nieuw", category: "stock", currency: "USD", priceSource: "yahoo", sourceId: "123" })).rejects.toThrow("lijkt een eToro-instrumentId");
    expect(getDb().select().from(schema.assets).all().some((a) => a.symbol === "NEWC")).toBe(false);
    // terug naar Kraken voor de vervolgtests
    expect(await updateAsset(btc.id, { priceSource: "kraken", sourceId: "XXBTZEUR" })).toMatchObject({ priceSource: "kraken", sourceId: "XXBTZEUR" });
  });

  it("refreshAll haalt alle Kraken-koersen in één Ticker-call op, met de open van vandaag als previousClose in de valuta van het pair", async () => {
    upsertAsset({ symbol: "NOPE", name: "Onbekend pair", category: "crypto", currency: "EUR", priceSource: "kraken", sourceId: "NOPEEUR" });
    calls.length = 0;
    const report = await refreshAll("manual");

    const ticker = calls.filter((c) => c.path === "/0/public/Ticker");
    expect(ticker).toHaveLength(1);
    expect((ticker[0].params.get("pair") ?? "").split(",").sort()).toEqual(["SOLEUR", "XXBTZEUR"]);

    expect(latestQuote(assetBySymbol("BTC").id)).toMatchObject({ day: TODAY, price: "60000.5", previousClose: "59000", currency: "EUR", source: "kraken" });
    expect(latestQuote(assetBySymbol("SOL").id)).toMatchObject({ day: TODAY, price: "150.25", previousClose: "149", currency: "EUR", source: "kraken" });
    expect(report.updated).toBe(2);
    expect(report.failed).toEqual([{ asset: "NOPE", assetId: assetBySymbol("NOPE").id, error: "Kraken: geen koers voor NOPEEUR" }]);
    expect(report.fxDate).toBe(TODAY);

    // storing bij Kraken: elk Kraken-asset mislukt, de ronde zelf loopt door
    state.failTicker = true;
    try {
      const r2 = await refreshAll("manual");
      expect(r2.updated).toBe(0);
      expect(r2.failed.map((f) => f.asset).sort()).toEqual(["BTC", "NOPE", "SOL"]);
      expect(r2.failed.every((f) => f.error.includes("EService:Unavailable"))).toBe(true);
      expect(r2.finishedAt >= r2.startedAt).toBe(true);
    } finally {
      state.failTicker = false;
    }
    getDb().update(schema.assets).set({ active: false }).where(eq(schema.assets.symbol, "NOPE")).run();
  });

  it("backfillHistory schrijft één rij per dagcandle, zonder de candle van vandaag", async () => {
    const btc = assetBySymbol("BTC");
    calls.length = 0;
    const n = await backfillHistory(btc, 30);
    expect(n).toBe(2);
    const ohlc = calls.find((c) => c.path === "/0/public/OHLC")!;
    expect(ohlc.params.get("pair")).toBe("XXBTZEUR");
    expect(ohlc.params.get("interval")).toBe("1440");
    const rows = quoteHistory(btc.id, day(-5)).map((r) => [r.day, r.price, r.currency, r.source]);
    expect(rows).toEqual([
      [day(-2), "58000", "EUR", "kraken"],
      [day(-1), "59000", "EUR", "kraken"],
      [TODAY, "60000.5", "EUR", "kraken"], // de rij van refreshAll blijft staan
    ]);
  });

  it("primeAssetPrice schrijft koers en historie, maar laat asset.currency staan", async () => {
    const eth = await addAssetFromInput({ symbol: "ETH", name: "Ether", category: "crypto", currency: "USD", priceSource: "kraken", sourceId: "XETHZEUR" });
    expect(JSON.parse(eth.providerIds ?? "{}")).toEqual({ kraken: "XETH" });
    await primeAssetPrice(eth);
    expect(latestQuote(eth.id)).toMatchObject({ day: TODAY, price: "3000", previousClose: "2950", currency: "EUR", source: "kraken" });
    expect(quoteHistory(eth.id, day(-5)).map((r) => r.day)).toEqual([day(-2), day(-1), TODAY]);
    expect(assetBySymbol("ETH").currency).toBe("USD");
  });

  it("saveQuote wist de previousClose van Kraken zodra een andere bron dezelfde dag zonder vorige slot schrijft", async () => {
    const eth = assetBySymbol("ETH");
    expect(previousClose(eth.id)).toBe("2950");
    saveQuote(eth.id, new Date().toISOString(), 3300, "USD", "etoro"); // eToro- en handmatige koersen geven geen previousClose mee
    expect(latestQuote(eth.id)).toMatchObject({ day: TODAY, price: "3300", currency: "USD", source: "etoro", previousClose: null });
    expect(previousClose(eth.id)).toBeNull(); // de rij van gisteren is in EUR: geen dagverandering over valuta's heen
    saveQuote(eth.id, new Date().toISOString(), 3000, "EUR", "kraken", 2950); // terug naar Kraken
    expect(previousClose(eth.id)).toBe("2950");
  });

  it("CSV-import koppelt crypto op symbool ongeacht valuta, ook bij een categorie-override bij het bevestigen", async () => {
    const btc = assetBySymbol("BTC");
    const eth = assetBySymbol("ETH");
    const sheet = {
      sheetName: "Blad1",
      headers: ["Date", "Symbol", "Quantity", "Price", "Currency"],
      rows: [
        { Date: "2026-01-05", Symbol: "BTC", Quantity: "0.1", Price: "50000", Currency: "EUR" },
        { Date: "2026-01-06", Symbol: "ETH", Quantity: "1", Price: "2500", Currency: "EUR" },
      ],
    };
    const mapping: ColumnMapping = { date: "Date", symbol: "Symbol", quantity: "Quantity", price: "Price", currency: "Currency", defaultType: "buy", defaultCategory: "crypto" };
    expect(genericToDrafts(sheet, mapping, "test.csv").map((d) => d.existingAssetId)).toEqual([btc.id, eth.id]); // BTC/USD en ETH/USD gevonden voor EUR-regels

    const asStock = genericToDrafts(sheet, { ...mapping, defaultCategory: "stock" }, "test.csv");
    expect(asStock.map((d) => d.existingAssetId)).toEqual([null, null]);
    const platform = getDb().select().from(schema.platforms).get()!;
    const portfolio = getDb().select().from(schema.portfolios).get()!;
    const r = await commitImport(asStock, { portfolioId: portfolio.id, platformId: platform.id, yahooSuffix: "", priceSource: "yahoo", categoryOverrides: { BTC: "crypto", ETH: "crypto" } });
    expect(r.errors).toEqual([]);
    expect(r.created).toBe(2);
    expect(r.newAssets).toEqual([]);
    const all = getDb().select().from(schema.assets).all();
    expect(all.filter((a) => a.symbol === "BTC")).toHaveLength(1);
    expect(all.filter((a) => a.symbol === "ETH")).toHaveLength(1);
    const tx = getDb().select().from(schema.transactions).all().filter((t) => t.source === "csv");
    expect(tx.map((t) => t.assetId).sort()).toEqual([btc.id, eth.id].sort());
  });

  it("CSV-import noteert een nieuw crypto-asset in USD, ongeacht de valuta van de regel; een latere Kraken-keuze vindt hetzelfde asset", async () => {
    const sheet = { sheetName: "Blad1", headers: ["Date", "Symbol", "Quantity", "Price", "Currency"], rows: [{ Date: "2026-01-07", Symbol: "ADA", Quantity: "100", Price: "0.5", Currency: "EUR" }] };
    const mapping: ColumnMapping = { date: "Date", symbol: "Symbol", quantity: "Quantity", price: "Price", currency: "Currency", defaultType: "buy", defaultCategory: "crypto" };
    const platform = getDb().select().from(schema.platforms).get()!;
    const portfolio = getDb().select().from(schema.portfolios).get()!;
    const r = await commitImport(genericToDrafts(sheet, mapping, "ada.csv"), { portfolioId: portfolio.id, platformId: platform.id, yahooSuffix: "", priceSource: "manual" });
    expect(r.errors).toEqual([]);
    expect(r.newAssets).toEqual(["ADA"]);
    const ada = assetBySymbol("ADA");
    expect(ada).toMatchObject({ category: "crypto", currency: "USD", priceSource: "manual" });
    expect(getDb().select().from(schema.transactions).all().find((t) => t.assetId === ada.id)).toMatchObject({ currency: "EUR", price: "0.5" }); // de transactie houdt de valuta van de regel
    const onKraken = await addAssetFromInput({ symbol: "ADA", name: "Cardano", category: "crypto", currency: "EUR", priceSource: "kraken", sourceId: "ADAEUR" });
    expect(onKraken).toMatchObject({ id: ada.id, priceSource: "kraken", sourceId: "ADAEUR", currency: "USD" });
    expect(getDb().select().from(schema.assets).all().filter((a) => a.symbol === "ADA")).toHaveLength(1);
  });

  it("weigert een Kraken-crypto-kandidaat als er al een aandeel met dat symbool in USD staat (LINK: Interlink Electronics vs Chainlink)", async () => {
    const stock = upsertAsset({ symbol: "LINK", name: "Interlink Electronics", category: "stock", currency: "USD", priceSource: "yahoo", sourceId: "LINK" });
    // de kandidaat heeft geen existingAssetId (er is geen crypto-LINK) en zou via upsertAsset op de aandelenrij landen
    await expect(addAssetFromInput({ symbol: "LINK", name: "Chainlink", category: "crypto", currency: "EUR", priceSource: "kraken", sourceId: "LINKEUR" })).rejects.toThrow("Er bestaat al een asset LINK/USD in de categorie Aandelen; kies een ander symbool of bewerk dat asset.");
    const rows = getDb().select().from(schema.assets).all().filter((a) => a.symbol === "LINK");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: stock.id, name: "Interlink Electronics", category: "stock", currency: "USD", priceSource: "yahoo", sourceId: "LINK", providerIds: null });
    getDb().delete(schema.assets).where(eq(schema.assets.id, stock.id)).run();
  });

  it("weigert een Yahoo-aandeel als er al een crypto-asset met dat symbool in USD staat (omgekeerde richting)", async () => {
    const coin = upsertAsset({ symbol: "LINK", name: "Chainlink", category: "crypto", currency: "USD", priceSource: "kraken", sourceId: "LINKEUR" });
    await expect(addAssetFromInput({ symbol: "LINK", name: "Interlink Electronics", category: "stock", currency: "USD", priceSource: "yahoo", sourceId: "LINK" })).rejects.toThrow("Er bestaat al een asset LINK/USD in de categorie Crypto");
    const rows = getDb().select().from(schema.assets).all().filter((a) => a.symbol === "LINK");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: coin.id, name: "Chainlink", category: "crypto", currency: "USD", priceSource: "kraken", sourceId: "LINKEUR" });
    // een aandeel in een ándere valuta botst niet (aparte rij op symbool+valuta) en blijft gewoon mogelijk
    const eur = await addAssetFromInput({ symbol: "LINK", name: "Interlink Electronics", category: "stock", currency: "EUR", priceSource: "manual" });
    expect(eur).toMatchObject({ category: "stock", currency: "EUR" });
    expect(eur.id).not.toBe(coin.id);
    expect(assetBySymbol("LINK")).toMatchObject({ id: coin.id, category: "crypto" });
    getDb().delete(schema.assets).where(eq(schema.assets.id, coin.id)).run();
    getDb().delete(schema.assets).where(eq(schema.assets.id, eur.id)).run();
  });

  it("primeAssetPrice via Yahoo: crypto blijft in USD genoteerd als de ticker in EUR noteert, de koers en historie komen wel binnen", async () => {
    // Kraken-sync valt voor munten zonder fiatpaar terug op yahoo:XYZ-EUR; het asset staat volgens de identiteitsregel in USD
    const xyz = upsertAsset({ symbol: "XYZ", name: "Xyz-munt", category: "crypto", currency: "USD", priceSource: "yahoo", sourceId: "XYZ-EUR" });
    await primeAssetPrice(xyz);
    expect(latestQuote(xyz.id)).toMatchObject({ day: TODAY, price: "12.5", previousClose: "12", currency: "EUR", source: "yahoo" });
    expect(quoteHistory(xyz.id, day(-5)).map((r) => [r.day, r.price, r.currency])).toEqual([
      [day(-1), "12", "EUR"],
      [TODAY, "12.5", "EUR"],
    ]);
    expect(assetBySymbol("XYZ")).toMatchObject({ currency: "USD", category: "crypto" });
    getDb().delete(schema.assets).where(eq(schema.assets.id, xyz.id)).run();
  });

  it("primeAssetPrice via Yahoo: een aandeel volgt de noteringsvaluta; botst dat met een bestaande rij, dan blijft de valuta staan en loopt de backfill door", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const first = upsertAsset({ symbol: "ABC", name: "ABC NV", category: "stock", currency: "USD", priceSource: "yahoo", sourceId: "ABC.AS" });
      await primeAssetPrice(first);
      expect(getDb().select().from(schema.assets).where(eq(schema.assets.id, first.id)).get()).toMatchObject({ currency: "EUR" }); // herschreven naar de Yahoo-valuta
      expect(latestQuote(first.id)).toMatchObject({ day: TODAY, price: "40", currency: "EUR", source: "yahoo" });
      expect(warn).not.toHaveBeenCalled();

      // tweede rij ABC/USD op dezelfde ticker: de herschrijving naar EUR botst met de unieke index (ABC/EUR bestaat al)
      const second = upsertAsset({ symbol: "ABC", name: "ABC NV (USD)", category: "stock", currency: "USD", priceSource: "yahoo", sourceId: "ABC.AS" });
      expect(second.id).not.toBe(first.id);
      await primeAssetPrice(second);
      expect(getDb().select().from(schema.assets).where(eq(schema.assets.id, second.id)).get()).toMatchObject({ currency: "USD" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("Valuta van ABC niet bijgewerkt naar EUR");
      expect(latestQuote(second.id)).toMatchObject({ day: TODAY, price: "40", currency: "EUR", source: "yahoo" });
      expect(quoteHistory(second.id, day(-5)).map((r) => r.day)).toEqual([day(-1), TODAY]); // backfillHistory is niet overgeslagen
      getDb().delete(schema.assets).where(eq(schema.assets.id, first.id)).run();
      getDb().delete(schema.assets).where(eq(schema.assets.id, second.id)).run();
    } finally {
      warn.mockRestore();
    }
  });

  it("primeAssetPrice via Yahoo: een noteringsvaluta buiten de app-valuta's (SEK) komt niet in assets.currency; koers en historie wel", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const volvo = upsertAsset({ symbol: "VOLV-B", name: "Volvo B", category: "stock", currency: "USD", priceSource: "yahoo", sourceId: "VOLV-B.ST" });
      await primeAssetPrice(volvo);
      expect(assetBySymbol("VOLV-B")).toMatchObject({ currency: "USD" }); // geen SEK in de Currency-kolom (transactieformulier/alerts zouden dan weigeren)
      expect(latestQuote(volvo.id)).toMatchObject({ day: TODAY, price: "250", previousClose: "248", currency: "SEK", source: "yahoo" });
      expect(quoteHistory(volvo.id, day(-5)).map((r) => r.day)).toEqual([day(-1), TODAY]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("Valuta van VOLV-B niet bijgewerkt naar SEK: geen app-valuta");
      getDb().delete(schema.assets).where(eq(schema.assets.id, volvo.id)).run();
    } finally {
      warn.mockRestore();
    }
  });

  it("CSV-import: een aandelenregel wordt niet aan de munt met hetzelfde symbool gekoppeld en de commit weigert de rij in plaats van de munt om te zetten (en omgekeerd)", async () => {
    const platform = getDb().select().from(schema.platforms).get()!;
    const portfolio = getDb().select().from(schema.portfolios).get()!;
    const headers = ["Date", "Symbol", "Quantity", "Price", "Currency"];
    const mapping: ColumnMapping = { date: "Date", symbol: "Symbol", quantity: "Quantity", price: "Price", currency: "Currency", defaultType: "buy", defaultCategory: "stock" };
    // de munt AMP/USD (Kraken) bestaat; een aandelenregel AMP in USD (Ameriprise) hoort daar niet bij
    const coin = upsertAsset({ symbol: "AMP", name: "Amp", category: "crypto", currency: "USD", priceSource: "kraken", sourceId: "AMPEUR" });
    const drafts = genericToDrafts({ sheetName: "Blad1", headers, rows: [{ Date: "2026-02-01", Symbol: "AMP", Quantity: "10", Price: "500", Currency: "USD" }] }, mapping, "amp.csv");
    expect(drafts[0].existingAssetId).toBeNull(); // niet vooraf aan de munt gekoppeld
    const r = await commitImport(drafts, { portfolioId: portfolio.id, platformId: platform.id, yahooSuffix: "", priceSource: "yahoo" });
    expect(r).toMatchObject({ created: 0, duplicates: 0, skipped: 0, newAssets: [] });
    expect(r.errors).toEqual([{ row: 2, error: "Er bestaat al een asset AMP/USD in de categorie Crypto; kies een ander symbool of bewerk dat asset." }]);
    expect(assetBySymbol("AMP")).toMatchObject({ id: coin.id, name: "Amp", category: "crypto", currency: "USD", priceSource: "kraken", sourceId: "AMPEUR" });
    expect(getDb().select().from(schema.transactions).all().filter((t) => t.assetId === coin.id)).toHaveLength(0);
    getDb().delete(schema.assets).where(eq(schema.assets.id, coin.id)).run();

    // omgekeerd: een categorie-override naar crypto voor een symbool dat als aandeel in USD bestaat (COMP: Compass vs Compound)
    const stock = upsertAsset({ symbol: "COMP", name: "Compass Inc.", category: "stock", currency: "USD", priceSource: "yahoo", sourceId: "COMP" });
    const drafts2 = genericToDrafts({ sheetName: "Blad1", headers, rows: [{ Date: "2026-02-02", Symbol: "COMP", Quantity: "5", Price: "40", Currency: "EUR" }] }, mapping, "comp.csv");
    expect(drafts2[0].existingAssetId).toBeNull(); // aandeel in USD, regel in EUR
    const r2 = await commitImport(drafts2, { portfolioId: portfolio.id, platformId: platform.id, yahooSuffix: "", priceSource: "manual", categoryOverrides: { COMP: "crypto" } });
    expect(r2.errors).toEqual([{ row: 2, error: "Er bestaat al een asset COMP/USD in de categorie Aandelen; kies een ander symbool of bewerk dat asset." }]);
    expect(r2.newAssets).toEqual([]);
    expect(assetBySymbol("COMP")).toMatchObject({ id: stock.id, name: "Compass Inc.", category: "stock", currency: "USD", priceSource: "yahoo", sourceId: "COMP" });
    expect(getDb().select().from(schema.assets).all().filter((a) => a.symbol === "COMP")).toHaveLength(1);
    // een aandelenregel COMP in USD hoort wél bij het aandeel
    expect(genericToDrafts({ sheetName: "Blad1", headers, rows: [{ Date: "2026-02-02", Symbol: "COMP", Quantity: "5", Price: "40", Currency: "USD" }] }, mapping, "comp.csv")[0].existingAssetId).toBe(stock.id);
    getDb().delete(schema.assets).where(eq(schema.assets.id, stock.id)).run();
  });

  it("zonder koersrij waardeert het portfolio tegen de kostprijs in de transactievaluta, niet via assets.currency (munt in USD, aankoop in EUR)", async () => {
    const platform = getDb().select().from(schema.platforms).get()!;
    const portfolio = getDb().select().from(schema.portfolios).get()!;
    const mapping: ColumnMapping = { date: "Date", symbol: "Symbol", quantity: "Quantity", price: "Price", currency: "Currency", defaultType: "buy", defaultCategory: "crypto" };
    const sheet = { sheetName: "Blad1", headers: ["Date", "Symbol", "Quantity", "Price", "Currency"], rows: [{ Date: "2026-01-08", Symbol: "NOQ", Quantity: "2", Price: "60000", Currency: "EUR" }] };
    const r = await commitImport(genericToDrafts(sheet, mapping, "noq.csv"), { portfolioId: portfolio.id, platformId: platform.id, yahooSuffix: "", priceSource: "manual" });
    expect(r.errors).toEqual([]);
    const noq = assetBySymbol("NOQ");
    expect(noq).toMatchObject({ category: "crypto", currency: "USD", priceSource: "manual" });
    expect(latestQuote(noq.id)).toBeNull();
    const pos = computePortfolio(portfolio.id).positions.find((p) => p.symbol === "NOQ")!;
    expect(pos).toMatchObject({ priceMissing: true, currency: "USD", costCurrency: "EUR", priceCurrency: "EUR", price: "60000.000000", quantity: "2.00000000" });
    expect(pos.value).toMatchObject({ EUR: "120000.00", USD: "132000.00" }); // 2 × 60 000 EUR (× 1,1 naar USD); niet 120 000 / 1,1
    expect(pos.unrealized).toMatchObject({ EUR: "0.00", USD: "0.00" });
    getDb().delete(schema.assets).where(eq(schema.assets.id, noq.id)).run();
  });

  it("primeAssetPrice via eToro schrijft de koers in USD, ook als het asset (legacy) in EUR genoteerd staat", async () => {
    setSecret("etoroApiKey", "test-api-key");
    setSecret("etoroUserKey", "test-user-key");
    try {
      const legacy = upsertAsset({ symbol: "LEG", name: "Legacy-munt", category: "crypto", currency: "EUR", priceSource: "etoro", sourceId: "424242" });
      await primeAssetPrice(legacy);
      expect(latestQuote(legacy.id)).toMatchObject({ day: TODAY, price: "101", currency: "USD", source: "etoro", previousClose: null }); // (bid 100 + ask 102) / 2
      expect(assetBySymbol("LEG").currency).toBe("EUR"); // asset.currency blijft ongemoeid
      getDb().delete(schema.assets).where(eq(schema.assets.id, legacy.id)).run();
    } finally {
      deleteSecret("etoroApiKey");
      deleteSecret("etoroUserKey");
    }
  });
});
