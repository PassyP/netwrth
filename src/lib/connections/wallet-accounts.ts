/**
 * Accounts van een Bitcoin-wallet-koppeling: databaserijen (weergave, aan/uit) plus de xpub versleuteld in `secrets`
 * onder wallet:<accountId>:xpub. Alleen opslag; het opnieuw boeken na een wijziging staat in sync.ts
 * (resetWalletBookings), want de netto boekingen gelden voor de hele adresset van de koppeling.
 */
import { and, eq, like } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../db";
import { SCRIPT_TYPES, type Connection, type WalletAccount } from "../db/schema";
import { deleteSecret, getSecret, setSecret } from "../secrets";
import { parseExtendedPublicKey } from "../bitcoin/xpub";
import type { WalletAccountWithKey } from "./types";

export const walletAccountInput = z.object({
  xpub: z.string().trim().min(100).max(120),
  scriptType: z.enum(SCRIPT_TYPES),
  label: z.string().trim().min(1).max(60),
  enabled: z.boolean().default(true),
});
export type WalletAccountInput = z.input<typeof walletAccountInput>;

export function listWalletAccounts(connectionId: number): WalletAccount[] {
  return getDb().select().from(schema.walletAccounts).where(eq(schema.walletAccounts.connectionId, connectionId)).orderBy(schema.walletAccounts.id).all();
}

/** Met ontsleutelde xpub, voor de sync. Een account zonder secret (hoort niet voor te komen) wordt overgeslagen. */
export function loadWalletAccountsWithKeys(connectionId: number): WalletAccountWithKey[] {
  const out: WalletAccountWithKey[] = [];
  for (const a of listWalletAccounts(connectionId)) {
    const xpub = getSecret(`wallet:${a.id}:xpub`);
    if (!xpub) {
      console.warn(`[wallet] account #${a.id}: xpub ontbreekt in secrets; overgeslagen`);
      continue;
    }
    out.push({ id: a.id, label: a.label, scriptType: a.scriptType, enabled: a.enabled, xpub });
  }
  return out;
}

/** Valideert alle sleutels vóór er iets wordt geschreven; een dubbele (zelfde key én adrestype) wordt overgeslagen. */
export function addWalletAccounts(connectionId: number, inputs: WalletAccountInput[]): { added: number; skipped: number } {
  const db = getDb();
  const parsed = inputs.map((i) => {
    const input = walletAccountInput.parse(i);
    return { input, key: parseExtendedPublicKey(input.xpub) };
  });
  let added = 0;
  let skipped = 0;
  db.transaction((tx) => {
    for (const { input, key } of parsed) {
      const dup = tx
        .select()
        .from(schema.walletAccounts)
        .where(and(eq(schema.walletAccounts.connectionId, connectionId), eq(schema.walletAccounts.fingerprint, key.fingerprint), eq(schema.walletAccounts.scriptType, input.scriptType)))
        .get();
      if (dup) {
        skipped++;
        continue;
      }
      const row = tx
        .insert(schema.walletAccounts)
        .values({ connectionId, fingerprint: key.fingerprint, scriptType: input.scriptType, label: input.label, enabled: input.enabled, createdAt: new Date().toISOString() })
        .returning()
        .get();
      setSecret(`wallet:${row.id}:xpub`, input.xpub);
      added++;
    }
  });
  return { added, skipped };
}

/** Label of aan/uit wijzigen. Geeft terug of de adresset veranderde (dan moet de koppeling opnieuw boeken). */
export function updateWalletAccount(connectionId: number, id: number, patch: { label?: string; enabled?: boolean }): { account: WalletAccount; enabledChanged: boolean } {
  const db = getDb();
  const current = db.select().from(schema.walletAccounts).where(and(eq(schema.walletAccounts.id, id), eq(schema.walletAccounts.connectionId, connectionId))).get();
  if (!current) throw new Error("Account niet gevonden.");
  const set: Partial<WalletAccount> = {};
  if (patch.label !== undefined) set.label = patch.label.trim().slice(0, 60) || current.label;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (Object.keys(set).length) db.update(schema.walletAccounts).set(set).where(eq(schema.walletAccounts.id, id)).run();
  const account = db.select().from(schema.walletAccounts).where(eq(schema.walletAccounts.id, id)).get()!;
  return { account, enabledChanged: patch.enabled !== undefined && patch.enabled !== current.enabled };
}

/** Verwijdert rij én secret. Geeft terug of het account meedeed (dan moet de koppeling opnieuw boeken). */
export function removeWalletAccount(connectionId: number, id: number): { removed: boolean; wasEnabled: boolean } {
  const db = getDb();
  const current = db.select().from(schema.walletAccounts).where(and(eq(schema.walletAccounts.id, id), eq(schema.walletAccounts.connectionId, connectionId))).get();
  if (!current) return { removed: false, wasEnabled: false };
  deleteSecret(`wallet:${id}:xpub`);
  db.delete(schema.walletAccounts).where(eq(schema.walletAccounts.id, id)).run();
  return { removed: true, wasEnabled: current.enabled };
}

/** Bij het verwijderen van de koppeling: de rijen cascaden, de secrets niet. */
export function deleteWalletSecrets(connectionId: number) {
  for (const a of listWalletAccounts(connectionId)) deleteSecret(`wallet:${a.id}:xpub`);
}

/** Alle door deze koppeling geboekte on-chain transacties (externalId btc:<id>:…), inclusief de minerfees. */
export function deleteWalletTransactions(conn: Connection): number {
  const db = getDb();
  const rows = db
    .delete(schema.transactions)
    .where(and(eq(schema.transactions.platformId, conn.platformId), eq(schema.transactions.portfolioId, conn.portfolioId), eq(schema.transactions.source, "api"), like(schema.transactions.externalId, `btc:${conn.id}:%`)))
    .returning({ id: schema.transactions.id })
    .all();
  return rows.length;
}
