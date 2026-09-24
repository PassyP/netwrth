import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-repair-"));

import { getDb, schema } from "./index";
import { removeUnusedSeedWallet, repairYahooCryptoSymbols } from "./repair";
import { parseCryptoTicker, stripQuoteFromName } from "../prices/yahoo";

describe("Yahoo-crypto-tickers", () => {
  it("parseCryptoTicker leest munt en valuta; stripQuoteFromName haalt de valuta uit de naam", () => {
    expect(parseCryptoTicker("BTC-USD")).toEqual({ base: "BTC", quote: "USD" });
    expect(parseCryptoTicker("eth-eur")).toEqual({ base: "ETH", quote: "EUR" });
    expect(parseCryptoTicker("1INCH-USDT")).toEqual({ base: "1INCH", quote: "USDT" });
    expect(parseCryptoTicker("BTC")).toBeNull();
    expect(parseCryptoTicker("BRK-B")).toBeNull(); // aandelenklasse, geen valuta
    expect(parseCryptoTicker("VWRL.L")).toBeNull();
    expect(stripQuoteFromName("Bitcoin USD", "USD")).toBe("Bitcoin");
    expect(stripQuoteFromName("Bitcoin", "USD")).toBe("Bitcoin");
    expect(stripQuoteFromName("USD", "USD")).toBe("USD"); // nooit een lege naam
  });
});

describe("repairYahooCryptoSymbols", () => {
  it("voegt BTC-USD samen met het bestaande BTC (transacties, alert en ontbrekende koersdagen mee; feed van het doel blijft) en hernoemt ETH-EUR zonder tweeling", () => {
    const db = getDb();
    const now = "2026-09-22T10:00:00.000Z";
    const portfolio = db.select().from(schema.portfolios).get()!;
    const ledger = db.insert(schema.platforms).values({ name: "Ledger", type: "wallet" }).returning().get(); // eigen wallet
    const krakenPlatform = db.insert(schema.platforms).values({ name: "Kraken", type: "exchange" }).returning().get();
    const asset = (v: Partial<typeof schema.assets.$inferInsert> & Pick<typeof schema.assets.$inferInsert, "symbol" | "name" | "category" | "currency">) =>
      db.insert(schema.assets).values({ priceSource: "manual", createdAt: now, ...v }).returning().get();
    // zoals de Kraken-sync ze aanmaakt: naam = symbool, koers via Kraken in EUR, provider-id
    const btc = asset({ symbol: "BTC", name: "BTC", category: "crypto", currency: "EUR", priceSource: "kraken", sourceId: "XXBTZEUR", providerIds: JSON.stringify({ kraken: "XXBT" }) });
    // zoals de oude zoekresultaten het aanmaakten: Yahoo-ticker als symbool
    const btcUsd = asset({ symbol: "BTC-USD", name: "Bitcoin USD", category: "crypto", currency: "USD", priceSource: "yahoo", sourceId: "BTC-USD", logoUrl: "https://x/btc.png", providerIds: JSON.stringify({ etoro: "100000" }) });
    const ethEur = asset({ symbol: "ETH-EUR", name: "Ethereum EUR", category: "crypto", currency: "USD", priceSource: "yahoo", sourceId: "ETH-EUR" });
    const brk = asset({ symbol: "BRK-B", name: "Berkshire Hathaway", category: "stock", currency: "USD", priceSource: "yahoo", sourceId: "BRK-B" });
    const tx = (assetId: number, platformId: number, source: string) =>
      db.insert(schema.transactions).values({ portfolioId: portfolio.id, assetId, platformId, type: "buy", quantity: "1", price: "50000", currency: "EUR", executedAt: now, source, createdAt: now }).returning().get();
    const ledgerTx = tx(btcUsd.id, ledger.id, "manual");
    const krakenTx = tx(btc.id, krakenPlatform.id, "api");
    const alert = db.insert(schema.alerts).values({ assetId: btcUsd.id, condition: "above", threshold: "100000", currency: "USD", createdAt: now }).returning().get();
    db.insert(schema.priceQuotes)
      .values([
        { assetId: btc.id, ts: "2026-09-21T21:00:00.000Z", day: "2026-09-21", price: "60000", currency: "EUR", source: "kraken" },
        { assetId: btcUsd.id, ts: "2026-09-21T21:00:00.000Z", day: "2026-09-21", price: "70000", currency: "USD", source: "yahoo" }, // dag die het doel al heeft
        { assetId: btcUsd.id, ts: "2026-09-20T21:00:00.000Z", day: "2026-09-20", price: "69000", currency: "USD", source: "yahoo" }, // dag die het doel mist
      ])
      .run();

    const report = repairYahooCryptoSymbols(db);
    expect(report).toEqual({ merged: [`BTC-USD → BTC (#${btc.id})`], renamed: ["ETH-EUR → ETH"], skipped: [] });

    const assets = db.select().from(schema.assets).all();
    expect(assets.map((a) => a.symbol).sort()).toEqual(["BRK-B", "BTC", "ETH"]);
    // het doel houdt zijn feed, valuta en Kraken-id; neemt naam, logo en het eToro-id over
    const merged = assets.find((a) => a.id === btc.id)!;
    expect(merged).toMatchObject({ symbol: "BTC", name: "Bitcoin", currency: "EUR", priceSource: "kraken", sourceId: "XXBTZEUR", logoUrl: "https://x/btc.png" });
    expect(JSON.parse(merged.providerIds!)).toEqual({ etoro: "100000", kraken: "XXBT" });
    // transacties en alert staan op het doel; de Ledger-transactie houdt zijn platform
    const txs = db.select().from(schema.transactions).all();
    expect(txs.map((t) => [t.id, t.assetId, t.platformId])).toEqual([
      [ledgerTx.id, btc.id, ledger.id],
      [krakenTx.id, btc.id, krakenPlatform.id],
    ]);
    expect(db.select().from(schema.alerts).where(eq(schema.alerts.id, alert.id)).get()).toMatchObject({ assetId: btc.id });
    // koersen: de Kraken-dag blijft, de ontbrekende Yahoo-dag komt erbij, de dubbele dag is weg
    const quotes = db.select().from(schema.priceQuotes).all().sort((a, b) => (a.day < b.day ? -1 : 1));
    expect(quotes.map((q) => [q.assetId, q.day, q.price, q.source])).toEqual([
      [btc.id, "2026-09-20", "69000", "yahoo"],
      [btc.id, "2026-09-21", "60000", "kraken"],
    ]);
    // zonder tweeling: alleen hernoemd, ticker blijft bron-id
    expect(assets.find((a) => a.id === ethEur.id)).toMatchObject({ symbol: "ETH", name: "Ethereum", priceSource: "yahoo", sourceId: "ETH-EUR" });
    expect(assets.find((a) => a.id === brk.id)).toMatchObject({ symbol: "BRK-B", name: "Berkshire Hathaway" });
    // idempotent
    expect(repairYahooCryptoSymbols(db)).toEqual({ merged: [], renamed: [], skipped: [] });
  });

  it("vult een ontbrekende koersbron van het doel in en slaat een hernoeming over die op een aandeel met dat symbool zou botsen", () => {
    const db = getDb();
    const now = "2026-09-22T10:00:00.000Z";
    const asset = (v: Partial<typeof schema.assets.$inferInsert> & Pick<typeof schema.assets.$inferInsert, "symbol" | "name" | "category" | "currency">) =>
      db.insert(schema.assets).values({ priceSource: "manual", createdAt: now, ...v }).returning().get();
    const sol = asset({ symbol: "SOL", name: "Solana", category: "crypto", currency: "EUR" }); // uit een CSV-import, zonder feed
    asset({ symbol: "SOL-USD", name: "Solana USD", category: "crypto", currency: "USD", priceSource: "yahoo", sourceId: "SOL-USD" });
    asset({ symbol: "LINK", name: "Interlink Electronics", category: "stock", currency: "USD", priceSource: "yahoo", sourceId: "LINK" });
    const linkUsd = asset({ symbol: "LINK-USD", name: "Chainlink USD", category: "crypto", currency: "USD", priceSource: "yahoo", sourceId: "LINK-USD" });

    const report = repairYahooCryptoSymbols(db);
    expect(report.merged).toEqual([`SOL-USD → SOL (#${sol.id})`]);
    expect(report.renamed).toEqual([]);
    expect(report.skipped).toEqual([`LINK-USD: LINK/USD bestaat al als stock (#${linkUsd.id - 1})`]);
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, sol.id)).get()).toMatchObject({ symbol: "SOL", name: "Solana", currency: "EUR", priceSource: "yahoo", sourceId: "SOL-USD" });
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, linkUsd.id)).get()).toMatchObject({ symbol: "LINK-USD" }); // ongemoeid
  });
});

describe("removeUnusedSeedWallet", () => {
  it("wordt niet meer meegeleverd en verdwijnt uit oude databases zolang er niets aan hangt", () => {
    const db = getDb();
    const now = "2026-09-22T10:00:00.000Z";
    expect(db.select().from(schema.platforms).all().map((p) => p.name).sort()).toEqual(["Kraken", "Ledger", "Swissquote", "eToro"]);
    const seeded = db.insert(schema.platforms).values({ name: "Fysiek", type: "other" }).returning().get();
    expect(removeUnusedSeedWallet(db)).toBe(true);
    expect(db.select().from(schema.platforms).where(eq(schema.platforms.id, seeded.id)).get()).toBeUndefined();
    expect(removeUnusedSeedWallet(db)).toBe(false); // idempotent
    // met een transactie eraan is het gebruikersdata en blijft het staan
    const used = db.insert(schema.platforms).values({ name: "Fysiek", type: "other" }).returning().get();
    const portfolio = db.select().from(schema.portfolios).get()!;
    const asset = db.insert(schema.assets).values({ symbol: "GOUD", name: "Goud", category: "commodity", currency: "EUR", priceSource: "manual", createdAt: now }).returning().get();
    db.insert(schema.transactions).values({ portfolioId: portfolio.id, assetId: asset.id, platformId: used.id, type: "buy", quantity: "1", price: "2000", currency: "EUR", executedAt: now, source: "manual", createdAt: now }).run();
    expect(removeUnusedSeedWallet(db)).toBe(false);
    expect(db.select().from(schema.platforms).where(eq(schema.platforms.id, used.id)).get()).toMatchObject({ name: "Fysiek" });
    // een zelf aangemaakte wallet die toevallig "Fysiek" heet (type "wallet") wordt nooit aangeraakt
    db.delete(schema.transactions).where(eq(schema.transactions.platformId, used.id)).run();
    db.update(schema.platforms).set({ type: "wallet" }).where(eq(schema.platforms.id, used.id)).run();
    expect(removeUnusedSeedWallet(db)).toBe(false);
    expect(db.select().from(schema.platforms).where(eq(schema.platforms.id, used.id)).get()).toMatchObject({ name: "Fysiek", type: "wallet" });
  });
});
