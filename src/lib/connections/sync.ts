import crypto from "node:crypto";
import Decimal from "decimal.js";
import { and, desc, eq, lt, ne } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../db";
import { PROVIDERS, type Connection, type Provider, type Asset } from "../db/schema";
import { getSecret, setSecret, deleteSecret, maskSecret } from "../secrets";
import { fxForTransaction } from "../prices/fx";
import { latestQuote } from "../prices/quotes";
import { categoryClashMessage, findCategoryClash, findCryptoBySymbol, findNonCryptoAsset, upsertAsset, primeAssetPrice } from "../assets";
import { computePortfolio } from "../portfolio";
import { notify } from "../notify";
import type { ConnectionProvider, ConnectionContext, Credentials, NormalizedTx } from "./types";
import { krakenProvider } from "./kraken";
import { etoroProvider } from "./etoro";
import { bitcoinProvider } from "./bitcoin";
import { walletAccountInput, addWalletAccounts, listWalletAccounts, loadWalletAccountsWithKeys, deleteWalletSecrets, deleteWalletTransactions } from "./wallet-accounts";
import { parseExtendedPublicKey } from "../bitcoin/xpub";

const registry: Record<Provider, ConnectionProvider> = { kraken: krakenProvider, etoro: etoroProvider, bitcoin: bitcoinProvider };

export type SyncTrigger = "manual" | "scheduled" | "interval" | "initial";
/** Zo lang geldt een run zonder eindtijd als "loopt nog" (blokkeert een tweede sync van dezelfde koppeling). */
const SYNC_IN_FLIGHT_MS = 30 * 60 * 1000;
const SYNC_RUNS_KEEP = 100;
/** Zoveel waarschuwingen per run bewaren (een eerste Kraken-sync kan er honderden geven). */
const SYNC_WARNINGS_KEEP = 200;

export function getProvider(id: Provider): ConnectionProvider {
  return registry[id];
}

/** Providers voor de wizard; `credentials` bepaalt of de wizard keys vraagt ("keys") of accounts zoekt ("none", wallet). */
export function providerInfo() {
  return PROVIDERS.map((p) => ({
    id: p,
    label: registry[p].label,
    credentials: registry[p].credentials,
    keyLabels: registry[p].keyLabels ?? { apiKey: "", apiSecret: "" },
    helpUrl: registry[p].helpUrl,
  }));
}

export const connectionInput = z.object({
  provider: z.enum(PROVIDERS),
  label: z.string().trim().min(1).max(60),
  portfolioId: z.coerce.number().int().positive(),
  platformId: z.coerce.number().int().positive().optional(),
  accountType: z.enum(["real", "demo"]).default("real"),
  mode: z.enum(["replace", "alongside"]).default("replace"),
  apiKey: z.string().trim().min(4).max(500).optional(),
  apiSecret: z.string().trim().min(4).max(500).optional(),
  reuseEtoroKeys: z.boolean().optional(),
  /** Alleen wallets: kostprijs van een ontvangst zonder herkende tegenpartij (market = dagkoers, none = 0, geen inleg). */
  receiptCost: z.enum(["market", "none"]).default("market"),
  /** Alleen provider bitcoin: de accounts (xpub + adrestype) van de wallet. */
  accounts: z.array(walletAccountInput).min(1).max(50).optional(),
}).superRefine((v, ctx) => {
  if (v.provider === "bitcoin" && !v.accounts?.length) ctx.addIssue({ code: "custom", message: "Een Bitcoin-wallet heeft minstens één account (xpub) nodig.", path: ["accounts"] });
});
export type ConnectionInput = z.input<typeof connectionInput>;

function credsFor(conn: Connection): Credentials | null {
  if (getProvider(conn.provider).credentials === "none") return { apiKey: "", apiSecret: "" };
  const apiKey = getSecret(`conn:${conn.id}:apiKey`);
  const apiSecret = getSecret(`conn:${conn.id}:apiSecret`);
  if (apiKey && apiSecret) return { apiKey, apiSecret };
  if (conn.provider === "etoro") {
    const k = getSecret("etoroApiKey");
    const u = getSecret("etoroUserKey");
    if (k && u) return { apiKey: k, apiSecret: u };
  }
  return null;
}

/** Waarschuwingen van een sync-run (JSON-kolom); onleesbaar of leeg → []. */
export function parseWarnings(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function parseCursor(conn: Connection): Record<string, unknown> {
  try {
    return conn.cursor ? (JSON.parse(conn.cursor) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Platform van een koppeling: vast voor Kraken/eToro; een wallet krijgt een eigen platform met de naam van de koppeling
 * (type wallet), zodat afstemming, verwijderen en de allocatie per wallet apart blijven. Bestaat de naam al als
 * wallet/other-platform (handmatig bijgehouden transacties), dan wordt die hergebruikt — in vervang-modus verdwijnen
 * precies die handmatige boekingen. Een broker/exchange-platform wordt nooit gekaapt.
 */
const FIXED_PLATFORMS: Partial<Record<Provider, { name: string; type: string }>> = { kraken: { name: "Kraken", type: "exchange" }, etoro: { name: "eToro", type: "broker" } };

/** Welk platform een nieuwe koppeling zou krijgen, zonder iets aan te maken (zie ensurePlatform). */
export function previewPlatform(provider: Provider, label: string): { platformId: number | null; name: string; type: string } {
  const db = getDb();
  const fixed = FIXED_PLATFORMS[provider];
  const want = fixed ?? { name: label.trim() || "Wallet", type: "wallet" };
  const existing = db.select().from(schema.platforms).where(eq(schema.platforms.name, want.name)).get();
  if (!existing) return { platformId: null, name: want.name, type: want.type };
  if (fixed || existing.type === "wallet" || existing.type === "other") return { platformId: existing.id, name: existing.name, type: existing.type };
  const alt = `${want.name} (wallet)`;
  const other = db.select().from(schema.platforms).where(eq(schema.platforms.name, alt)).get();
  return other ? { platformId: other.id, name: other.name, type: other.type } : { platformId: null, name: alt, type: "wallet" };
}

function ensurePlatform(provider: Provider, label: string): number {
  const p = previewPlatform(provider, label);
  if (p.platformId != null) return p.platformId;
  return getDb().insert(schema.platforms).values({ name: p.name, type: p.type }).returning().get().id;
}

/** Hoeveel handmatige en geïmporteerde transacties "Vervangen" op dit platform in dit portfolio zou verwijderen. */
export function countReplaceable(platformId: number, portfolioId: number): number {
  return getDb()
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .where(and(eq(schema.transactions.platformId, platformId), eq(schema.transactions.portfolioId, portfolioId), ne(schema.transactions.source, "api")))
    .all().length;
}

/** Testen zonder op te slaan (wizard stap 3). */
export async function testCredentials(input: { provider: Provider; accountType?: string; apiKey?: string; apiSecret?: string; reuseEtoroKeys?: boolean }) {
  let creds: Credentials | null = null;
  if (getProvider(input.provider).credentials === "none") creds = { apiKey: "", apiSecret: "" };
  if (input.reuseEtoroKeys && input.provider === "etoro") {
    const k = getSecret("etoroApiKey");
    const u = getSecret("etoroUserKey");
    if (k && u) creds = { apiKey: k, apiSecret: u };
  }
  if (!creds && input.apiKey && input.apiSecret) creds = { apiKey: input.apiKey, apiSecret: input.apiSecret };
  if (!creds) return { ok: false, message: "Vul beide keys in." };
  const ctx: ConnectionContext = { id: 0, provider: input.provider, accountType: input.accountType ?? "real", cursor: {}, lastPrice: () => null, hasTransaction: () => false, log: () => undefined };
  return getProvider(input.provider).test(creds, ctx);
}

export function createConnection(raw: ConnectionInput): Connection {
  const input = connectionInput.parse(raw);
  const db = getDb();
  // ongeldige xpub → fout vóór er iets wordt aangemaakt
  if (input.provider === "bitcoin") for (const a of input.accounts ?? []) parseExtendedPublicKey(a.xpub);
  const platformId = input.platformId ?? ensurePlatform(input.provider, input.label);
  const conn = db
    .insert(schema.connections)
    .values({ provider: input.provider, label: input.label, platformId, portfolioId: input.portfolioId, accountType: input.accountType, mode: input.mode, receiptCost: input.receiptCost, status: "never", createdAt: new Date().toISOString() })
    .returning()
    .get();
  if (input.provider === "bitcoin" && input.accounts) addWalletAccounts(conn.id, input.accounts);
  if (input.apiKey && input.apiSecret && !(input.reuseEtoroKeys && input.provider === "etoro")) {
    setSecret(`conn:${conn.id}:apiKey`, input.apiKey);
    setSecret(`conn:${conn.id}:apiSecret`, input.apiSecret);
  }
  if (input.mode === "replace") {
    // handmatige en geïmporteerde transacties van dit platform in dit portfolio vervangen door de API-versie
    db.delete(schema.transactions)
      .where(and(eq(schema.transactions.platformId, platformId), eq(schema.transactions.portfolioId, input.portfolioId), ne(schema.transactions.source, "api")))
      .run();
  }
  return conn;
}

export function updateConnectionKeys(id: number, apiKey?: string, apiSecret?: string) {
  if (apiKey) setSecret(`conn:${id}:apiKey`, apiKey);
  if (apiSecret) setSecret(`conn:${id}:apiSecret`, apiSecret);
}

/** Heeft deze koppeling eigen keys (anders: eToro gebruikt de gedeelde koers-keys uit Koersbronnen)? */
export function hasOwnKeys(id: number): boolean {
  return !!getSecret(`conn:${id}:apiKey`) || !!getSecret(`conn:${id}:apiSecret`);
}

/** eToro-koppeling terug naar de gedeelde koers-keys: de eigen keys van de koppeling vervallen. */
export function switchToSharedKeys(id: number) {
  deleteSecret(`conn:${id}:apiKey`);
  deleteSecret(`conn:${id}:apiSecret`);
}

export function deleteConnection(id: number, deleteTransactions: boolean) {
  const db = getDb();
  const conn = db.select().from(schema.connections).where(eq(schema.connections.id, id)).get();
  if (!conn) return;
  if (deleteTransactions) {
    db.delete(schema.transactions).where(and(eq(schema.transactions.platformId, conn.platformId), eq(schema.transactions.portfolioId, conn.portfolioId), eq(schema.transactions.source, "api"))).run();
  }
  deleteSecret(`conn:${id}:apiKey`);
  deleteSecret(`conn:${id}:apiSecret`);
  if (conn.provider === "bitcoin") deleteWalletSecrets(id); // de rijen cascaden, de secrets niet
  db.delete(schema.connections).where(eq(schema.connections.id, id)).run();
}

/**
 * Na het aan-/uitzetten of verwijderen van een wallet-account: de netto boekingen golden voor een andere adresset, dus
 * alle on-chain boekingen van deze koppeling weg (inclusief minerfees), cursor en saldi leeg; de volgende sync boekt
 * alles opnieuw (dedupe en koers-cache maken dat goedkoop). Geeft het aantal verwijderde transacties terug.
 */
export function resetWalletBookings(connectionId: number): number {
  const db = getDb();
  const conn = db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).get();
  if (!conn || conn.provider !== "bitcoin") return 0;
  const n = deleteWalletTransactions(conn);
  db.delete(schema.balances).where(eq(schema.balances.connectionId, connectionId)).run();
  db.update(schema.connections).set({ cursor: null }).where(eq(schema.connections.id, connectionId)).run();
  const fresh = db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).get()!;
  db.update(schema.connections).set({ reconciliation: JSON.stringify(reconcile(fresh)) }).where(eq(schema.connections.id, connectionId)).run();
  return n;
}

export function listConnections() {
  const db = getDb();
  const platforms = new Map(db.select().from(schema.platforms).all().map((p) => [p.id, p.name]));
  const portfolios = new Map(db.select().from(schema.portfolios).all().map((p) => [p.id, p.name]));
  return db
    .select()
    .from(schema.connections)
    .all()
    .map((c, _i, all) => {
      const txCount = db.select().from(schema.transactions).where(and(eq(schema.transactions.platformId, c.platformId), eq(schema.transactions.source, "api"))).all().length;
      // wat "Koppeling verwijderen" met transacties zou wissen: alle API-transacties op dit platform in dit portfolio
      const apiTxCount = db.select({ id: schema.transactions.id }).from(schema.transactions).where(and(eq(schema.transactions.platformId, c.platformId), eq(schema.transactions.portfolioId, c.portfolioId), eq(schema.transactions.source, "api"))).all().length;
      const siblingIds = all.filter((o) => o.id !== c.id && o.platformId === c.platformId && o.portfolioId === c.portfolioId).map((o) => o.id);
      const balancesRows = db.select().from(schema.balances).where(eq(schema.balances.connectionId, c.id)).all();
      const lastRunRow = db.select().from(schema.syncRuns).where(eq(schema.syncRuns.connectionId, c.id)).orderBy(desc(schema.syncRuns.id)).limit(1).get() ?? null;
      const lastRun = lastRunRow ? { ...lastRunRow, warnings: parseWarnings(lastRunRow.warnings) } : null;
      const cursor = parseCursor(c);
      const nodeSource = c.provider === "bitcoin" && (cursor.source === "own" || cursor.source === "fallback") ? (cursor.source as "own" | "fallback") : null;
      let reconciliation: unknown = null;
      try {
        reconciliation = c.reconciliation ? JSON.parse(c.reconciliation) : null;
      } catch {
        /* leeg */
      }
      const accounts = c.provider === "bitcoin" ? listWalletAccounts(c.id) : [];
      const keys =
        c.provider === "bitcoin"
          ? { shared: false, present: accounts.length > 0, last4: null, updatedAt: null }
          : c.provider === "etoro" && !getSecret(`conn:${c.id}:apiKey`)
            ? { shared: true, ...maskSecret("etoroApiKey") }
            : { shared: false, ...maskSecret(`conn:${c.id}:apiKey`) };
      return {
        ...c,
        cursor: undefined,
        platformName: platforms.get(c.platformId) ?? "?",
        portfolioName: portfolios.get(c.portfolioId) ?? "?",
        providerLabel: registry[c.provider]?.label ?? c.provider,
        txCount,
        apiTxCount,
        siblingIds,
        nodeSource,
        balances: balancesRows,
        lastRun,
        reconciliation,
        keys,
        accounts,
      };
    });
}

function txHash(provider: Provider, externalId: string): string {
  return crypto.createHash("sha256").update(`${provider}|${externalId}`).digest("hex").slice(0, 32);
}

/**
 * Koersbron bij het koppelen van een bestaand asset: een hint van de provider vult alleen een ontbrekende bron in
 * ("manual" → yahoo/kraken/etoro). Een asset dat al een feed heeft (eToro, Kraken of Yahoo — door een eerdere sync óf
 * door de gebruiker gekozen) houdt die bron en zijn sourceId: de app kan niet zien of de gebruiker de bron bewust heeft
 * gekozen, en een sync mag die keuze nooit stilzwijgend terugdraaien. "none" wordt nooit aangeraakt.
 */
function fillsMissingSource(asset: Asset, hint: NormalizedTx["priceSource"]): hint is NonNullable<NormalizedTx["priceSource"]> {
  return !!hint && hint.source !== "manual" && asset.priceSource === "manual";
}

/**
 * Zoekt of maakt het asset voor een genormaliseerde transactie: via provider-id, dan voor crypto op symbool ongeacht
 * valuta (BTC blijft BTC over eToro en Kraken), anders op symbool+valuta en desnoods op symbool — maar nooit over de
 * grens crypto/niet-crypto heen. Bestaat symbool+valuta al aan de andere kant van die grens (het aandeel AMP/USD naast
 * de munt AMP, idem LINK, APE, COMP), dan wordt de transactie overgeslagen met een waarschuwing: upsertAsset zou die rij
 * anders van categorie, bron en naam laten wisselen en de bestaande transacties tegen de verkeerde koers waarderen.
 * Geeft null terug (met waarschuwing) als er geen asset is.
 */
function resolveAsset(provider: Provider, tx: NormalizedTx, created: Set<number>, warnings: string[]): Asset | null {
  if (!tx.symbol) {
    warnings.push(`Transactie ${tx.externalId} zonder asset overgeslagen.`);
    return null;
  }
  const db = getDb();
  const all = db.select().from(schema.assets).all();
  if (tx.providerAssetId) {
    const hit = all.find((a) => {
      try {
        const ids = a.providerIds ? (JSON.parse(a.providerIds) as Record<string, string>) : {};
        return ids[provider] === tx.providerAssetId;
      } catch {
        return false;
      }
    });
    if (hit) return hit;
  }
  const category = tx.category ?? "stock";
  const isCrypto = category === "crypto";
  let asset = isCrypto ? findCryptoBySymbol(tx.symbol) : findNonCryptoAsset(tx.symbol, tx.currency, true);
  if (!asset) {
    const currency = isCrypto ? "USD" : tx.currency;
    const clash = findCategoryClash(tx.symbol, currency, category);
    if (clash) {
      warnings.push(`Transactie ${tx.externalId} (${tx.symbol.toUpperCase()}) overgeslagen: ${categoryClashMessage(clash)}`);
      return null;
    }
    const priceSource = tx.priceSource?.source ?? "manual";
    asset = upsertAsset({
      symbol: tx.symbol,
      name: tx.assetName ?? tx.symbol,
      category,
      currency,
      priceSource,
      sourceId: tx.priceSource?.sourceId ?? null,
    });
    created.add(asset.id);
  }
  // provider-id vastleggen (samenvoegen met ids van andere providers)
  let ids: Record<string, string> = {};
  try {
    ids = asset.providerIds ? (JSON.parse(asset.providerIds) as Record<string, string>) : {};
  } catch {
    ids = {};
  }
  const patch: Partial<Asset> = {};
  if (tx.providerAssetId && ids[provider] !== tx.providerAssetId) {
    ids[provider] = tx.providerAssetId;
    patch.providerIds = JSON.stringify(ids);
  }
  // ontbrekende koersbron invullen; bij een nieuwe bron opnieuw koers en historie ophalen
  const hint = tx.priceSource;
  if (fillsMissingSource(asset, hint)) {
    patch.priceSource = hint.source;
    patch.sourceId = hint.sourceId;
    created.add(asset.id);
  }
  if (Object.keys(patch).length) {
    db.update(schema.assets).set(patch).where(eq(schema.assets.id, asset.id)).run();
    asset = { ...asset, ...patch };
  }
  return asset;
}

export interface SyncReport {
  connectionId: number;
  ok: boolean;
  created: number;
  skipped: number;
  warnings: string[];
  message: string;
  reconciliation: ReconciliationDiff[];
}

export interface ReconciliationDiff {
  symbol: string;
  assetId: number | null;
  computed: string;
  reported: string;
  diff: string;
}

/** Vergelijkt het berekende aantal per asset (transacties van dit platform) met de saldi van het platform. */
export function reconcile(conn: Connection): ReconciliationDiff[] {
  const db = getDb();
  const view = computePortfolio(conn.portfolioId);
  const computed = new Map<string, { qty: Decimal; assetId: number }>();
  for (const p of view.positions) {
    if (p.platformId !== conn.platformId) continue;
    const cur = computed.get(p.symbol);
    computed.set(p.symbol, { qty: (cur?.qty ?? new Decimal(0)).plus(p.quantity), assetId: p.assetId });
  }
  const rows = db.select().from(schema.balances).where(eq(schema.balances.connectionId, conn.id)).all();
  const diffs: ReconciliationDiff[] = [];
  const fiat = new Set(["EUR", "USD", "GBP", "CHF"]);
  const seen = new Set<string>();
  for (const b of rows) {
    if (fiat.has(b.currency)) continue; // kas wordt apart getoond
    seen.add(b.currency);
    const c = computed.get(b.currency);
    const reported = new Decimal(b.amount);
    const have = c?.qty ?? new Decimal(0);
    const diff = reported.minus(have);
    const tolerance = reported.abs().mul("0.0001").plus("0.00000001");
    if (diff.abs().gt(tolerance)) diffs.push({ symbol: b.currency, assetId: c?.assetId ?? null, computed: have.toFixed(8), reported: reported.toFixed(8), diff: diff.toFixed(8) });
  }
  for (const [symbol, c] of computed) {
    if (seen.has(symbol) || c.qty.abs().lt("0.00000001")) continue;
    if (conn.provider === "etoro") continue; // eToro geeft geen saldi per asset; posities zijn al de bron
    diffs.push({ symbol, assetId: c.assetId, computed: c.qty.toFixed(8), reported: "0.00000000", diff: c.qty.neg().toFixed(8) });
  }
  return diffs;
}

/** Voert één sync uit voor een koppeling. */
export async function runSync(connectionId: number, trigger: SyncTrigger = "manual"): Promise<SyncReport> {
  const db = getDb();
  const conn = db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).get();
  if (!conn) throw new Error("Koppeling niet gevonden.");
  // twee syncs tegelijk van dezelfde koppeling (interval-cron tijdens een lange eerste sync) zouden elkaars boekingen dubbel zien
  const lastRun = db.select().from(schema.syncRuns).where(eq(schema.syncRuns.connectionId, connectionId)).orderBy(desc(schema.syncRuns.id)).limit(1).get();
  if (lastRun && !lastRun.finishedAt && Date.now() - Date.parse(lastRun.startedAt) < SYNC_IN_FLIGHT_MS) throw new Error("Sync loopt nog; probeer het straks opnieuw.");
  const startedAt = new Date().toISOString();
  const run = db.insert(schema.syncRuns).values({ connectionId, trigger, startedAt }).returning().get();
  db.update(schema.connections).set({ status: "syncing" }).where(eq(schema.connections.id, connectionId)).run();
  const report: SyncReport = { connectionId, ok: false, created: 0, skipped: 0, warnings: [], message: "", reconciliation: [] };
  const finish = (ok: boolean, message: string) => {
    db.update(schema.syncRuns)
      .set({ finishedAt: new Date().toISOString(), ok, created: report.created, skipped: report.skipped, message, warnings: report.warnings.length ? JSON.stringify(report.warnings.slice(0, SYNC_WARNINGS_KEEP)) : null })
      .where(eq(schema.syncRuns.id, run.id))
      .run();
    db.update(schema.connections)
      .set({ status: ok ? "ok" : "error", lastError: ok ? null : message, ...(ok ? { lastSyncAt: new Date().toISOString() } : {}) })
      .where(eq(schema.connections.id, connectionId))
      .run();
    report.ok = ok;
    report.message = message;
    // geschiedenis begrensd: een wallet synct elke paar minuten
    const ids = db.select({ id: schema.syncRuns.id }).from(schema.syncRuns).where(eq(schema.syncRuns.connectionId, connectionId)).orderBy(desc(schema.syncRuns.id)).all();
    if (ids.length > SYNC_RUNS_KEEP) db.delete(schema.syncRuns).where(and(eq(schema.syncRuns.connectionId, connectionId), lt(schema.syncRuns.id, ids[SYNC_RUNS_KEEP - 1].id))).run();
  };

  try {
    const creds = credsFor(conn);
    if (!creds) throw new Error("Geen API-keys voor deze koppeling; vul ze in bij Bewerken.");
    const provider = getProvider(conn.provider);
    const ctx: ConnectionContext = {
      id: conn.id,
      provider: conn.provider,
      accountType: conn.accountType,
      cursor: parseCursor(conn),
      lastPrice: (symbol) => {
        const a = db.select().from(schema.assets).all().find((x) => x.symbol === symbol.toUpperCase());
        const q = a ? latestQuote(a.id) : null;
        return q ? { price: q.price, currency: q.currency } : null;
      },
      hasTransaction: (externalId) => !!db.select({ id: schema.transactions.id }).from(schema.transactions).where(eq(schema.transactions.hash, txHash(conn.provider, externalId))).get(),
      accounts: conn.provider === "bitcoin" ? loadWalletAccountsWithKeys(conn.id) : undefined,
      log: (m) => console.log(`[sync ${conn.provider}#${conn.id}] ${m}`),
    };
    const out = await provider.sync(creds, ctx);
    report.warnings.push(...out.warnings);

    const created = new Set<number>();
    // stabiele sortering: bij gelijke tijd blijft de volgorde van de provider staan (ontvangst vóór verzending in één blok)
    for (const tx of out.transactions.sort((a, b) => (a.executedAt < b.executedAt ? -1 : a.executedAt > b.executedAt ? 1 : 0))) {
      const hash = txHash(conn.provider, tx.externalId);
      const dup = db.select().from(schema.transactions).where(eq(schema.transactions.hash, hash)).get();
      if (dup) {
        report.skipped++;
        continue;
      }
      let assetId: number | null = null;
      if (["buy", "sell", "dividend", "interest", "staking", "transfer_in", "transfer_out"].includes(tx.type)) {
        const asset = resolveAsset(conn.provider, tx, created, report.warnings);
        if (!asset) {
          report.skipped++;
          continue;
        }
        assetId = asset.id;
      }
      let fx: { fxEur: string; fxUsd: string } | null = null;
      try {
        fx = await fxForTransaction(tx.currency, tx.executedAt);
      } catch (e) {
        report.warnings.push(`Geen wisselkoers voor ${tx.currency} op ${tx.executedAt.slice(0, 10)} (${e instanceof Error ? e.message : e}); wordt later aangevuld.`);
      }
      db.insert(schema.transactions)
        .values({
          portfolioId: conn.portfolioId,
          assetId,
          platformId: conn.platformId,
          type: tx.type,
          quantity: tx.quantity,
          price: tx.price,
          currency: tx.currency,
          fee: tx.fee,
          feeCurrency: tx.currency,
          executedAt: tx.executedAt,
          fxEur: fx?.fxEur ?? null,
          fxUsd: fx?.fxUsd ?? null,
          note: tx.note ?? null,
          source: "api",
          externalId: tx.externalId,
          hash,
          createdAt: new Date().toISOString(),
        })
        .run();
      report.created++;
    }

    // saldi
    const now = new Date().toISOString();
    db.delete(schema.balances).where(eq(schema.balances.connectionId, conn.id)).run();
    for (const b of out.balances) {
      db.insert(schema.balances).values({ connectionId: conn.id, currency: b.currency, amount: b.amount, hold: b.hold ?? "0", fetchedAt: now }).run();
    }
    db.update(schema.connections).set({ cursor: JSON.stringify(out.cursor) }).where(eq(schema.connections.id, conn.id)).run();
    for (const u of out.accounts ?? []) {
      db.update(schema.walletAccounts)
        .set({ receiveUsed: u.receiveUsed, changeUsed: u.changeUsed, txCount: u.txCount, balanceConfirmed: u.balanceConfirmed, balanceUnconfirmed: u.balanceUnconfirmed, lastScanAt: u.lastScanAt })
        .where(and(eq(schema.walletAccounts.id, u.id), eq(schema.walletAccounts.connectionId, conn.id)))
        .run();
    }

    // koersen voor nieuwe assets op de achtergrond
    for (const id of created) {
      const a = db.select().from(schema.assets).where(eq(schema.assets.id, id)).get();
      if (a) void primeAssetPrice(a);
    }

    // afstemming
    const fresh = db.select().from(schema.connections).where(eq(schema.connections.id, conn.id)).get()!;
    report.reconciliation = reconcile(fresh);
    db.update(schema.connections).set({ reconciliation: JSON.stringify(report.reconciliation) }).where(eq(schema.connections.id, conn.id)).run();

    const msg = `${report.created} nieuw, ${report.skipped} overgeslagen${report.reconciliation.length ? `, ${report.reconciliation.length} afstemmingsverschil(len)` : ""}${report.warnings.length ? `, ${report.warnings.length} waarschuwing(en)` : ""}`;
    finish(true, msg);
    // alleen melden als het verschil nieuw of anders is; een wallet synct elke paar minuten
    const previous = conn.reconciliation ?? "[]";
    if (report.reconciliation.length && trigger !== "initial" && JSON.stringify(report.reconciliation) !== previous) {
      await notify(`${conn.label}: afstemmingsverschil`, report.reconciliation.map((d) => `${d.symbol}: app ${d.computed}, platform ${d.reported}`).join("; "));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    finish(false, msg);
    // dagelijkse ronde: altijd melden; interval: alleen bij de overgang van ok naar fout
    if (trigger === "scheduled" || (trigger === "interval" && conn.status !== "error")) await notify(`${conn.label}: sync mislukt`, msg);
  }
  return report;
}

/** Alle koppelingen synchroniseren (dagelijkse ronde); fouten blokkeren de rest niet. */
export async function syncAll(trigger: "manual" | "scheduled" | "interval" = "scheduled", filter: { providers?: Provider[] } = {}): Promise<SyncReport[]> {
  const conns = getDb()
    .select()
    .from(schema.connections)
    .all()
    .filter((c) => !filter.providers || filter.providers.includes(c.provider));
  const out: SyncReport[] = [];
  for (const c of conns) {
    try {
      out.push(await runSync(c.id, trigger));
    } catch (e) {
      out.push({ connectionId: c.id, ok: false, created: 0, skipped: 0, warnings: [], message: e instanceof Error ? e.message : String(e), reconciliation: [] });
    }
  }
  return out;
}

/** Correctietransactie boeken voor een afstemmingsverschil (transfer_in/out zonder resultaat). */
export async function bookCorrection(connectionId: number, symbol: string): Promise<number> {
  const db = getDb();
  const conn = db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).get();
  if (!conn) throw new Error("Koppeling niet gevonden.");
  const diffs = reconcile(conn);
  const d = diffs.find((x) => x.symbol === symbol);
  if (!d) throw new Error("Geen verschil (meer) voor dit asset.");
  const asset = d.assetId ? db.select().from(schema.assets).where(eq(schema.assets.id, d.assetId)).get() : db.select().from(schema.assets).all().find((a) => a.symbol === symbol);
  if (!asset) throw new Error("Asset niet gevonden; maak het eerst aan via een transactie.");
  const diff = new Decimal(d.diff);
  const q = latestQuote(asset.id);
  const now = new Date().toISOString();
  const currency = q?.currency && ["EUR", "USD", "CHF", "GBP"].includes(q.currency) ? (q.currency as "EUR" | "USD" | "CHF" | "GBP") : "EUR";
  const fx = await fxForTransaction(currency, now).catch(() => null);
  const row = db
    .insert(schema.transactions)
    .values({
      portfolioId: conn.portfolioId,
      assetId: asset.id,
      platformId: conn.platformId,
      type: diff.gt(0) ? "transfer_in" : "transfer_out",
      quantity: diff.abs().toFixed(8),
      price: diff.gt(0) && q ? q.price : "0",
      currency,
      fee: "0",
      feeCurrency: currency,
      executedAt: now,
      fxEur: fx?.fxEur ?? null,
      fxUsd: fx?.fxUsd ?? null,
      note: `Correctie afstemming ${conn.label}: app ${d.computed}, platform ${d.reported}`,
      source: "manual",
      createdAt: now,
    })
    .returning()
    .get();
  const fresh = db.select().from(schema.connections).where(eq(schema.connections.id, conn.id)).get()!;
  db.update(schema.connections).set({ reconciliation: JSON.stringify(reconcile(fresh)) }).where(eq(schema.connections.id, conn.id)).run();
  return row.id;
}
