import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-settings-support-"));

import { getDb, schema } from "../db";
import { countReplaceable, createConnection, hasOwnKeys, listConnections, parseWarnings, previewPlatform, switchToSharedKeys } from "./sync";
import { createPlatform } from "../platforms";
import { getSecret } from "../secrets";
import { refreshSummary } from "../prices/quotes";

const now = "2026-02-01T10:00:00.000Z";

describe("wizard: platform en vervang-telling vooraf", () => {
  it("Kraken en eToro komen op hun vaste platform; een wallet krijgt een eigen platform of hergebruikt een wallet met die naam", () => {
    expect(previewPlatform("kraken", "wat dan ook")).toEqual({ platformId: null, name: "Kraken", type: "exchange" });
    const etoro = getDb().select().from(schema.platforms).all().find((p) => p.name === "eToro")!; // uit de seed
    expect(previewPlatform("etoro", "x")).toEqual({ platformId: etoro.id, name: "eToro", type: "broker" });
    expect(previewPlatform("bitcoin", "Koude wallet")).toEqual({ platformId: null, name: "Koude wallet", type: "wallet" });
    const wallet = createPlatform({ name: "Koude wallet", type: "wallet" });
    expect(previewPlatform("bitcoin", "Koude wallet").platformId).toBe(wallet.id);
    // een broker met dezelfde naam wordt nooit gekaapt: dan "<naam> (wallet)"
    createPlatform({ name: "Testbroker", type: "broker" });
    expect(previewPlatform("bitcoin", "Testbroker")).toEqual({ platformId: null, name: "Testbroker (wallet)", type: "wallet" });
  });

  it("telt alleen handmatige en geïmporteerde transacties van dat platform in dat portfolio", () => {
    const db = getDb();
    const wallet = db.select().from(schema.platforms).all().find((p) => p.name === "Koude wallet")!;
    const portfolio = db.select().from(schema.portfolios).get()!;
    const other = db.insert(schema.portfolios).values({ name: "Ander", createdAt: now }).returning().get();
    const tx = (portfolioId: number, source: string, n: number) =>
      db.insert(schema.transactions).values({ portfolioId, platformId: wallet.id, type: "deposit", quantity: "0", price: "10", currency: "EUR", executedAt: now, source, hash: `h-${portfolioId}-${source}-${n}`, createdAt: now }).run();
    tx(portfolio.id, "manual", 1);
    tx(portfolio.id, "csv", 2);
    tx(portfolio.id, "api", 3);
    tx(other.id, "manual", 4);
    expect(countReplaceable(wallet.id, portfolio.id)).toBe(2);
    expect(countReplaceable(wallet.id, other.id)).toBe(1);
  });
});

describe("eToro: gedeelde of eigen keys", () => {
  it("terug naar de gedeelde koers-keys wist de eigen keys van de koppeling", () => {
    const portfolio = getDb().select().from(schema.portfolios).get()!;
    const conn = createConnection({ provider: "etoro", label: "eToro", portfolioId: portfolio.id, mode: "alongside", apiKey: "OWNKEY01", apiSecret: "OWNUSER1" });
    expect(hasOwnKeys(conn.id)).toBe(true);
    expect(listConnections().find((c) => c.id === conn.id)?.keys.shared).toBe(false);
    switchToSharedKeys(conn.id);
    expect(hasOwnKeys(conn.id)).toBe(false);
    expect(getSecret(`conn:${conn.id}:apiKey`)).toBeNull();
    expect(listConnections().find((c) => c.id === conn.id)?.keys.shared).toBe(true);
  });

  it("listConnections geeft wat verwijderen met transacties zou wissen en de koppelingen op hetzelfde platform", () => {
    const portfolio = getDb().select().from(schema.portfolios).get()!;
    const demo = createConnection({ provider: "etoro", label: "eToro demo", portfolioId: portfolio.id, accountType: "demo", mode: "alongside" });
    const rows = listConnections().filter((c) => c.provider === "etoro");
    expect(rows).toHaveLength(2);
    const d = rows.find((c) => c.id === demo.id)!;
    expect(d.siblingIds).toHaveLength(1);
    expect(d.apiTxCount).toBe(0);
    expect(d.nodeSource).toBeNull();
  });
});

describe("taaklog", () => {
  it("refreshSummary noemt de mislukte koersen", () => {
    expect(refreshSummary(20, [])).toBe("20 bijgewerkt, 0 mislukt");
    expect(refreshSummary(18, [{ asset: "AAA" }, { asset: "BBB" }])).toBe("18 bijgewerkt, 2 mislukt: AAA, BBB");
    const many = ["A1", "A2", "A3", "A4", "A5", "A6", "A7"].map((asset) => ({ asset }));
    expect(refreshSummary(1, many)).toBe("1 bijgewerkt, 7 mislukt: A1, A2, A3, A4, A5 en 2 meer");
  });

  it("parseWarnings is tolerant", () => {
    expect(parseWarnings(null)).toEqual([]);
    expect(parseWarnings("niet-json")).toEqual([]);
    expect(parseWarnings(JSON.stringify(["a", 1]))).toEqual(["a", "1"]);
  });
});
