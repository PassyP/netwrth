import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";
import * as schema from "./schema";
import { eq } from "drizzle-orm";
import { removeUnusedSeedWallet, repairYahooCryptoSymbols } from "./repair";

export type Db = BetterSQLite3Database<typeof schema>;

export function dataDir(): string {
  const dir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function migrationsFolder(): string {
  const candidates = [
    path.join(process.cwd(), "drizzle"),
    path.join(process.cwd(), "..", "drizzle"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[0];
}

function seed(db: Db) {
  const now = new Date().toISOString();
  // Eigen wallets (Ledger, kluis, …) maak je zelf aan via "+ Nieuwe wallet toevoegen…" in het transactieformulier.
  const defaults = [
    { name: "eToro", type: "broker" },
    { name: "Swissquote", type: "broker" },
  ];
  for (const p of defaults) {
    const existing = db.select().from(schema.platforms).where(eq(schema.platforms.name, p.name)).get();
    if (!existing) db.insert(schema.platforms).values(p).run();
  }
  const anyPortfolio = db.select().from(schema.portfolios).limit(1).get();
  if (!anyPortfolio) {
    db.insert(schema.portfolios).values({ name: "Mijn portfolio", createdAt: now }).run();
  }
  const settingDefaults: Record<string, string> = {
    displayCurrency: "EUR",
    costMethod: "average",
    ignoreFx: "false",
    hideDust: "true",
    refreshTime: "23:45",
    snapshotTime: "23:59",
    notifyChannel: "app",
    ntfyTopicUrl: "",
    timezone: "Europe/Amsterdam",
    bitcoinApiUrl: "", // leeg: getSettings valt terug op env BITCOIN_API_URL
    bitcoinFallbackEnabled: "false",
    bitcoinFallbackUrl: "https://mempool.space",
    walletSyncMinutes: "10",
  };
  for (const [key, value] of Object.entries(settingDefaults)) {
    const existing = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    if (!existing) db.insert(schema.settings).values({ key, value }).run();
  }
}

function open(): Db {
  const file = path.join(dataDir(), "portfolio.db");
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });
  seed(db);
  repairYahooCryptoSymbols(db); // BTC-USD naast BTC (Yahoo-ticker als symbool) samenvoegen of hernoemen
  removeUnusedSeedWallet(db); // het vroeger meegeleverde "Fysiek" weg zolang er niets aan hangt
  return db;
}

const g = globalThis as unknown as { __pmDb?: Db };

export function getDb(): Db {
  if (!g.__pmDb) g.__pmDb = open();
  return g.__pmDb;
}

export { schema };
