import { describe, it, expect } from "vitest";
import { processTransactions, cashFlows, type EngineTx } from "./engine";

// Rekenvoorbeeld uit de spec (USD, koers nu $75.000)
const txs: EngineTx[] = [
  { id: 1, type: "buy", quantity: "0.1", price: "60000", fee: "5", currency: "USD", executedAt: "2026-01-10T10:00:00Z", fxEur: "0.9", fxUsd: null },
  { id: 2, type: "buy", quantity: "0.1", price: "70000", fee: "5", currency: "USD", executedAt: "2026-03-01T10:00:00Z", fxEur: "0.92", fxUsd: null },
  { id: 3, type: "sell", quantity: "0.05", price: "80000", fee: "4", currency: "USD", executedAt: "2026-06-01T10:00:00Z", fxEur: "0.88", fxUsd: null },
];
const PRICE_NOW = 75000;

describe("rekenvoorbeeld uit de spec", () => {
  it("gemiddelde kostprijs: 743,50 gerealiseerd, 1.492,50 ongerealiseerd, totaal 2.236,00", () => {
    const r = processTransactions(txs, "average");
    expect(r.avgCost.toFixed(2)).toBe("65050.00");
    expect(r.realizedPnl.toFixed(2)).toBe("743.50");
    expect(r.quantity.toFixed(8)).toBe("0.15000000");
    expect(r.cost.toFixed(2)).toBe("9757.50");
    const unrealized = r.quantity.mul(PRICE_NOW).minus(r.cost);
    expect(unrealized.toFixed(2)).toBe("1492.50");
    expect(r.realizedPnl.plus(unrealized).toFixed(2)).toBe("2236.00");
    // rendement 17,2%
    expect(r.realizedPnl.plus(unrealized).div(r.totalBuyCost).mul(100).toFixed(1)).toBe("17.2");
  });

  it("FIFO: 993,50 gerealiseerd, 1.242,50 ongerealiseerd, totaal 2.236,00", () => {
    const r = processTransactions(txs, "fifo");
    expect(r.realizedPnl.toFixed(2)).toBe("993.50");
    expect(r.cost.toFixed(2)).toBe("10007.50");
    const unrealized = r.quantity.mul(PRICE_NOW).minus(r.cost);
    expect(unrealized.toFixed(2)).toBe("1242.50");
    expect(r.realizedPnl.plus(unrealized).toFixed(2)).toBe("2236.00");
    // per aankoop (FIFO): lot 1 heeft 0,05 over (+747,50), lot 2 volledig (+495,00)
    const lot1 = r.lots[0];
    const lot2 = r.lots[1];
    expect(lot1.quantityOpen.toFixed(2)).toBe("0.05");
    expect(lot1.quantityOpen.mul(PRICE_NOW).minus(lot1.costOpen).toFixed(2)).toBe("747.50");
    expect(lot2.quantityOpen.mul(PRICE_NOW).minus(lot2.costOpen).toFixed(2)).toBe("495.00");
  });

  it("gemiddeld: verkoop verlaagt elk lot naar rato (1.121,25 + 371,25)", () => {
    const r = processTransactions(txs, "average");
    const [lot1, lot2] = r.lots;
    expect(lot1.quantityOpen.toFixed(3)).toBe("0.075");
    expect(lot1.quantityOpen.mul(PRICE_NOW).minus(lot1.costOpen).toFixed(2)).toBe("1121.25");
    expect(lot2.quantityOpen.mul(PRICE_NOW).minus(lot2.costOpen).toFixed(2)).toBe("371.25");
  });

  it("kostprijs in EUR gebruikt de wisselkoers van de transactiedatum", () => {
    const r = processTransactions(txs, "fifo");
    // lot 1 rest 0,05: kost 3002,50 USD × 0,9 = 2702,25 EUR; lot 2: 7005 × 0,92 = 6444,60 EUR
    expect(r.costEur.toFixed(2)).toBe("9146.85");
    // gerealiseerd EUR: opbrengst 3996 × 0,88 = 3516,48 − kost 3002,50 × 0,9 = 2702,25 → 814,23
    expect(r.realizedPnlEur.toFixed(2)).toBe("814.23");
  });
});

describe("overige transactietypes", () => {
  it("dividend en losse kosten tellen als inkomsten en kosten, staking in natura wordt een lot met kostprijs 0", () => {
    const r = processTransactions(
      [
        ...txs,
        { id: 4, type: "dividend", quantity: "0", price: "12.5", fee: "0", currency: "USD", executedAt: "2026-06-15T00:00:00Z", fxEur: "0.9", fxUsd: null },
        { id: 5, type: "fee", quantity: "0", price: "3", fee: "0", currency: "USD", executedAt: "2026-06-16T00:00:00Z", fxEur: "0.9", fxUsd: null },
        { id: 6, type: "staking", quantity: "0.001", price: "0", fee: "0", currency: "USD", executedAt: "2026-06-17T00:00:00Z", fxEur: "0.9", fxUsd: null },
      ],
      "fifo"
    );
    expect(r.incomeEur.toFixed(2)).toBe("11.25");
    expect(r.feesEur.toFixed(2)).toBe("2.70");
    expect(r.quantity.toFixed(3)).toBe("0.151");
    expect(r.lots[2].costOpen.toFixed(2)).toBe("0.00");
  });

  it("kas: storting, aankoop, verkoop en dividend", () => {
    const cash = cashFlows([
      { id: 1, type: "deposit", quantity: "0", price: "1000", fee: "0", currency: "EUR", executedAt: "2026-01-01T00:00:00Z", fxEur: null, fxUsd: null },
      { id: 2, type: "buy", quantity: "2", price: "100", fee: "1", currency: "EUR", executedAt: "2026-01-02T00:00:00Z", fxEur: null, fxUsd: null },
      { id: 3, type: "sell", quantity: "1", price: "120", fee: "1", currency: "EUR", executedAt: "2026-01-03T00:00:00Z", fxEur: null, fxUsd: null },
      { id: 4, type: "dividend", quantity: "0", price: "5", fee: "0", currency: "EUR", executedAt: "2026-01-04T00:00:00Z", fxEur: null, fxUsd: null },
    ]);
    expect(cash.EUR.toFixed(2)).toBe("923.00");
  });

  it("verkoop van meer dan open staat geeft een waarschuwing", () => {
    const r = processTransactions(
      [
        { id: 1, type: "buy", quantity: "1", price: "10", fee: "0", currency: "EUR", executedAt: "2026-01-01T00:00:00Z", fxEur: null, fxUsd: null },
        { id: 2, type: "sell", quantity: "2", price: "12", fee: "0", currency: "EUR", executedAt: "2026-01-02T00:00:00Z", fxEur: null, fxUsd: null },
      ],
      "fifo"
    );
    expect(r.warnings.length).toBe(1);
    expect(r.quantity.toFixed(0)).toBe("0");
    expect(r.realizedPnl.toFixed(2)).toBe("14.00");
  });
});

describe("overboekingen", () => {
  it("transfer_in maakt een lot tegen de opgegeven prijs, transfer_out verlaagt zonder gerealiseerd resultaat", () => {
    const r = processTransactions(
      [
        { id: 1, type: "transfer_in", quantity: "1", price: "20000", fee: "0", currency: "EUR", executedAt: "2026-01-01T00:00:00Z", fxEur: null, fxUsd: null },
        { id: 2, type: "buy", quantity: "1", price: "30000", fee: "0", currency: "EUR", executedAt: "2026-02-01T00:00:00Z", fxEur: null, fxUsd: null },
        { id: 3, type: "transfer_out", quantity: "0.5", price: "0", fee: "0", currency: "EUR", executedAt: "2026-03-01T00:00:00Z", fxEur: null, fxUsd: null },
      ],
      "fifo"
    );
    expect(r.quantity.toFixed(1)).toBe("1.5");
    expect(r.cost.toFixed(2)).toBe("40000.00"); // 0,5 × 20.000 uit lot 1 weg, geen gerealiseerd
    expect(r.realized.length).toBe(0);
    expect(r.realizedPnl.toFixed(2)).toBe("0.00");
  });
});
