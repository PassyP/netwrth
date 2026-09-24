import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// Alle bedragen/aantallen worden als decimale strings opgeslagen (geen floating point).

export const ASSET_CATEGORIES = ["crypto", "stock", "etf", "commodity", "real_estate"] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export const PRICE_SOURCES = ["etoro", "yahoo", "kraken", "manual", "none"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export const TX_TYPES = ["buy", "sell", "dividend", "interest", "staking", "fee", "deposit", "withdrawal", "transfer_in", "transfer_out"] as const;
export type TxType = (typeof TX_TYPES)[number];

export const CURRENCIES = ["EUR", "USD", "CHF", "GBP"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const portfolios = sqliteTable("portfolios", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});

export const platforms = sqliteTable("platforms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  type: text("type").notNull().default("broker"), // broker | exchange | wallet | other
});

export const assets = sqliteTable(
  "assets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull().$type<AssetCategory>(),
    currency: text("currency").notNull().$type<Currency>(),
    priceSource: text("price_source").notNull().$type<PriceSource>().default("manual"),
    sourceId: text("source_id"), // eToro instrumentId, Yahoo-symbool of Kraken-paarsleutel (bijv. XXBTZEUR)
    isin: text("isin"),
    exchange: text("exchange"),
    logoUrl: text("logo_url"),
    providerIds: text("provider_ids"), // JSON: { etoro: "1002", kraken: "XXBT" }
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("assets_symbol_currency_idx").on(t.symbol, t.currency)]
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    portfolioId: integer("portfolio_id").notNull().references(() => portfolios.id, { onDelete: "cascade" }),
    assetId: integer("asset_id").references(() => assets.id, { onDelete: "cascade" }), // null bij deposit/withdrawal/fee zonder asset
    platformId: integer("platform_id").notNull().references(() => platforms.id),
    type: text("type").notNull().$type<TxType>(),
    quantity: text("quantity").notNull().default("0"),
    price: text("price").notNull().default("0"), // per stuk; bij dividend/fee/deposit = totaalbedrag
    currency: text("currency").notNull().$type<Currency>(),
    fee: text("fee").notNull().default("0"),
    feeCurrency: text("fee_currency").$type<Currency>(),
    executedAt: text("executed_at").notNull(), // ISO UTC
    fxEur: text("fx_eur"), // 1 eenheid transactievaluta in EUR op transactiedatum
    fxUsd: text("fx_usd"), // 1 eenheid transactievaluta in USD op transactiedatum
    note: text("note"),
    source: text("source").notNull().default("manual"), // manual | csv | api
    externalId: text("external_id"),
    hash: text("hash"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("tx_portfolio_idx").on(t.portfolioId),
    index("tx_asset_idx").on(t.assetId),
    uniqueIndex("tx_hash_idx").on(t.hash),
  ]
);

export const priceQuotes = sqliteTable(
  "price_quotes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    assetId: integer("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    ts: text("ts").notNull(), // ISO UTC
    day: text("day").notNull(), // YYYY-MM-DD (voor dagslotkoersen)
    price: text("price").notNull(),
    currency: text("currency").notNull(),
    source: text("source").notNull(),
    previousClose: text("previous_close"),
  },
  (t) => [uniqueIndex("pq_asset_day_idx").on(t.assetId, t.day), index("pq_asset_ts_idx").on(t.assetId, t.ts)]
);

export const fxRates = sqliteTable(
  "fx_rates",
  {
    date: text("date").notNull(), // YYYY-MM-DD
    currency: text("currency").notNull(), // USD, CHF, GBP (ECB) en BTC (Yahoo BTC-EUR)
    ratePerEur: text("rate_per_eur").notNull(), // 1 EUR = x currency
    source: text("source").notNull().default("ECB"),
  },
  (t) => [primaryKey({ columns: [t.date, t.currency] })]
);

export const valuations = sqliteTable(
  "valuations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    assetId: integer("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    value: text("value").notNull(),
    currency: text("currency").notNull().$type<Currency>(),
    debt: text("debt").notNull().default("0"),
    note: text("note"),
  },
  (t) => [index("val_asset_idx").on(t.assetId)]
);

export const portfolioSnapshots = sqliteTable(
  "portfolio_snapshots",
  {
    portfolioId: integer("portfolio_id").notNull().references(() => portfolios.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    valueEur: text("value_eur").notNull(),
    valueUsd: text("value_usd").notNull(),
    investedEur: text("invested_eur").notNull(),
    investedUsd: text("invested_usd").notNull(),
  },
  (t) => [primaryKey({ columns: [t.portfolioId, t.date] })]
);

export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  assetId: integer("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  condition: text("condition").notNull(), // above | below
  threshold: text("threshold").notNull(),
  currency: text("currency").notNull().$type<Currency>(),
  status: text("status").notNull().default("active"), // active | triggered | off
  channel: text("channel").notNull().default("app"), // app | push | ntfy
  createdAt: text("created_at").notNull(),
  triggeredAt: text("triggered_at"),
  triggeredPrice: text("triggered_price"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const secrets = sqliteTable("secrets", {
  name: text("name").primaryKey(),
  encryptedValue: text("encrypted_value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  endpoint: text("endpoint").notNull().unique(),
  subscription: text("subscription").notNull(), // JSON
  createdAt: text("created_at").notNull(),
});

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
  readAt: text("read_at"),
});

export const PROVIDERS = ["etoro", "kraken", "bitcoin"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Adrestypes van een Bitcoin-account (BIP44 legacy, BIP49 nested SegWit, BIP84 native SegWit, BIP86 taproot). */
export const SCRIPT_TYPES = ["p2pkh", "p2sh-p2wpkh", "p2wpkh", "p2tr"] as const;
export type ScriptType = (typeof SCRIPT_TYPES)[number];

/** Gekoppeld platform (API-koppeling); de keys staan in `secrets` onder conn:<id>:apiKey / apiSecret. */
export const connections = sqliteTable("connections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull().$type<Provider>(),
  label: text("label").notNull(),
  platformId: integer("platform_id").notNull().references(() => platforms.id),
  portfolioId: integer("portfolio_id").notNull().references(() => portfolios.id),
  accountType: text("account_type").notNull().default("real"), // etoro: real | demo
  mode: text("mode").notNull().default("replace"), // replace | alongside
  /** wallet: kostprijs van een ontvangst zonder herkende tegenpartij — market (dagkoers) | none (0, telt niet als inleg) */
  receiptCost: text("receipt_cost").notNull().default("market"),
  status: text("status").notNull().default("never"), // never | ok | error | syncing
  lastSyncAt: text("last_sync_at"),
  lastError: text("last_error"),
  cursor: text("cursor"), // JSON, providerspecifiek (laatste trade-tijd, positie-snapshot, nonce)
  reconciliation: text("reconciliation"), // JSON: afstemmingsverschillen per asset
  createdAt: text("created_at").notNull(),
});

export const balances = sqliteTable(
  "balances",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    connectionId: integer("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
    currency: text("currency").notNull(), // EUR, USD, BTC, ...
    amount: text("amount").notNull(),
    hold: text("hold").notNull().default("0"),
    fetchedAt: text("fetched_at").notNull(),
  },
  (t) => [uniqueIndex("balances_conn_ccy_idx").on(t.connectionId, t.currency)]
);

/**
 * Account van een Bitcoin-wallet (watch-only): één extended public key per rij, geïnterpreteerd als één adrestype.
 * De xpub zelf staat versleuteld in `secrets` onder wallet:<id>:xpub; hier alleen identificatie en weergavevelden.
 * Adressen worden nooit opgeslagen; de scan begint elke sync opnieuw bij index 0.
 */
export const walletAccounts = sqliteTable(
  "wallet_accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    connectionId: integer("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(), // 8 hex, BIP32-fingerprint van de account-key (identificatie, niet geheim)
    scriptType: text("script_type").notNull().$type<ScriptType>(),
    label: text("label").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    receiveUsed: integer("receive_used").notNull().default(0), // hoogste gebruikte index + 1 op m/0/i (weergave)
    changeUsed: integer("change_used").notNull().default(0), // idem m/1/i
    txCount: integer("tx_count").notNull().default(0),
    balanceConfirmed: text("balance_confirmed").notNull().default("0"), // BTC, 8 decimalen
    balanceUnconfirmed: text("balance_unconfirmed").notNull().default("0"),
    lastScanAt: text("last_scan_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("wallet_accounts_conn_key_idx").on(t.connectionId, t.fingerprint, t.scriptType)]
);

export const syncRuns = sqliteTable("sync_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  connectionId: integer("connection_id").notNull().references(() => connections.id, { onDelete: "cascade" }),
  trigger: text("trigger").notNull().default("manual"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  ok: integer("ok", { mode: "boolean" }),
  created: integer("created").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  message: text("message"),
  /** JSON-array met de waarschuwingen van deze run (blijvend zichtbaar in het platformdetail) */
  warnings: text("warnings"),
});

export const jobRuns = sqliteTable("job_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  job: text("job").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  ok: integer("ok", { mode: "boolean" }),
  message: text("message"),
  /** JSON met details, bijv. { failed: [{ asset, assetId, error }] } bij een koersronde */
  details: text("details"),
});

export type Portfolio = typeof portfolios.$inferSelect;
export type Platform = typeof platforms.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type PriceQuote = typeof priceQuotes.$inferSelect;
export type FxRate = typeof fxRates.$inferSelect;
export type Valuation = typeof valuations.$inferSelect;
export type PortfolioSnapshot = typeof portfolioSnapshots.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type Balance = typeof balances.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;
export type WalletAccount = typeof walletAccounts.$inferSelect;
