import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { CostMethod, DisplayCurrency } from "./calc/engine";

export const DEFAULT_BITCOIN_FALLBACK_URL = "https://mempool.space";

export interface AppSettings {
  displayCurrency: DisplayCurrency;
  costMethod: CostMethod;
  ignoreFx: boolean;
  hideDust: boolean; // posities onder de stofdrempel niet tonen (zie DUST_THRESHOLD)
  refreshTime: string; // HH:MM lokale tijd
  snapshotTime: string;
  notifyChannel: "app" | "push" | "ntfy";
  ntfyTopicUrl: string;
  timezone: string;
  bitcoinApiUrl: string; // Esplora/mempool-API van de eigen node (Umbrel mempool-app); leeg = niet ingesteld
  bitcoinFallbackEnabled: boolean; // bij een onbereikbare eigen node terugvallen op de publieke node hieronder
  bitcoinFallbackUrl: string; // publieke Esplora/mempool-API (standaard mempool.space); alleen gebruikt als de terugval aan staat
  walletSyncMinutes: number; // interval voor wallet-koppelingen; 0 = alleen bij verversen en de dagelijkse ronde
  priceRefreshMinutes: number; // interval voor de koersverversing (eToro, Kraken, Yahoo, FX, alerts); 0 = alleen de dagelijkse ronde en de knop Verversen
}

export const SETTING_KEYS: (keyof AppSettings)[] = [
  "displayCurrency",
  "costMethod",
  "ignoreFx",
  "hideDust",
  "refreshTime",
  "snapshotTime",
  "notifyChannel",
  "ntfyTopicUrl",
  "timezone",
  "bitcoinApiUrl",
  "bitcoinFallbackEnabled",
  "bitcoinFallbackUrl",
  "walletSyncMinutes",
  "priceRefreshMinutes",
];

export function getSettings(): AppSettings {
  const db = getDb();
  const rows = db.select().from(schema.settings).all();
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    displayCurrency: (map.displayCurrency as DisplayCurrency) || "EUR",
    costMethod: (map.costMethod as CostMethod) || "average",
    ignoreFx: map.ignoreFx === "true",
    hideDust: map.hideDust == null ? true : map.hideDust === "true", // standaard aan: restjes van een cent vervuilen de lijst
    refreshTime: map.refreshTime || "23:45",
    snapshotTime: map.snapshotTime || "23:59",
    notifyChannel: (map.notifyChannel as AppSettings["notifyChannel"]) || "app",
    ntfyTopicUrl: map.ntfyTopicUrl || "",
    timezone: map.timezone || "Europe/Amsterdam",
    // de UI-instelling wint; leeg → env (Umbrel-compose zet BITCOIN_API_URL) → niet ingesteld
    bitcoinApiUrl: map.bitcoinApiUrl || process.env.BITCOIN_API_URL || "",
    bitcoinFallbackEnabled: map.bitcoinFallbackEnabled === "true",
    bitcoinFallbackUrl: map.bitcoinFallbackUrl || DEFAULT_BITCOIN_FALLBACK_URL,
    walletSyncMinutes: map.walletSyncMinutes == null || map.walletSyncMinutes === "" ? 10 : Math.max(0, Math.floor(Number(map.walletSyncMinutes)) || 0),
    priceRefreshMinutes: map.priceRefreshMinutes == null || map.priceRefreshMinutes === "" ? 60 : Math.max(0, Math.floor(Number(map.priceRefreshMinutes)) || 0),
  };
}

export function setSetting(key: keyof AppSettings, value: string) {
  const db = getDb();
  const existing = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  if (existing) db.update(schema.settings).set({ value }).where(eq(schema.settings.key, key)).run();
  else db.insert(schema.settings).values({ key, value }).run();
}

/**
 * Waar de node-URL vandaan komt: door de gebruiker ingevuld, uit de omgeving (Umbrel-compose zet BITCOIN_API_URL) of
 * nergens. Een leeg veld laat de omgevingswaarde terugkomen; de instellingen tonen dat met een badge.
 */
export function bitcoinApiUrlSource(): "user" | "env" | "none" {
  const row = getDb().select().from(schema.settings).where(eq(schema.settings.key, "bitcoinApiUrl")).get();
  if (row?.value) return "user";
  return process.env.BITCOIN_API_URL ? "env" : "none";
}

/** Interne waarden in de settings-tabel die geen instelling zijn (niet via PATCH /api/settings te wijzigen). */
export type MetaKey = "lastBackupAt" | "attentionDismissed";

export function getMeta(key: MetaKey): string | null {
  return getDb().select().from(schema.settings).where(eq(schema.settings.key, key)).get()?.value ?? null;
}

export function setMeta(key: MetaKey, value: string) {
  const db = getDb();
  const existing = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  if (existing) db.update(schema.settings).set({ value }).where(eq(schema.settings.key, key)).run();
  else db.insert(schema.settings).values({ key, value }).run();
}

export function deleteMeta(key: MetaKey) {
  getDb().delete(schema.settings).where(eq(schema.settings.key, key)).run();
}
