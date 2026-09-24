import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-test-"));

import { getDb, schema } from "./db";
import { parseSpreadsheet, detectProfile, swissquotePositionsToDrafts, commitImport, dateFromFilename } from "./importers";
import { computePortfolio } from "./portfolio";
import { computeHistory } from "./history";
import { setManualPrice, upsertAsset, addValuation } from "./assets";
import { createTransaction } from "./transactions";
import { setSecret, getSecret, maskSecret } from "./secrets";

const FILE = path.resolve(__dirname, "../../test-data/Positions_0000000_2026_01_15_09_30.xlsx");
// zelfde export zonder ISIN-kolom (komt zo uit Swissquote bij een portefeuille zonder ISIN's), mét subtotaalregel
const FILE_NO_ISIN = path.resolve(__dirname, "../../test-data/Positions_0000001_2026_02_03_14_45.xlsx");

beforeAll(() => {
  const db = getDb();
  // ECB-koersen (offline in de test): 1 EUR = 1.1 USD, 0.95 CHF (vaste testkoersen)
  for (const date of ["2026-01-14", "2026-01-15"]) {
    db.insert(schema.fxRates).values({ date, currency: "USD", ratePerEur: "1.1" }).run();
    db.insert(schema.fxRates).values({ date, currency: "CHF", ratePerEur: "0.95" }).run();
  }
});

describe("Swissquote-positie-export", () => {
  it("wordt herkend en levert drie aankooptransacties", () => {
    const sheet = parseSpreadsheet(fs.readFileSync(FILE), path.basename(FILE));
    expect(detectProfile(sheet.headers)).toBe("swissquote-positions");
    const drafts = swissquotePositionsToDrafts(sheet, path.basename(FILE));
    expect(drafts.map((d) => d.symbol)).toEqual(["EQQQ", "VUSA", "VWRL"]);
    expect(drafts[2].quantity).toBe("10");
    expect(drafts[2].price).toBe("110.45");
    expect(drafts[2].isin).toBe("IE00B3RBWM25");
    expect(drafts.every((d) => d.category === "etf" && d.currency === "USD")).toBe(true);
    expect(dateFromFilename(path.basename(FILE))).toBe("2026-01-15T08:30:00.000Z");
  });

  it("wordt ook zonder ISIN-kolom herkend; sectie- en subtotaalregels tellen niet mee", () => {
    const sheet = parseSpreadsheet(fs.readFileSync(FILE_NO_ISIN), path.basename(FILE_NO_ISIN));
    expect(sheet.headers).not.toContain("ISIN");
    // zonder herkenning valt dit bestand terug op de generieke mapping: die kent de datum uit de bestandsnaam niet
    // en houdt "Shares subtotal in EUR" en "Total" voor posities
    expect(detectProfile(sheet.headers)).toBe("swissquote-positions");
    const drafts = swissquotePositionsToDrafts(sheet, path.basename(FILE_NO_ISIN));
    expect(drafts.map((d) => d.symbol)).toEqual(["AAPL", "ASML"]);
    expect(drafts.every((d) => d.warning === null && d.isin === null)).toBe(true);
    expect(drafts[0]).toMatchObject({ quantity: "12.5", price: "100.25", currency: "USD", category: "stock" }); // sectie "Shares"
    expect(drafts[1]).toMatchObject({ currency: "EUR", category: "stock" });
    expect(drafts[0].executedAt).toBe("2026-02-03T13:45:00.000Z"); // 14:45 lokale tijd uit de bestandsnaam
    expect(drafts[0].externalId).toBe("sq-pos:AAPL:2026-02-03"); // zonder ISIN valt het op het symbool terug
  });

  it("importeert zonder dubbele regels en berekent het portfolio", async () => {
    const sheet = parseSpreadsheet(fs.readFileSync(FILE), path.basename(FILE));
    const drafts = swissquotePositionsToDrafts(sheet, path.basename(FILE));
    const db = getDb();
    const portfolio = db.select().from(schema.portfolios).get()!;
    const swissquote = db.select().from(schema.platforms).all().find((p) => p.name === "Swissquote")!;
    const r1 = await commitImport(drafts, { portfolioId: portfolio.id, platformId: swissquote.id, yahooSuffix: ".L", priceSource: "manual" });
    expect(r1.created).toBe(3);
    expect(r1.newAssets.sort()).toEqual(["EQQQ", "VUSA", "VWRL"]);
    // tweede import van hetzelfde bestand voegt niets toe
    const drafts2 = swissquotePositionsToDrafts(sheet, path.basename(FILE));
    const r2 = await commitImport(drafts2, { portfolioId: portfolio.id, platformId: swissquote.id, yahooSuffix: ".L", priceSource: "manual" });
    expect(r2.created).toBe(0);
    expect(r2.duplicates).toBe(3);

    // koersen uit de export als handmatige koers
    const assets = db.select().from(schema.assets).all();
    const prices: Record<string, string> = { EQQQ: "460.25", VUSA: "101.30", VWRL: "112.15" };
    for (const a of assets) setManualPrice(a.id, prices[a.symbol], "USD");

    const view = computePortfolio(portfolio.id);
    expect(view.positions.length).toBe(3);
    // Totale waarde USD: 920,50 + 405,20 + 1.121,50 = 2.447,20 → in EUR tegen 1,1 ≈ 2.224,73
    expect(view.totals.value.USD).toBe("2447.20");
    expect(Number(view.totals.value.EUR)).toBeCloseTo(2224.73, 0);
    const vwrl = view.positions.find((p) => p.symbol === "VWRL")!;
    expect(vwrl.quantity).toBe("10.00000000");
    expect(vwrl.avgCost).toBe("110.450000");
    expect(vwrl.unrealized.USD).toBe("17.00");
    expect(vwrl.lots.length).toBe(1);
    expect(view.allocation.byCategory[0].label).toBe("ETF's");
    expect(Math.round(view.allocation.byCategory[0].pct)).toBe(100);
    expect(view.allocation.byPlatform[0].label).toBe("Swissquote");

    const history = computeHistory(portfolio.id);
    expect(history.length).toBeGreaterThan(0);
    expect(history[history.length - 1].value.USD).toBe("2447.20");
  });
});

describe("vastgoed en geheimen", () => {
  it("fysiek vastgoed: waarde, schuld en netto", async () => {
    const db = getDb();
    const portfolio = db.select().from(schema.portfolios).get()!;
    const fysiek = db.insert(schema.platforms).values({ name: "Fysiek", type: "wallet" }).returning().get(); // eigen wallet, zoals "+ Nieuwe wallet toevoegen…"
    const huis = upsertAsset({ symbol: "HUIS", name: "Woning", category: "real_estate", currency: "EUR", priceSource: "manual" });
    await createTransaction({ portfolioId: portfolio.id, assetId: huis.id, platformId: fysiek.id, type: "buy", quantity: "1", price: "300000", currency: "EUR", fee: "6000", executedAt: "2024-05-01T10:00:00Z", source: "manual" });
    addValuation(huis.id, { date: "2026-09-01", value: "350000", currency: "EUR", debt: "200000" });
    const view = computePortfolio(portfolio.id);
    const pos = view.positions.find((p) => p.symbol === "HUIS")!;
    expect(pos.value.EUR).toBe("350000.00");
    expect(pos.debt.EUR).toBe("200000.00");
    expect(pos.netValue.EUR).toBe("150000.00");
    expect(pos.unrealized.EUR).toBe("44000.00");
    expect(view.totals.debt.EUR).toBe("200000.00");
  });

  it("geheimen worden versleuteld opgeslagen en gemaskeerd getoond", () => {
    setSecret("etoroApiKey", "abcdef1234567890"); // gitleaks:allow (nepsleutel)
    expect(getSecret("etoroApiKey")).toBe("abcdef1234567890");
    const row = getDb().select().from(schema.secrets).get()!;
    expect(row.encryptedValue).not.toContain("abcdef");
    expect(maskSecret("etoroApiKey").last4).toBe("7890");
  });
});
