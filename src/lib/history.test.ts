import { describe, it, expect, vi, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-history-"));

// De rekenkern wordt bespioneerd om te zien wanneer computeHistory de lot-berekening daadwerkelijk uitvoert.
vi.mock("./calc/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./calc/engine")>();
  return { ...actual, processTransactions: vi.fn(actual.processTransactions) };
});

import { getDb, schema } from "./db";
import { processTransactions } from "./calc/engine";
import { computeHistory, type HistoryPoint } from "./history";
import { upsertAsset, setManualPrice } from "./assets";
import { createTransaction, updateTransaction, deleteTransaction } from "./transactions";
import { setSetting } from "./settings";

const engine = vi.mocked(processTransactions);
let portfolioId: number;
let platformId: number;
let aapl: number;
let msft: number;

beforeAll(() => {
  const db = getDb();
  portfolioId = db.select().from(schema.portfolios).get()!.id;
  platformId = db.select().from(schema.platforms).all().find((p) => p.name === "eToro")!.id;
  // ECB-koers op de transactiedagen zelf, zodat createTransaction niets hoeft op te halen (offline in de test)
  for (const date of ["2026-01-05", "2026-01-10", "2026-02-01", "2026-03-01"]) db.insert(schema.fxRates).values({ date, currency: "USD", ratePerEur: "1.10" }).run();
  aapl = upsertAsset({ symbol: "AAPL", name: "Apple", category: "stock", currency: "EUR", priceSource: "manual" }).id;
  msft = upsertAsset({ symbol: "MSFT", name: "Microsoft", category: "stock", currency: "EUR", priceSource: "manual" }).id;
});

const buy = (assetId: number, quantity: string, price: string, executedAt: string) =>
  createTransaction({ portfolioId, assetId, platformId, type: "buy", quantity, price, currency: "EUR", fee: "0", executedAt, source: "manual" });
const last = (h: HistoryPoint[]) => h[h.length - 1];

describe("computeHistory hergebruikt de tijdlijnen per groep", () => {
  it("een tweede aanroep rekent niet opnieuw; een nieuwe, gewijzigde of verwijderde transactie wel", async () => {
    await buy(aapl, "2", "100", "2026-01-05T10:00:00Z");
    await buy(aapl, "1", "110", "2026-02-01T10:00:00Z");
    await buy(msft, "5", "20", "2026-01-10T10:00:00Z");
    setManualPrice(aapl, "130", "EUR", "2026-03-01");

    engine.mockClear();
    const first = computeHistory(portfolioId);
    expect(engine).toHaveBeenCalledTimes(2); // één keer per asset+platform-groep
    expect(last(first).invested.EUR).toBe("410.00"); // 200 + 110 + 100
    expect(last(first).value.EUR).toBe("490.00"); // 3 × 130, MSFT zonder koers tegen kostprijs

    // dezelfde vraag en een andere periode: tijdlijnen uit de cache, zelfde uitkomst
    const second = computeHistory(portfolioId);
    computeHistory(portfolioId, "2026-02-15");
    expect(engine).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first);

    // het totaalbeeld is een eigen bereik: eenmalig berekend, daarna uit de cache
    computeHistory(null);
    computeHistory(null);
    expect(engine).toHaveBeenCalledTimes(4);

    // nieuwe transactie: alleen de groep van dat asset opnieuw
    const extra = await buy(aapl, "1", "120", "2026-03-01T10:00:00Z");
    const third = computeHistory(portfolioId);
    expect(engine).toHaveBeenCalledTimes(5);
    expect(last(third).invested.EUR).toBe("530.00");
    expect(last(third).value.EUR).toBe("620.00");

    // gewijzigde transactie
    await updateTransaction(extra.id, { quantity: "2" });
    expect(last(computeHistory(portfolioId)).invested.EUR).toBe("650.00");
    expect(engine).toHaveBeenCalledTimes(6);

    // verwijderde transactie: terug naar het eerste beeld
    deleteTransaction(extra.id);
    expect(computeHistory(portfolioId)).toEqual(first);
    expect(engine).toHaveBeenCalledTimes(7);

    // andere kostprijsmethode: alle groepen opnieuw, daarna weer uit de cache
    setSetting("costMethod", "fifo");
    computeHistory(portfolioId);
    computeHistory(portfolioId);
    expect(engine).toHaveBeenCalledTimes(9);

    // een BTC-koers verandert de inleg in BTC van bestaande transacties (fxBtc wordt bij het laden berekend): opnieuw
    expect(last(computeHistory(portfolioId)).invested.BTC).toBe("0.00000000");
    getDb().insert(schema.fxRates).values({ date: "2026-01-01", currency: "BTC", ratePerEur: "0.00001" }).run();
    expect(last(computeHistory(portfolioId)).invested.BTC).toBe("0.00410000"); // 410 EUR × 0,00001
    computeHistory(portfolioId);
    expect(engine).toHaveBeenCalledTimes(11);
  });
});

describe("computeHistory per allocatiesegment", () => {
  it("telt alleen de groepen van het segment en gebruikt de tijdlijnen van het totaalbeeld", () => {
    const all = computeHistory(portfolioId);
    engine.mockClear();

    const onlyAapl = computeHistory(portfolioId, undefined, { by: "asset", key: String(aapl) });
    expect(onlyAapl[0].date).toBe("2026-01-05");
    expect(last(onlyAapl).invested.EUR).toBe("310.00"); // 200 + 110
    expect(last(onlyAapl).value.EUR).toBe("390.00"); // 3 × 130
    const onlyMsft = computeHistory(portfolioId, undefined, { by: "asset", key: String(msft) });
    expect(onlyMsft[0].date).toBe("2026-01-10"); // begint bij de eerste transactie van het segment
    expect(last(onlyMsft).invested.EUR).toBe("100.00");
    expect(computeHistory(portfolioId, "2026-02-15", { by: "asset", key: String(msft) })[0].date).toBe("2026-02-15");

    // beide aandelen, één platform, allebei in euro: categorie, platform en valuta omvatten hier alles
    expect(computeHistory(portfolioId, undefined, { by: "category", key: "stock" })).toEqual(all);
    expect(computeHistory(portfolioId, undefined, { by: "platform", key: String(platformId) })).toEqual(all);
    expect(computeHistory(portfolioId, undefined, { by: "currency", key: "EUR" })).toEqual(all);
    expect(computeHistory(portfolioId, undefined, { by: "category", key: "crypto" })).toEqual([]);

    // geen nieuwe lot-berekening, en het totaalbeeld komt daarna nog steeds uit de cache
    expect(computeHistory(portfolioId)).toEqual(all);
    expect(engine).not.toHaveBeenCalled();
  });
});
