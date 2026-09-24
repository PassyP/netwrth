import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-btc-"));

import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { computePortfolio } from "./portfolio";
import { computeHistory } from "./history";
import { setManualPrice, upsertAsset } from "./assets";
import { createTransaction } from "./transactions";
import { processTransactions, type EngineTx } from "./calc/engine";

// BTC als weergavevaluta: kostprijs tegen de BTC-koers van de aankoopdag, waarde tegen die van vandaag.
// Aankoop 10 × €100 toen 1 BTC = €40.000 (0,025 BTC); nu €150 per stuk en 1 BTC = €80.000 (0,01875 BTC).
beforeAll(() => {
  const db = getDb();
  for (const date of ["2026-01-10", "2026-09-01"]) db.insert(schema.fxRates).values({ date, currency: "USD", ratePerEur: "1.1" }).run();
  db.insert(schema.fxRates).values({ date: "2026-01-10", currency: "BTC", ratePerEur: "0.000025", source: "Yahoo" }).run();
  db.insert(schema.fxRates).values({ date: "2026-09-01", currency: "BTC", ratePerEur: "0.0000125", source: "Yahoo" }).run();
});

describe("weergave in BTC", () => {
  it("engine: kostprijs en resultaat in BTC tegen de koers op de transactiedatum", () => {
    const txs: EngineTx[] = [
      { id: 1, type: "buy", quantity: "1", price: "40000", fee: "0", currency: "EUR", executedAt: "2026-01-10T10:00:00Z", fxEur: "1", fxUsd: "1.1", fxBtc: "0.000025" },
      { id: 2, type: "sell", quantity: "0.5", price: "80000", fee: "0", currency: "EUR", executedAt: "2026-09-01T10:00:00Z", fxEur: "1", fxUsd: "1.1", fxBtc: "0.0000125" },
    ];
    const r = processTransactions(txs, "average");
    expect(r.costBtc.toFixed(8)).toBe("0.50000000");
    expect(r.totalBuyCostBtc.toFixed(8)).toBe("1.00000000");
    // €40.000 opbrengst = 0,5 BTC; kostprijs 0,5 BTC → in BTC geen winst, in euro wel
    expect(r.realizedPnlBtc.toFixed(8)).toBe("0.00000000");
    expect(r.realizedPnlEur.toFixed(2)).toBe("20000.00");
  });

  it("portfolio en historie: rendement in BTC wijkt af van dat in euro", async () => {
    const db = getDb();
    const portfolio = db.select().from(schema.portfolios).get()!;
    const platform = db.insert(schema.platforms).values({ name: "Broker", type: "broker" }).returning().get();
    const etf = upsertAsset({ symbol: "ETFX", name: "Test-ETF", category: "etf", currency: "EUR", priceSource: "manual" });
    await createTransaction({ portfolioId: portfolio.id, assetId: etf.id, platformId: platform.id, type: "buy", quantity: "10", price: "100", currency: "EUR", fee: "0", executedAt: "2026-01-10T10:00:00Z", source: "manual" });
    setManualPrice(etf.id, "150", "EUR", "2026-09-01");

    const view = computePortfolio(portfolio.id);
    expect(view.fxMissing).toEqual([]);
    const pos = view.positions.find((p) => p.symbol === "ETFX")!;
    expect(pos.value).toEqual({ EUR: "1500.00", USD: "1650.00", BTC: "0.01875000" });
    expect(pos.cost.BTC).toBe("0.02500000");
    expect(pos.unrealized.BTC).toBe("-0.00625000");
    expect(pos.unrealizedPct).toMatchObject({ EUR: "50.00", BTC: "-25.00" });
    expect(view.totals.returnPct.BTC).toBe("-25.00");

    const hist = computeHistory(portfolio.id);
    expect(hist[0]).toMatchObject({ date: "2026-01-10", value: { BTC: "0.02500000" }, invested: { BTC: "0.02500000" } });
    expect(hist.find((p) => p.date === "2026-09-01")).toMatchObject({ value: { EUR: "1500.00", BTC: "0.01875000" }, invested: { BTC: "0.02500000" } });
  });

  it("de munt bitcoin telt 1:1, ook als de koers in dollars staat", async () => {
    const db = getDb();
    const portfolio = db.select().from(schema.portfolios).get()!;
    const platform = db.select().from(schema.platforms).where(eq(schema.platforms.name, "Broker")).get()!;
    const btc = upsertAsset({ symbol: "BTC", name: "Bitcoin", category: "crypto", currency: "USD", priceSource: "manual" });
    await createTransaction({ portfolioId: portfolio.id, assetId: btc.id, platformId: platform.id, type: "buy", quantity: "0.1", price: "30000", currency: "USD", fee: "0", executedAt: "2026-01-10T10:00:00Z", source: "manual" });
    setManualPrice(btc.id, "95000", "USD", "2026-09-01"); // ≠ 80.000 EUR × 1,1: de omweg zou geen 0,1 opleveren
    const pos = computePortfolio(portfolio.id).positions.find((p) => p.symbol === "BTC")!;
    expect(pos.value.BTC).toBe("0.10000000");
    expect(computeHistory(portfolio.id).find((p) => p.date === "2026-09-01")!.value.BTC).toBe("0.11875000"); // 0,1 BTC + 0,01875 BTC aan ETF
  });
});
