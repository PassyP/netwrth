import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-platforms-"));

import { getDb, schema } from "./db";
import { ApiError } from "./errors";
import { createPlatform, deletePlatform, listPlatforms, updatePlatform } from "./platforms";
import { createConnection } from "./connections/sync";
import { listWalletAccounts } from "./connections/wallet-accounts";
import { getSecret } from "./secrets";
import { ZPUB } from "./bitcoin/test-vectors";

const now = "2026-09-22T10:00:00.000Z";

describe("platforms en wallets", () => {
  it("aanmaken, hernoemen en verwijderen; namen zijn uniek zonder onderscheid in hoofdletters", () => {
    const ledger = createPlatform({ name: " Ledger ", type: "wallet" });
    expect(ledger).toMatchObject({ name: "Ledger", type: "wallet" });
    expect(() => createPlatform({ name: "ledger", type: "wallet" })).toThrow('Er bestaat al een platform met de naam "Ledger".');
    // gesorteerd zonder onderscheid in hoofdletters (eToro vóór Ledger), met tellingen
    expect(listPlatforms().map((p) => [p.name, p.txCount, p.connectionCount])).toEqual([
      ["eToro", 0, 0],
      ["Ledger", 0, 0],
      ["Swissquote", 0, 0],
    ]);
    expect(updatePlatform(ledger.id, { name: "Trezor" })).toMatchObject({ id: ledger.id, name: "Trezor", type: "wallet" });
    expect(() => updatePlatform(ledger.id, { name: "SWISSQUOTE" })).toThrow(/bestaat al/);
    expect(updatePlatform(ledger.id, { name: "trezor" }).name).toBe("trezor"); // eigen naam anders spellen mag
    expect(updatePlatform(ledger.id, {}).name).toBe("trezor");
    let missing: unknown;
    try {
      updatePlatform(9999, { name: "x" });
    } catch (e) {
      missing = e;
    }
    expect(missing).toBeInstanceOf(ApiError);
    expect((missing as ApiError).status).toBe(404);
    deletePlatform(ledger.id);
    expect(listPlatforms().some((p) => p.id === ledger.id)).toBe(false);
    expect(() => deletePlatform(ledger.id)).toThrow(/niet gevonden/);
  });

  it("verwijderen wordt geweigerd zolang er transacties of een koppeling aan hangen", () => {
    const db = getDb();
    const portfolio = db.select().from(schema.portfolios).get()!;
    const wallet = createPlatform({ name: "Kluis", type: "wallet" });
    const asset = db.insert(schema.assets).values({ symbol: "GOUD", name: "Goud", category: "commodity", currency: "EUR", priceSource: "manual", createdAt: now }).returning().get();
    const tx = () =>
      db.insert(schema.transactions).values({ portfolioId: portfolio.id, assetId: asset.id, platformId: wallet.id, type: "buy", quantity: "1", price: "2000", currency: "EUR", executedAt: now, source: "manual", createdAt: now }).run();
    tx();
    expect(listPlatforms().find((p) => p.id === wallet.id)).toMatchObject({ txCount: 1, connectionCount: 0 });
    let err: unknown;
    try {
      deletePlatform(wallet.id);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toBe('"Kluis" heeft nog 1 transactie. Verplaats of verwijder die eerst.');
    tx();
    db.insert(schema.connections).values({ provider: "kraken", label: "Kraken", platformId: wallet.id, portfolioId: portfolio.id, createdAt: now }).run();
    expect(listPlatforms().find((p) => p.id === wallet.id)).toMatchObject({ txCount: 2, connectionCount: 1 });
    expect(() => deletePlatform(wallet.id)).toThrow('"Kluis" heeft nog 2 transacties en 1 koppeling. Verplaats of verwijder die eerst.');
    // hernoemen mag altijd
    expect(updatePlatform(wallet.id, { name: "Kluis thuis" }).name).toBe("Kluis thuis");
    db.delete(schema.transactions).run();
    db.delete(schema.connections).run();
    deletePlatform(wallet.id);
    expect(listPlatforms().map((p) => p.name)).toEqual(["eToro", "Swissquote"]);
  });

  it("verwijderen mét inhoud: koppeling (incl. xpub-secret), API-transacties en handmatige transacties gaan in één keer weg", () => {
    const db = getDb();
    const portfolio = db.select().from(schema.portfolios).get()!;
    const conn = createConnection({ provider: "bitcoin", label: "Testwallet", portfolioId: portfolio.id, accounts: [{ xpub: ZPUB, scriptType: "p2wpkh", label: "Bitcoin 1" }] });
    const account = listWalletAccounts(conn.id)[0];
    expect(getSecret(`wallet:${account.id}:xpub`)).toBe(ZPUB);
    const asset = db.select().from(schema.assets).all()[0] ?? db.insert(schema.assets).values({ symbol: "BTC", name: "Bitcoin", category: "crypto", currency: "USD", priceSource: "manual", createdAt: now }).returning().get();
    // alsof een sync ze boekte (alleen-lezen) plus een handmatige in een ander portfolio
    db.insert(schema.transactions).values({ portfolioId: portfolio.id, assetId: asset.id, platformId: conn.platformId, type: "transfer_in", quantity: "0.001", price: "30000", currency: "EUR", executedAt: now, source: "api", externalId: `btc:${conn.id}:abc`, hash: "h1", createdAt: now }).run();
    db.insert(schema.transactions).values({ portfolioId: portfolio.id, assetId: null, platformId: conn.platformId, type: "fee", quantity: "0", price: "0.3", currency: "EUR", executedAt: now, source: "api", externalId: `btc:${conn.id}:abc:fee`, hash: "h2", createdAt: now }).run();
    const other = db.insert(schema.portfolios).values({ name: "Ander", createdAt: now }).returning().get();
    db.insert(schema.transactions).values({ portfolioId: other.id, assetId: asset.id, platformId: conn.platformId, type: "buy", quantity: "0.5", price: "20000", currency: "EUR", executedAt: now, source: "manual", createdAt: now }).run();
    expect(listPlatforms().find((p) => p.id === conn.platformId)).toMatchObject({ name: "Testwallet", type: "wallet", txCount: 3, connectionCount: 1 });
    expect(() => deletePlatform(conn.platformId)).toThrow(/heeft nog 3 transacties en 1 koppeling/);

    expect(deletePlatform(conn.platformId, { withEverything: true })).toEqual({ transactions: 3, connections: 1 }); // alles wat weg is, ook de 2 API-transacties van de koppeling
    expect(listPlatforms().some((p) => p.id === conn.platformId)).toBe(false);
    expect(db.select().from(schema.transactions).all().filter((t) => t.platformId === conn.platformId)).toHaveLength(0);
    expect(db.select().from(schema.connections).all().some((c) => c.id === conn.id)).toBe(false);
    expect(db.select().from(schema.walletAccounts).all().some((a) => a.connectionId === conn.id)).toBe(false);
    expect(getSecret(`wallet:${account.id}:xpub`)).toBeNull();
  });
});
