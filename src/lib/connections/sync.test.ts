import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-sync-"));

import { getDb, schema } from "../db";
import { createConnection, runSync, listConnections, reconcile, bookCorrection, testCredentials, deleteConnection, resetWalletBookings } from "./sync";
import { listWalletAccounts, updateWalletAccount } from "./wallet-accounts";
import { computePortfolio } from "../portfolio";
import { upsertAsset } from "../assets";
import { setSetting } from "../settings";
import { getSecret } from "../secrets";
import { FakeEsplora } from "../bitcoin/esplora-fake";
import { makeAddressDeriver, parseExtendedPublicKey } from "../bitcoin/xpub";
import { ZPUB } from "../bitcoin/test-vectors";
import { eq } from "drizzle-orm";

// eigen Bitcoin-node (nep-Esplora), bereikbaar via de instelling bitcoinApiUrl
const btcNode = new FakeEsplora("http://node.test:3006");

// --- nep-servers ---------------------------------------------------------
let etoroPositions: Record<string, unknown>[] = [
  { positionId: "P1", instrumentId: 100000, openRate: 60000, units: 0.1, amount: 6000, openDateTime: "2026-01-10T10:00:00Z", isBuy: true, leverage: 1 },
  { positionId: "P2", instrumentId: 1001, openRate: 180.5, units: 10, amount: 1805, openDateTime: "2026-03-01T09:30:00Z", isBuy: true, leverage: 1 },
];
const krakenTrades = [
  { id: "TAAAAA-AAAAA-AAAAAA", ordertxid: "O1", pair: "XXBTZEUR", time: 1760000000, type: "buy", ordertype: "market", price: "50000.0", cost: "500.0", fee: "1.0", vol: "0.01", margin: "0", misc: "" },
  { id: "TBBBBB-BBBBB-BBBBBB", ordertxid: "O2", pair: "XETHZEUR", time: 1760003600, type: "buy", ordertype: "limit", price: "2500.0", cost: "250.0", fee: "0.5", vol: "0.1", margin: "0", misc: "" },
];
const krakenPair = (key: string, altname: string, wsname: string, base: string, quote: string) => [key, { altname, wsname, aclass_base: "currency", base, aclass_quote: "currency", quote, status: "online", pair_decimals: 1, lot_decimals: 8 }] as const;
let krakenPairs: Record<string, ReturnType<typeof krakenPair>[1]> = Object.fromEntries([krakenPair("XXBTZEUR", "XBTEUR", "XBT/EUR", "XXBT", "ZEUR"), krakenPair("XETHZEUR", "ETHEUR", "ETH/EUR", "XETH", "ZEUR")]);
// meerdere geldige keys: elke volgende koppeling krijgt zo een eigen rate-limiter en hoeft niet te wachten
const KRAKEN_KEYS = new Set(["KRAKENKEY0000000", "KRAKENKEY2000000", "KRAKENKEY3000000"]);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const router = (async (input: URL | RequestInfo, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : (input as URL).toString());
  const body = typeof init?.body === "string" ? init.body : "";
  const params = new URLSearchParams(body);
  if (url.hostname === "node.test") return btcNode.fetch(input, init);
  // Kraken
  if (url.hostname === "api.kraken.com") {
    const headers = init?.headers as Record<string, string> | undefined;
    if (url.pathname.startsWith("/0/private/") && !KRAKEN_KEYS.has(headers?.["API-Key"] ?? "")) return json({ error: ["EAPI:Invalid key"], result: null });
    // canonieke sleutel voor een pair-id (sleutel of altname), zoals Ticker/OHLC hem teruggeven
    const canonical = (id: string) => Object.entries(krakenPairs).find(([k, p]) => k === id || p.altname === id)?.[0];
    switch (url.pathname) {
      case "/0/public/Assets":
        return json({ error: [], result: { XXBT: { altname: "XBT" }, XETH: { altname: "ETH" }, SOL: { altname: "SOL" }, ZEUR: { altname: "EUR" }, ZUSD: { altname: "USD" } } });
      case "/0/public/AssetPairs":
        return json({ error: [], result: krakenPairs });
      case "/0/public/Ticker": {
        // minimale geldige payload voor het (fire-and-forget) primen van Kraken-assets
        const keys = (url.searchParams.get("pair") ?? "").split(",").map(canonical).filter((k): k is string => !!k);
        return json({ error: [], result: Object.fromEntries(keys.map((k) => [k, { a: ["50100.0", "1", "1.000"], b: ["50000.0", "1", "1.000"], c: ["50050.0", "0.01000000"], v: ["10", "20"], p: ["50000.0", "50000.0"], t: [10, 20], l: ["49000.0", "48000.0"], h: ["51000.0", "52000.0"], o: "49500.0" }])) });
      }
      case "/0/public/OHLC": {
        const pairId = url.searchParams.get("pair") ?? "";
        const key = canonical(pairId);
        if (!key) return json({ error: ["EQuery:Unknown asset pair"], result: {} });
        // koers op tijdstip (KrakenClient.priceInEur vraagt op altname): dagslot 30 000 EUR per BTC vanaf `since`
        if (pairId === "XBTEUR" && url.searchParams.get("since")) {
          const since = Number(url.searchParams.get("since"));
          const start = since - (since % 86400);
          return json({ error: [], result: { [key]: Array.from({ length: 10 }, (_, i) => [start + i * 86400, "30000.0", "30000.0", "30000.0", "30000.0", "30000.0", "1.0", 1]), last: start } });
        }
        return json({ error: [], result: { [key]: [], last: 0 } });
      }
      case "/0/private/Balance":
        return json({ error: [], result: { XXBT: "0.0100", XETH: "0.1500", ZEUR: "249.5" } }); // ETH: 0,05 meer dan de trades
      case "/0/private/TradesHistory": {
        const start = Number(params.get("start") ?? 0);
        const list = krakenTrades.filter((t) => t.time > start);
        return json({ error: [], result: { count: list.length, trades: Object.fromEntries(list.map(({ id, ...t }) => [id, t])) } });
      }
      case "/0/private/Ledgers":
        return json({ error: [], result: { count: 0, ledger: {} } });
    }
  }
  // eToro
  if (url.hostname === "public-api.etoro.com") {
    const headers = init?.headers as Record<string, string> | undefined;
    if (headers?.["x-api-key"] !== "ETOROKEY") return new Response("unauthorized", { status: 401 });
    if (url.pathname === "/api/v1/trading/info/portfolio") return json({ clientPortfolio: { positions: etoroPositions, mirrors: [] } });
    if (url.pathname === "/api/v1/trading/info/real/pnl") return json({ credit: 1234.5, positions: etoroPositions.map((p) => ({ ...p, unrealizedPnL: { pnL: 10 } })), mirrors: [] });
    if (url.pathname === "/api/v1/market-data/instrument-types") return json({ instrumentTypes: [{ instrumentTypeID: 10, instrumentTypeDescription: "Cryptocurrencies" }, { instrumentTypeID: 5, instrumentTypeDescription: "Stocks" }] });
    if (url.pathname === "/api/v1/market-data/instruments") {
      return json({
        instrumentDisplayDatas: [
          { instrumentID: 100000, instrumentDisplayName: "Bitcoin", instrumentTypeID: 10, symbolFull: "BTC", images: [{ width: 50, uri: "https://x/btc.png" }] },
          { instrumentID: 1001, instrumentDisplayName: "Apple Inc.", instrumentTypeID: 5, symbolFull: "AAPL", images: [] },
          { instrumentID: 2002, instrumentDisplayName: "AMC Preferred Equity", instrumentTypeID: 5, symbolFull: "APE", images: [] },
        ],
      });
    }
    if (url.pathname === "/api/v2/market-data/rates") return json({ results: [] });
    if (url.pathname.includes("/history/candles/")) return json({ candles: [] });
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
    return json({ base: "EUR", date: new Date().toISOString().slice(0, 10), rates: { USD: 1.1, CHF: 0.95, GBP: 0.85 } });
  }
  return new Response("blocked", { status: 403 });
}) as typeof fetch;

beforeAll(() => {
  vi.stubGlobal("fetch", router);
  getDb();
});

describe("sync-orchestrator", () => {
  it("test() met verkeerde Kraken-key geeft een duidelijke fout", async () => {
    const r = await testCredentials({ provider: "kraken", apiKey: "WRONG", apiSecret: "c2VjcmV0" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("ongeldig");
  });

  it("Kraken: eerste sync importeert trades, tweede sync voegt niets toe, afstemming ziet 0,05 ETH verschil", async () => {
    const portfolio = getDb().select().from(schema.portfolios).get()!;
    const conn = createConnection({ provider: "kraken", label: "Kraken hoofd", portfolioId: portfolio.id, accountType: "real", mode: "replace", apiKey: "KRAKENKEY0000000", apiSecret: "c2VjcmV0c2VjcmV0" });
    const r1 = await runSync(conn.id, "initial");
    expect(r1.ok).toBe(true);
    expect(r1.created).toBe(2);
    const r2 = await runSync(conn.id, "manual");
    expect(r2.ok).toBe(true);
    expect(r2.created).toBe(0);
    expect(r2.skipped).toBe(0); // cursor staat na de laatste trade, dus niets opnieuw opgehaald

    const view = computePortfolio(portfolio.id);
    const btc = view.positions.find((p) => p.symbol === "BTC")!;
    expect(btc.platformName).toBe("Kraken");
    expect(btc.quantity).toBe("0.01000000");
    expect(btc.avgCost).toBe("50100.000000"); // (500 + 1 kosten) / 0,01
    expect(btc.currency).toBe("USD"); // crypto-asset in USD genoteerd (koers bepaalt de waarderingsvaluta), transactie in EUR

    // Kraken is de koersbron van het nieuwe asset: canonieke paarsleutel als sourceId, basiscode als provider-id
    const btcAsset = getDb().select().from(schema.assets).all().find((a) => a.symbol === "BTC")!;
    expect(btcAsset.category).toBe("crypto");
    expect(btcAsset.priceSource).toBe("kraken");
    expect(btcAsset.sourceId).toBe("XXBTZEUR");
    expect(JSON.parse(btcAsset.providerIds ?? "{}")).toEqual({ kraken: "XXBT" });
    const ethAsset = getDb().select().from(schema.assets).all().find((a) => a.symbol === "ETH")!;
    expect(ethAsset).toMatchObject({ priceSource: "kraken", sourceId: "XETHZEUR" });

    const diffs = reconcile(getDb().select().from(schema.connections).where(eq(schema.connections.id, conn.id)).get()!);
    expect(diffs.length).toBe(1);
    expect(diffs[0].symbol).toBe("ETH");
    expect(diffs[0].diff).toBe("0.05000000");

    // correctie boeken → verschil weg
    await bookCorrection(conn.id, "ETH");
    const after = reconcile(getDb().select().from(schema.connections).where(eq(schema.connections.id, conn.id)).get()!);
    expect(after.length).toBe(0);

    const list = listConnections();
    expect(list[0].txCount).toBe(2);
    expect(list[0].balances.map((b) => b.currency).sort()).toEqual(["BTC", "ETH", "EUR"]);
    expect(list[0].keys.last4).toBe("0000");
  });

  it("eToro: posities worden aankopen; een verdwenen positie wordt een verkoop; BTC blijft één asset", async () => {
    const portfolio = getDb().select().from(schema.portfolios).get()!;
    const conn = createConnection({ provider: "etoro", label: "eToro", portfolioId: portfolio.id, accountType: "real", mode: "alongside", apiKey: "ETOROKEY", apiSecret: "USERKEY1" });
    const r1 = await runSync(conn.id, "initial");
    expect(r1.ok).toBe(true);
    expect(r1.created).toBe(2);
    const assets = getDb().select().from(schema.assets).all();
    expect(assets.filter((a) => a.symbol === "BTC").length).toBe(1); // zelfde asset als bij Kraken
    const btc = assets.find((a) => a.symbol === "BTC")!;
    expect(btc).toMatchObject({ priceSource: "kraken", sourceId: "XXBTZEUR" }); // bestaande feed blijft: een sync overschrijft geen ingestelde koersbron
    expect(JSON.parse(btc.providerIds ?? "{}")).toMatchObject({ etoro: "100000", kraken: "XXBT" });
    const aapl = assets.find((a) => a.symbol === "AAPL")!;
    expect(aapl.category).toBe("stock");
    expect(aapl.name).toBe("Apple Inc.");

    const view = computePortfolio(portfolio.id);
    const etoroBtc = view.positions.find((p) => p.symbol === "BTC" && p.platformName === "eToro")!;
    expect(etoroBtc.quantity).toBe("0.10000000");
    expect(etoroBtc.avgCost).toBe("60000.000000");
    const list = listConnections().find((c) => c.id === conn.id)!;
    expect(list.balances[0]).toMatchObject({ currency: "USD", amount: "1234.50" });

    // positie P2 (AAPL) wordt gesloten
    etoroPositions = etoroPositions.filter((p) => p.positionId !== "P2");
    const r2 = await runSync(conn.id, "manual");
    expect(r2.created).toBe(1);
    const sells = getDb().select().from(schema.transactions).all().filter((t) => t.type === "sell" && t.externalId === "etoro:close:P2");
    expect(sells.length).toBe(1);
    expect(sells[0].quantity).toBe("10.00000000");
    const view2 = computePortfolio(portfolio.id);
    expect(view2.positions.find((p) => p.symbol === "AAPL" && Number(p.quantity) > 0)).toBeUndefined();

    deleteConnection(conn.id, true);
    expect(getDb().select().from(schema.transactions).all().filter((t) => t.externalId?.startsWith("etoro:")).length).toBe(0);
  });

  it("koersbron: een ingestelde feed (Yahoo, Kraken) wordt niet overschreven en houdt zijn paar; alleen handmatig → Kraken", async () => {
    const portfolio = getDb().select().from(schema.portfolios).get()!;
    // SOL bestaat al met Yahoo als bron (door de gebruiker gekozen); ADA bestaat zonder koersfeed
    upsertAsset({ symbol: "SOL", name: "Solana", category: "crypto", currency: "USD", priceSource: "yahoo", sourceId: "SOL-EUR" });
    upsertAsset({ symbol: "ADA", name: "Cardano", category: "crypto", currency: "USD", priceSource: "manual" });
    // Kraken biedt ETH nu alleen nog in USD aan en SOL/ADA in EUR; het ETH-asset moet zijn bestaande EUR-paar houden
    krakenPairs = Object.fromEntries([krakenPair("XXBTZEUR", "XBTEUR", "XBT/EUR", "XXBT", "ZEUR"), krakenPair("XETHZUSD", "ETHUSD", "ETH/USD", "XETH", "ZUSD"), krakenPair("SOLEUR", "SOLEUR", "SOL/EUR", "SOL", "ZEUR"), krakenPair("ADAEUR", "ADAEUR", "ADA/EUR", "ADA", "ZEUR")]);
    krakenTrades.push(
      { id: "TCCCCC-CCCCC-CCCCCC", ordertxid: "O3", pair: "XXBTZEUR", time: 1760007200, type: "buy", ordertype: "market", price: "51000.0", cost: "510.0", fee: "1.0", vol: "0.01", margin: "0", misc: "" },
      { id: "TDDDDD-DDDDD-DDDDDD", ordertxid: "O4", pair: "XETHZEUR", time: 1760010800, type: "buy", ordertype: "limit", price: "2600.0", cost: "260.0", fee: "0.5", vol: "0.1", margin: "0", misc: "" },
      { id: "TEEEEE-EEEEE-EEEEEE", ordertxid: "O5", pair: "SOLEUR", time: 1760014400, type: "buy", ordertype: "market", price: "100.0", cost: "100.0", fee: "0.2", vol: "1.0", margin: "0", misc: "" },
      { id: "TFFFFF-FFFFF-FFFFFF", ordertxid: "O6", pair: "ADAEUR", time: 1760018000, type: "buy", ordertype: "market", price: "0.5", cost: "50.0", fee: "0.1", vol: "100.0", margin: "0", misc: "" },
    );
    const conn = createConnection({ provider: "kraken", label: "Kraken 2", portfolioId: portfolio.id, accountType: "real", mode: "alongside", apiKey: "KRAKENKEY2000000", apiSecret: "c2VjcmV0c2VjcmV0" });
    const r = await runSync(conn.id, "initial");
    expect(r.ok).toBe(true);
    expect(r.created).toBe(4);
    expect(r.skipped).toBe(2); // de twee trades van de eerste koppeling zijn al bekend

    const assets = getDb().select().from(schema.assets).all();
    expect(assets.map((a) => a.symbol).sort()).toEqual(["AAPL", "ADA", "BTC", "ETH", "SOL"]); // geen nieuwe assets: alles aan bestaande gekoppeld
    const btc = assets.find((a) => a.symbol === "BTC")!;
    expect(btc).toMatchObject({ priceSource: "kraken", sourceId: "XXBTZEUR" }); // eToro-sync heeft Kraken niet overschreven; nieuwe trades wisselen ook niet van paar
    const eth = assets.find((a) => a.symbol === "ETH")!;
    expect(eth).toMatchObject({ priceSource: "kraken", sourceId: "XETHZEUR" }); // niet gewisseld naar XETHZUSD
    expect(JSON.parse(eth.providerIds ?? "{}")).toEqual({ kraken: "XETH" });
    const sol = assets.find((a) => a.symbol === "SOL")!;
    expect(assets.filter((a) => a.symbol === "SOL").length).toBe(1);
    expect(sol).toMatchObject({ priceSource: "yahoo", sourceId: "SOL-EUR", currency: "USD" }); // door de gebruiker gekozen bron blijft staan (geen stille terugval naar Kraken)
    expect(JSON.parse(sol.providerIds ?? "{}")).toEqual({ kraken: "SOL" }); // provider-id wordt wél vastgelegd
    const ada = assets.find((a) => a.symbol === "ADA")!;
    expect(ada).toMatchObject({ priceSource: "kraken", sourceId: "ADAEUR", currency: "USD" }); // zonder feed: de sync vult Kraken in
    expect(JSON.parse(ada.providerIds ?? "{}")).toEqual({ kraken: "ADA" });
  });

  it("categoriegrens: een Kraken-trade in de munt AMP boekt niet op het aandeel AMP/USD en laat die rij ongemoeid", async () => {
    const portfolio = getDb().select().from(schema.portfolios).get()!;
    // het aandeel Ameriprise (eToro-feed) bestaat al op symbool+valuta AMP/USD; Kraken biedt de munt AMP in EUR aan
    const stock = upsertAsset({ symbol: "AMP", name: "Ameriprise Financial", category: "stock", currency: "USD", priceSource: "etoro", sourceId: "5555" });
    krakenPairs = { ...krakenPairs, ...Object.fromEntries([krakenPair("AMPEUR", "AMPEUR", "AMP/EUR", "AMP", "ZEUR")]) };
    krakenTrades.push({ id: "TGGGGG-GGGGG-GGGGGG", ordertxid: "O7", pair: "AMPEUR", time: 1760021600, type: "buy", ordertype: "market", price: "0.004", cost: "40.0", fee: "0.1", vol: "10000.0", margin: "0", misc: "" });
    const conn = createConnection({ provider: "kraken", label: "Kraken 3", portfolioId: portfolio.id, accountType: "real", mode: "alongside", apiKey: "KRAKENKEY3000000", apiSecret: "c2VjcmV0c2VjcmV0" });
    const r = await runSync(conn.id, "initial");
    expect(r.ok).toBe(true);
    expect(r.created).toBe(0);
    expect(r.skipped).toBe(7); // zes bekende trades + de AMP-trade
    // de nep-Kraken geeft geen grootboek terug; dat levert één samenvattende waarschuwing op naast de categoriegrens
    expect(r.warnings.filter((w) => !w.includes("zonder grootboekregels"))).toEqual([
      "Transactie kraken:trade:TGGGGG-GGGGG-GGGGGG (AMP) overgeslagen: Er bestaat al een asset AMP/USD in de categorie Aandelen; kies een ander symbool of bewerk dat asset.",
    ]);
    // geen upsert: de aandelenrij is niet van categorie, bron, naam of provider-id gewisseld en er is geen tweede AMP
    const rows = getDb().select().from(schema.assets).all().filter((a) => a.symbol === "AMP");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: stock.id, name: "Ameriprise Financial", category: "stock", currency: "USD", priceSource: "etoro", sourceId: "5555", providerIds: null });
    expect(getDb().select().from(schema.transactions).all().filter((t) => t.assetId === stock.id)).toHaveLength(0);
    deleteConnection(conn.id, true);
  });

  it("categoriegrens: een eToro-aandeelpositie APE boekt niet op de munt APE/USD (Kraken-feed) en schrijft er geen provider-id op", async () => {
    const portfolio = getDb().select().from(schema.portfolios).get()!;
    const coin = upsertAsset({ symbol: "APE", name: "ApeCoin", category: "crypto", currency: "USD", priceSource: "kraken", sourceId: "APEEUR" });
    etoroPositions.push({ positionId: "P3", instrumentId: 2002, openRate: 3.5, units: 100, amount: 350, openDateTime: "2026-04-01T09:30:00Z", isBuy: true, leverage: 1 });
    const conn = createConnection({ provider: "etoro", label: "eToro 2", portfolioId: portfolio.id, accountType: "real", mode: "alongside", apiKey: "ETOROKEY", apiSecret: "USERKEY1" });
    const r = await runSync(conn.id, "initial");
    expect(r.ok).toBe(true);
    expect(r.created).toBe(1); // P1 (BTC) opnieuw: de eerdere eToro-koppeling is mét transacties verwijderd
    expect(r.skipped).toBe(1);
    expect(r.warnings).toEqual(["Transactie etoro:pos:P3 (APE) overgeslagen: Er bestaat al een asset APE/USD in de categorie Crypto; kies een ander symbool of bewerk dat asset."]);
    // de waarschuwingen blijven bij de run bewaard, zodat het platformdetail ze ook na herladen toont
    expect(listConnections().find((c) => c.id === conn.id)?.lastRun?.warnings).toEqual(r.warnings);
    const rows = getDb().select().from(schema.assets).all().filter((a) => a.symbol === "APE");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: coin.id, name: "ApeCoin", category: "crypto", currency: "USD", priceSource: "kraken", sourceId: "APEEUR", providerIds: null });
    expect(getDb().select().from(schema.transactions).all().filter((t) => t.assetId === coin.id)).toHaveLength(0);
    const view = computePortfolio(portfolio.id);
    expect(view.positions.some((p) => p.symbol === "APE")).toBe(false); // geen 100 "aandelen" tegen de munt-koers
    deleteConnection(conn.id, true);
  });

  it("Bitcoin-wallet: xpub-koppeling boekt netto per koppeling, saldo en accounts kloppen, uitzetten wist de boekingen, verwijderen wist de secrets", async () => {
    const portfolio = getDb().select().from(schema.portfolios).get()!;
    setSetting("bitcoinApiUrl", "http://node.test:3006/");
    const dz = makeAddressDeriver(parseExtendedPublicKey(ZPUB).key, "p2wpkh");
    const T = 1700000000; // 2023-11-14
    btcNode.tip = 800000;
    btcNode.addTx({ txid: "rx1", inputs: [{ address: "1ext", value: 150000 }], outputs: [{ address: dz(0, 0), value: 100000 }, { address: "1ext2", value: 49000 }], height: 799990, time: T });
    btcNode.addTx({ txid: "sp1", inputs: [{ address: dz(0, 0), value: 100000 }], outputs: [{ address: "1ext3", value: 60000 }, { address: dz(1, 0), value: 39000 }], height: 799992, time: T + 1200 });
    btcNode.addTx({ txid: "mem1", inputs: [{ address: "1ext", value: 60000 }], outputs: [{ address: dz(0, 1), value: 50000 }], height: null });

    // ongeldige of ontbrekende accounts: niets aangemaakt
    const before = getDb().select().from(schema.connections).all().length;
    expect(() => createConnection({ provider: "bitcoin", label: "Fout", portfolioId: portfolio.id, accounts: [{ xpub: "x".repeat(110), scriptType: "p2wpkh", label: "A" }] })).toThrow(/Geen geldige/);
    expect(() => createConnection({ provider: "bitcoin", label: "Fout", portfolioId: portfolio.id })).toThrow(/minstens één account/);
    expect(getDb().select().from(schema.connections).all().length).toBe(before);
    expect(getDb().select().from(schema.platforms).all().some((p) => p.name === "Fout")).toBe(false);

    const feesBefore = computePortfolio(portfolio.id).totals.fees.EUR;
    const conn = createConnection({ provider: "bitcoin", label: "Ledger", portfolioId: portfolio.id, mode: "replace", accounts: [{ xpub: ZPUB, scriptType: "p2wpkh", label: "Bitcoin 1" }] });
    const platform = getDb().select().from(schema.platforms).where(eq(schema.platforms.id, conn.platformId)).get()!;
    expect(platform).toMatchObject({ name: "Ledger", type: "wallet" }); // eigen platform per wallet
    const accounts = listWalletAccounts(conn.id);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ label: "Bitcoin 1", scriptType: "p2wpkh", enabled: true });
    expect(getSecret(`wallet:${accounts[0].id}:xpub`)).toBe(ZPUB); // versleuteld opgeslagen, niet in de tabel
    expect(JSON.stringify(accounts)).not.toContain("zpub6");

    const r1 = await runSync(conn.id, "initial");
    expect(r1.ok).toBe(true);
    expect(r1.warnings).toEqual([]);
    expect(r1.created).toBe(3); // ontvangst, verzending, minerfee
    expect(r1.reconciliation).toEqual([]);
    const view = computePortfolio(portfolio.id);
    const pos = view.positions.find((p) => p.symbol === "BTC" && p.platformName === "Ledger")!;
    expect(pos.quantity).toBe("0.00039000");
    expect(pos.avgCost).toBe("30000.000000"); // ontvangst tegen de dagkoers; verzending tegen boekwaarde
    expect(pos.costCurrency).toBe("EUR");
    expect((Number(view.totals.fees.EUR) - Number(feesBefore)).toFixed(2)).toBe("0.30"); // minerfee 1 000 sat × 30 000 EUR
    const txs = getDb().select().from(schema.transactions).all().filter((t) => t.externalId?.startsWith(`btc:${conn.id}:`));
    expect(txs.map((t) => t.type)).toEqual(["transfer_in", "transfer_out", "fee"]);
    expect(txs.find((t) => t.type === "fee")).toMatchObject({ assetId: null, price: "0.30000000", currency: "EUR", source: "api", platformId: conn.platformId });
    expect(txs.every((t) => !t.note?.includes("bc1"))).toBe(true);

    const row = listConnections().find((c) => c.id === conn.id)!;
    expect(row.keys).toEqual({ shared: false, present: true, last4: null, updatedAt: null });
    expect(row.balances).toEqual([expect.objectContaining({ currency: "BTC", amount: "0.00039000", hold: "0.00050000" })]); // mempool-ontvangst in afwachting
    expect(row.accounts[0]).toMatchObject({ label: "Bitcoin 1", receiveUsed: 2, changeUsed: 1, txCount: 3, balanceConfirmed: "0.00039000", balanceUnconfirmed: "0.00050000" }); // txCount telt ook de mempool-ontvangst
    expect(row.txCount).toBe(3);
    expect(JSON.parse(getDb().select().from(schema.connections).where(eq(schema.connections.id, conn.id)).get()!.cursor!)).toEqual({ tipHeight: 800000, syncedAt: expect.any(String), source: "own" });

    // tweede sync (interval): niets nieuws, geen verschil
    const r2 = await runSync(conn.id, "interval");
    expect(r2.ok).toBe(true);
    expect(r2.created).toBe(0);
    expect(r2.reconciliation).toEqual([]);

    // account uit → boekingen en saldo weg; weer aan → alles opnieuw geboekt
    expect(updateWalletAccount(conn.id, accounts[0].id, { enabled: false }).enabledChanged).toBe(true);
    expect(resetWalletBookings(conn.id)).toBe(3);
    expect(getDb().select().from(schema.transactions).all().filter((t) => t.externalId?.startsWith(`btc:${conn.id}:`))).toHaveLength(0);
    const r3 = await runSync(conn.id, "manual");
    expect(r3.ok).toBe(true);
    expect(r3.created).toBe(0);
    expect(r3.warnings[0]).toContain("Geen ingeschakelde");
    updateWalletAccount(conn.id, accounts[0].id, { enabled: true, label: "Ledger hoofd" });
    const r4 = await runSync(conn.id, "manual");
    expect(r4.created).toBe(3);
    expect(r4.reconciliation).toEqual([]);
    expect(getDb().select().from(schema.transactions).all().find((t) => t.externalId === `btc:${conn.id}:rx1`)!.note).toContain("Ledger hoofd");

    deleteConnection(conn.id, true);
    expect(getSecret(`wallet:${accounts[0].id}:xpub`)).toBeNull();
    expect(getDb().select().from(schema.walletAccounts).all().filter((a) => a.connectionId === conn.id)).toHaveLength(0);
    expect(getDb().select().from(schema.transactions).all().filter((t) => t.externalId?.startsWith(`btc:${conn.id}:`))).toHaveLength(0);
  });

  it("Bitcoin-wallet zonder ingestelde node-URL: test en sync geven een duidelijke melding", async () => {
    setSetting("bitcoinApiUrl", "");
    const t = await testCredentials({ provider: "bitcoin" });
    expect(t.ok).toBe(false);
    expect(t.message).toContain("Geen Bitcoin-node ingesteld");
    const portfolio = getDb().select().from(schema.portfolios).get()!;
    const conn = createConnection({ provider: "bitcoin", label: "Trezor", portfolioId: portfolio.id, accounts: [{ xpub: ZPUB, scriptType: "p2wpkh", label: "Bitcoin 1" }] });
    const r = await runSync(conn.id, "initial");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Geen Bitcoin-node ingesteld");
    deleteConnection(conn.id, true);
  });
});
