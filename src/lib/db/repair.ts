/**
 * Eenmalige datareparaties bij het openen van de database (idempotent en goedkoop; zie ook repairEtoroQuoteCurrency).
 */
import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { parseCryptoTicker, stripQuoteFromName } from "../prices/yahoo";

type Db = BetterSQLite3Database<typeof schema>;

const FEED_SOURCES = new Set<string>(["etoro", "yahoo", "kraken"]);

export interface RepairReport {
  /** "BTC-USD → BTC (#3)": samengevoegd met het bestaande crypto-asset van die munt */
  merged: string[];
  /** "ETH-EUR → ETH": geen tweeling, alleen hernoemd */
  renamed: string[];
  /** niet aangeraakt, met reden */
  skipped: string[];
}

function parseProviderIds(json: string | null): Record<string, string> {
  try {
    return json ? (JSON.parse(json) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Crypto-assets die een Yahoo-ticker als symbool hebben (BTC-USD, ETH-EUR) vallen buiten de identiteitsregel "één
 * crypto-asset per symbool": naast het Kraken-/eToro-asset BTC stond dan een tweede asset BTC-USD met eigen positie.
 * Bestaat het asset van die munt al, dan gaan transacties, alerts, waarderingen en de koersdagen die het doel nog mist
 * naar dat asset en verdwijnt de dubbele rij; het doel houdt zijn koersbron (alleen een ontbrekende bron wordt ingevuld)
 * en neemt naam, logo en provider-id's over voor zover het die zelf niet heeft. Zonder tweeling wordt het asset alleen
 * hernoemd naar de munt; de ticker blijft het bron-id. Aandelen met een streepje (BRK-B) worden niet aangeraakt.
 */
export function repairYahooCryptoSymbols(db: Db): RepairReport {
  const report: RepairReport = { merged: [], renamed: [], skipped: [] };
  const ids = db
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(eq(schema.assets.category, "crypto"))
    .all()
    .map((r) => r.id);
  for (const id of ids) {
    // per asset opnieuw lezen: een eerdere samenvoeging of hernoeming (ETH-USD én ETH-EUR zonder ETH) verandert de lijst
    const all = db.select().from(schema.assets).all();
    const a = all.find((x) => x.id === id);
    if (!a || a.category !== "crypto") continue;
    const ticker = parseCryptoTicker(a.symbol);
    if (!ticker) continue;
    const name = a.name === a.symbol ? ticker.base : stripQuoteFromName(a.name, ticker.quote);
    const target = all.find((b) => b.id !== a.id && b.category === "crypto" && b.symbol === ticker.base);
    try {
      if (!target) {
        const clash = all.find((b) => b.id !== a.id && b.symbol === ticker.base && b.currency === a.currency);
        if (clash) {
          report.skipped.push(`${a.symbol}: ${ticker.base}/${a.currency} bestaat al als ${clash.category} (#${clash.id})`);
          continue;
        }
        db.update(schema.assets).set({ symbol: ticker.base, name, sourceId: a.sourceId ?? a.symbol }).where(eq(schema.assets.id, a.id)).run();
        report.renamed.push(`${a.symbol} → ${ticker.base}`);
        continue;
      }
      db.transaction((tx) => {
        tx.update(schema.transactions).set({ assetId: target.id }).where(eq(schema.transactions.assetId, a.id)).run();
        tx.update(schema.alerts).set({ assetId: target.id }).where(eq(schema.alerts.assetId, a.id)).run();
        tx.update(schema.valuations).set({ assetId: target.id }).where(eq(schema.valuations.assetId, a.id)).run();
        // koersen: alleen dagen die het doel nog niet heeft (unieke index asset+dag); de rest verdwijnt met het asset
        const targetDays = new Set(tx.select({ day: schema.priceQuotes.day }).from(schema.priceQuotes).where(eq(schema.priceQuotes.assetId, target.id)).all().map((r) => r.day));
        for (const q of tx.select({ id: schema.priceQuotes.id, day: schema.priceQuotes.day }).from(schema.priceQuotes).where(eq(schema.priceQuotes.assetId, a.id)).all()) {
          if (!targetDays.has(q.day)) tx.update(schema.priceQuotes).set({ assetId: target.id }).where(eq(schema.priceQuotes.id, q.id)).run();
        }
        const patch: Partial<typeof schema.assets.$inferInsert> = {};
        if (!FEED_SOURCES.has(target.priceSource) && FEED_SOURCES.has(a.priceSource) && a.sourceId) {
          patch.priceSource = a.priceSource;
          patch.sourceId = a.sourceId;
        }
        if (target.name === target.symbol && name !== ticker.base) patch.name = name;
        if (!target.logoUrl && a.logoUrl) patch.logoUrl = a.logoUrl;
        if (!target.isin && a.isin) patch.isin = a.isin;
        const providerIds = { ...parseProviderIds(a.providerIds), ...parseProviderIds(target.providerIds) };
        if (Object.keys(providerIds).length > 0 && JSON.stringify(providerIds) !== target.providerIds) patch.providerIds = JSON.stringify(providerIds);
        if (Object.keys(patch).length > 0) tx.update(schema.assets).set(patch).where(eq(schema.assets.id, target.id)).run();
        tx.delete(schema.assets).where(eq(schema.assets.id, a.id)).run();
      });
      report.merged.push(`${a.symbol} → ${target.symbol} (#${target.id})`);
    } catch (e) {
      report.skipped.push(`${a.symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (report.merged.length) console.log(`[assets] samengevoegd: ${report.merged.join(", ")}`);
  if (report.renamed.length) console.log(`[assets] hernoemd: ${report.renamed.join(", ")}`);
  if (report.skipped.length) console.warn(`[assets] niet gerepareerd: ${report.skipped.join("; ")}`);
  return report;
}

/**
 * "Fysiek" werd tot september 2026 als vast platform meegeleverd. Sindsdien maak je zelf wallets met een eigen naam
 * (transactieformulier → "+ Nieuwe wallet toevoegen…"). De meegeleverde rij (type "other") verdwijnt zolang er geen
 * transactie of koppeling aan hangt; met data eraan is het gewoon gebruikersdata en blijft het staan.
 */
export function removeUnusedSeedWallet(db: Db): boolean {
  const row = db
    .select()
    .from(schema.platforms)
    .where(and(eq(schema.platforms.name, "Fysiek"), eq(schema.platforms.type, "other")))
    .get();
  if (!row) return false;
  const inUse =
    db.select({ id: schema.transactions.id }).from(schema.transactions).where(eq(schema.transactions.platformId, row.id)).limit(1).get() ??
    db.select({ id: schema.connections.id }).from(schema.connections).where(eq(schema.connections.platformId, row.id)).limit(1).get();
  if (inUse) return false;
  db.delete(schema.platforms).where(eq(schema.platforms.id, row.id)).run();
  return true;
}
