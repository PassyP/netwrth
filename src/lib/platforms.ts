/**
 * Platforms en wallets: brokers, exchanges en eigen wallets (Ledger, kluis, …) waar transacties op staan.
 * Namen zijn uniek zonder onderscheid in hoofdletters; verwijderen kan alleen als er niets meer aan hangt, tenzij
 * expliciet gevraagd wordt om alles wat eraan hangt mee te verwijderen (transacties én koppelingen met hun keys/xpubs).
 */
import { count, eq, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import { ApiError } from "./errors";
import { deleteConnection } from "./connections/sync";

export const PLATFORM_TYPES = ["broker", "exchange", "wallet", "other"] as const;
export type PlatformType = (typeof PLATFORM_TYPES)[number];

export interface PlatformRow {
  id: number;
  name: string;
  type: string;
  /** transacties op dit platform */
  txCount: number;
  /** API-koppelingen (eToro, Kraken) die op dit platform boeken */
  connectionCount: number;
}

function countBy(table: typeof schema.transactions | typeof schema.connections): Map<number, number> {
  const rows = getDb().select({ platformId: table.platformId, n: count() }).from(table).groupBy(table.platformId).all();
  return new Map(rows.map((r) => [r.platformId, Number(r.n)]));
}

function usage(id: number): { txCount: number; connectionCount: number } {
  return { txCount: countBy(schema.transactions).get(id) ?? 0, connectionCount: countBy(schema.connections).get(id) ?? 0 };
}

function findDuplicate(name: string, exceptId?: number) {
  const wanted = name.trim().toLowerCase();
  return getDb()
    .select()
    .from(schema.platforms)
    .all()
    .find((p) => p.id !== exceptId && p.name.toLowerCase() === wanted);
}

function get(id: number) {
  const row = getDb().select().from(schema.platforms).where(eq(schema.platforms.id, id)).get();
  if (!row) throw new ApiError("Platform niet gevonden.", 404);
  return row;
}

/** Alle platforms, gesorteerd op naam zonder onderscheid in hoofdletters, met hoeveel eraan hangt. */
export function listPlatforms(): PlatformRow[] {
  const rows = getDb()
    .select()
    .from(schema.platforms)
    .orderBy(sql`lower(${schema.platforms.name})`)
    .all();
  const tx = countBy(schema.transactions);
  const conn = countBy(schema.connections);
  return rows.map((p) => ({ ...p, txCount: tx.get(p.id) ?? 0, connectionCount: conn.get(p.id) ?? 0 }));
}

export function createPlatform(input: { name: string; type: PlatformType }) {
  const dup = findDuplicate(input.name);
  if (dup) throw new ApiError(`Er bestaat al een platform met de naam "${dup.name}".`, 409);
  return getDb().insert(schema.platforms).values({ name: input.name.trim(), type: input.type }).returning().get();
}

export function updatePlatform(id: number, patch: { name?: string; type?: PlatformType }) {
  get(id);
  const values: { name?: string; type?: PlatformType } = {};
  if (patch.name !== undefined) {
    const dup = findDuplicate(patch.name, id);
    if (dup) throw new ApiError(`Er bestaat al een platform met de naam "${dup.name}".`, 409);
    values.name = patch.name.trim();
  }
  if (patch.type !== undefined) values.type = patch.type;
  if (Object.keys(values).length) getDb().update(schema.platforms).set(values).where(eq(schema.platforms.id, id)).run();
  return get(id);
}

/**
 * Verwijdert het platform. Zonder `withEverything` weigert het (409) zolang er transacties of koppelingen aan hangen;
 * mét verwijdert het eerst de koppelingen (inclusief keys/xpubs en hun API-transacties) en daarna álle transacties van
 * het platform, ook alleen-lezen API-transacties en die in andere portfolios. Geeft terug hoeveel er weg is.
 */
export function deletePlatform(id: number, opts: { withEverything?: boolean } = {}): { transactions: number; connections: number } {
  const row = get(id);
  const { txCount, connectionCount } = usage(id);
  if ((txCount || connectionCount) && !opts.withEverything) {
    const parts: string[] = [];
    if (txCount) parts.push(`${txCount} transactie${txCount === 1 ? "" : "s"}`);
    if (connectionCount) parts.push(`${connectionCount} koppeling${connectionCount === 1 ? "" : "en"}`);
    throw new ApiError(`"${row.name}" heeft nog ${parts.join(" en ")}. Verplaats of verwijder die eerst.`, 409);
  }
  const db = getDb();
  return db.transaction(() => {
    const conns = db.select().from(schema.connections).where(eq(schema.connections.platformId, id)).all();
    // eerst tellen: deleteConnection(…, true) neemt de API-transacties al mee, die horen ook in het totaal
    const total = usage(id).txCount;
    for (const c of conns) deleteConnection(c.id, true);
    db.delete(schema.transactions).where(eq(schema.transactions.platformId, id)).run();
    db.delete(schema.platforms).where(eq(schema.platforms.id, id)).run();
    return { transactions: total, connections: conns.length };
  });
}
