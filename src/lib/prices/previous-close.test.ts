import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-previous-close-"));

import { getDb, schema } from "../db";
import type { AssetCategory, Currency } from "../db/schema";
import { addValuation, setManualPrice, upsertAsset } from "../assets";
import { computePortfolio } from "../portfolio";
import { shiftDays } from "./fx";
import { isNextSession, previousClose, saveQuote } from "./quotes";

beforeAll(() => {
  vi.stubGlobal("fetch", async () => new Response("blocked", { status: 403 })); // alles hier is lokaal
  getDb();
});

const asset = (symbol: string, category: AssetCategory = "stock", currency: Currency = "EUR") => upsertAsset({ symbol, name: symbol, category, currency, priceSource: "manual" });
const valuation = (assetId: number, date: string, value: string) => addValuation(assetId, { date, value, currency: "EUR", debt: "0" });

describe("previousClose valt alleen terug op de rij van de vorige handelsdag", () => {
  it("vastgoed: een waardering van maanden terug geeft geen verandering vandaag, ook niet op de dag van een nieuwe", () => {
    const huis = asset("HUIS", "real_estate");
    valuation(huis.id, "2026-01-15", "400000");
    valuation(huis.id, "2026-03-02", "410000");
    expect(previousClose(huis.id, "2026-06-10")).toBeNull(); // voorheen elke dag +10.000 als verandering van vandaag
    valuation(huis.id, "2026-06-10", "425000");
    expect(previousClose(huis.id, "2026-06-10")).toBeNull(); // herwaardering vandaag; de vorige is van maart
  });

  it("handmatige dagkoers: gisteren en vandaag geven een verandering, de dag erna zonder nieuwe koers niet meer", () => {
    const a = asset("HANDA");
    setManualPrice(a.id, "10.00", "EUR", "2026-06-09");
    setManualPrice(a.id, "10.20", "EUR", "2026-06-10");
    expect(previousClose(a.id, "2026-06-10")).toBe("10.00");
    expect(previousClose(a.id, "2026-06-11")).toBeNull(); // de laatste rij is niet van vandaag
  });

  it("over een weekend heen: vrijdag telt als vorige slot voor maandag", () => {
    const a = asset("HANDB");
    setManualPrice(a.id, "20", "EUR", "2026-06-05"); // vr
    setManualPrice(a.id, "21", "EUR", "2026-06-08"); // ma
    expect(previousClose(a.id, "2026-06-08")).toBe("20");
  });

  it("eToro zonder dagslot: vandaag tegen gisteren, maar niet na een week zonder koers", () => {
    const a = asset("FEEDA", "stock", "USD");
    saveQuote(a.id, "2026-06-01T21:00:00.000Z", 30, "USD", "etoro");
    saveQuote(a.id, "2026-06-09T21:00:00.000Z", 31, "USD", "etoro");
    saveQuote(a.id, "2026-06-10T12:00:00.000Z", 31.5, "USD", "etoro");
    expect(previousClose(a.id, "2026-06-10")).toBe("31");

    const b = asset("FEEDB", "stock", "USD");
    saveQuote(b.id, "2026-06-01T21:00:00.000Z", 30, "USD", "etoro");
    saveQuote(b.id, "2026-06-10T12:00:00.000Z", 31.5, "USD", "etoro");
    expect(previousClose(b.id, "2026-06-10")).toBeNull(); // anders een week als verandering van vandaag
  });

  it("een opgeslagen previous_close (Yahoo, Kraken, eToro) gaat voor, ongeacht de rij ervoor", () => {
    const a = asset("FEEDC", "etf");
    saveQuote(a.id, "2026-03-02T21:00:00.000Z", 30, "EUR", "yahoo");
    saveQuote(a.id, "2026-06-10T12:00:00.000Z", 33, "EUR", "yahoo", 32.5);
    expect(previousClose(a.id, "2026-06-10")).toBe("32.5");
  });

  it("isNextSession: de vorige dag, of de laatste werkdag ervoor met een weekend en hoogstens één feestdag ertussen", () => {
    expect(isNextSession("2026-06-11", "2026-06-12")).toBe(true); // do → vr
    expect(isNextSession("2026-06-05", "2026-06-08")).toBe(true); // vr → ma
    expect(isNextSession("2026-06-05", "2026-06-09")).toBe(true); // vr → di, maandag feestdag
    expect(isNextSession("2026-06-04", "2026-06-08")).toBe(true); // do → ma, vrijdag feestdag
    expect(isNextSession("2026-06-06", "2026-06-07")).toBe(true); // za → zo (crypto of handmatig)
    expect(isNextSession("2026-04-02", "2026-04-07")).toBe(false); // do → di over Pasen: twee werkdagen ertussen
    expect(isNextSession("2026-06-01", "2026-06-08")).toBe(false); // een week
    expect(isNextSession("2026-06-10", "2026-06-10")).toBe(false);
    expect(isNextSession("2026-06-11", "2026-06-10")).toBe(false);
  });

  it("Vandaag in het overzicht: een woning met oude waarderingen telt niet mee, een handmatige dagkoers wel", () => {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const portfolio = db.select().from(schema.portfolios).get()!;
    const fysiek = db.insert(schema.platforms).values({ name: "Fysiek", type: "wallet" }).returning().get();
    const woning = asset("WONING", "real_estate");
    const fonds = asset("FONDS", "etf");
    for (const [a, quantity, price] of [[woning, "1", "300000"], [fonds, "100", "9"]] as const) {
      db.insert(schema.transactions).values({ portfolioId: portfolio.id, assetId: a.id, platformId: fysiek.id, type: "buy", quantity, price, currency: "EUR", executedAt: "2025-06-02T10:00:00.000Z", source: "manual", createdAt: "2025-06-02T10:00:00.000Z" }).run();
    }
    valuation(woning.id, "2026-01-15", "400000");
    valuation(woning.id, "2026-03-02", "410000");
    setManualPrice(fonds.id, "10.00", "EUR", shiftDays(today, -1));
    setManualPrice(fonds.id, "10.20", "EUR", today);

    const view = computePortfolio(portfolio.id);
    const position = (assetId: number) => view.positions.find((p) => p.assetId === assetId)!;
    expect(position(woning.id)).toMatchObject({ value: { EUR: "410000.00" }, previousClose: null, dayChange: { EUR: "0.00" }, dayChangePct: null });
    expect(position(fonds.id)).toMatchObject({ previousClose: "10.00", dayChange: { EUR: "20.00" }, dayChangePct: "2.00" });
    expect(view.totals.dayChange.EUR).toBe("20.00"); // voorheen +10.020: het verschil tussen de twee waarderingen erbij
  });
});
