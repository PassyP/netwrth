import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-transfers-"));

// De rekenkern wordt bespioneerd om te zien of koppeling en lot-berekening uit het geheugen komen.
vi.mock("./calc/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./calc/engine")>();
  return { ...actual, processTransactions: vi.fn(actual.processTransactions) };
});

import { getDb, schema } from "./db";
import { processTransactions } from "./calc/engine";
import { computePortfolio } from "./portfolio";
import { computeHistory, type HistoryFilter } from "./history";

const engine = vi.mocked(processTransactions);

const day = (d: string, t = "10:00:00") => `${d}T${t}.000Z`;

describe("overboekingen tussen eigen platforms in het portfolio", () => {
  let portfolioId: number;
  let kraken: number;
  let cold: number;
  let btc: number;
  beforeAll(() => {
    const db = getDb();
    portfolioId = db.select().from(schema.portfolios).get()!.id;
    kraken = db.insert(schema.platforms).values({ name: "Kraken", type: "exchange" }).returning().get().id;
    cold = db.insert(schema.platforms).values({ name: "Koude wallet", type: "wallet" }).returning().get().id;
    btc = db.insert(schema.assets).values({ symbol: "BTC", name: "Bitcoin", category: "crypto", currency: "USD", priceSource: "manual", createdAt: day("2024-01-01") }).returning().get().id;
    const base = { portfolioId, assetId: btc, currency: "EUR" as const, fee: "0", fxEur: "1", fxUsd: "1.1", createdAt: day("2024-01-01") };
    db.insert(schema.transactions)
      .values([
        // Kraken: 2 BTC gekocht à 20 000; 0,5004 opgenomen naar de wallet (0,0004 opnamekosten)
        { ...base, platformId: kraken, type: "buy", quantity: "2", price: "20000", executedAt: day("2024-01-01"), source: "api" },
        { ...base, platformId: kraken, type: "transfer_out", quantity: "0.5004", price: "0", executedAt: day("2024-02-01"), source: "api" },
        // wallet: dezelfde coins ontvangen, door de sync geboekt tegen dagkoers 50 000
        { ...base, platformId: cold, type: "transfer_in", quantity: "0.5", price: "50000", executedAt: day("2024-02-01", "10:15:00"), source: "api", externalId: "btc:1:rx1" },
        // wallet: ontvangst van buiten de app (geen opname in de buurt): dagkoers blijft de kostprijs
        { ...base, platformId: cold, type: "transfer_in", quantity: "0.5", price: "60000", executedAt: day("2024-03-01"), source: "api", externalId: "btc:1:rx2" },
      ])
      .run();
  });

  it("de gematchte ontvangst krijgt de kostprijs van Kraken; de totale inleg is de oorspronkelijke aankoop plus de externe ontvangst", () => {
    const view = computePortfolio(null);
    const k = view.positions.find((p) => p.platformId === kraken)!;
    const s = view.positions.find((p) => p.platformId === cold)!;
    expect(k.quantity).toBe("1.49960000");
    expect(k.cost.EUR).toBe("29992.00");
    expect(s.quantity).toBe("1.00000000");
    expect(s.cost.EUR).toBe("40008.00"); // 10 008 meegenomen + 30 000 extern tegen dagkoers (niet 25 000 + 30 000)
    expect(s.cost.USD).toBe("44008.80");
    expect(s.lots.map((l) => [l.quantityOpen, l.internal])).toEqual([
      ["0.50000000", true],
      ["0.50000000", false],
    ]);
    expect(view.totals.cost.EUR).toBe("70000.00"); // "Inleg": 40 000 gekocht + 30 000 van buiten
    expect(view.totals.totalBuyCost.EUR).toBe("70000.00"); // de overboeking telt niet dubbel
  });

  it("per portfolio bekeken blijft de koppeling werken; de historiegrafiek toont dezelfde inleg", () => {
    const view = computePortfolio(portfolioId);
    expect(view.totals.cost.EUR).toBe("70000.00");
    const points = computeHistory(null);
    expect(points[points.length - 1].invested.EUR).toBe("70000.00");
    const before = points.find((p) => p.date === "2024-02-01")!;
    expect(before.invested.EUR).toBe("40000.00"); // op de dag van de overboeking verandert de inleg niet
    const jan = points.find((p) => p.date === "2024-01-15")!;
    expect(jan.invested.EUR).toBe("40000.00");
  });

  it("de grafiek per allocatiesegment: de wallet houdt de meegenomen kostprijs, beide platforms samen zijn het totaal", () => {
    const end = (filter: HistoryFilter) => computeHistory(null, undefined, filter).at(-1)!;
    expect(end({ platform: String(cold) }).invested.EUR).toBe("40008.00");
    expect(end({ platform: String(kraken) }).invested.EUR).toBe("29992.00");
    expect(computeHistory(null, undefined, { platform: String(cold) })[0].date).toBe("2024-02-01"); // vanaf de eerste ontvangst
    expect(end({ asset: String(btc) }).invested.EUR).toBe("70000.00");
    expect(end({ category: "crypto" }).invested.EUR).toBe("70000.00");
    // valuta van het asset (zoals de allocatie), niet die van de transacties
    expect(end({ currency: "USD" }).invested.EUR).toBe("70000.00");
    expect(computeHistory(null, undefined, { currency: "EUR" })).toEqual([]);
  });

  it("overzicht en grafiek hergebruiken de koppeling en de lot-berekening zolang er niets verandert", () => {
    computePortfolio(null);
    computeHistory(null);
    engine.mockClear();
    computePortfolio(null);
    computeHistory(null);
    computeHistory(null, undefined, { platform: String(cold) });
    expect(engine).not.toHaveBeenCalled();
    // de volgende test haalt de opname weg: dan moet alles opnieuw (zie de verwachte kostprijs daar)
  });

  it("zonder tegenpartij (opname weggehaald) valt de ontvangst terug op dagkoers", () => {
    const db = getDb();
    const out = db.select().from(schema.transactions).all().find((t) => t.type === "transfer_out")!;
    db.delete(schema.transactions).where(eqId(out.id)).run();
    const view = computePortfolio(null);
    const s = view.positions.find((p) => p.platformId === cold)!;
    expect(s.cost.EUR).toBe("55000.00"); // 25 000 + 30 000
    expect(view.totals.totalBuyCost.EUR).toBe("95000.00");
  });

  it('wallet-koppeling met "geen kostprijs voor ontvangsten zonder tegenpartij": API-ontvangsten tellen niet als inleg', () => {
    const db = getDb();
    const conn = db.insert(schema.connections).values({ provider: "bitcoin", label: "Koude wallet", platformId: cold, portfolioId, receiptCost: "none", status: "ok", createdAt: day("2024-01-01") }).returning().get();
    let view = computePortfolio(null);
    let s = view.positions.find((p) => p.platformId === cold)!;
    expect(s.quantity).toBe("1.00000000");
    expect(s.cost.EUR).toBe("0.00");
    expect(view.totals.cost.EUR).toBe("40000.00"); // alleen de Kraken-aankoop
    expect(view.totals.totalBuyCost.EUR).toBe("40000.00");
    expect(computeHistory(null).at(-1)!.invested.EUR).toBe("40000.00");
    // terug naar dagkoers
    db.update(schema.connections).set({ receiptCost: "market" }).where(eq(schema.connections.id, conn.id)).run();
    view = computePortfolio(null);
    s = view.positions.find((p) => p.platformId === cold)!;
    expect(s.cost.EUR).toBe("55000.00");
  });
});

import { eq } from "drizzle-orm";
function eqId(id: number) {
  return eq(schema.transactions.id, id);
}
