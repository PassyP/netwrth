import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "./db";
import { CURRENCIES, TX_TYPES, type Transaction } from "./db/schema";
import { fxForTransaction } from "./prices/fx";

const decimalString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).replace(",", ".").trim())
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v), "geen geldig getal");

export const transactionInput = z.object({
  portfolioId: z.coerce.number().int().positive(),
  assetId: z.coerce.number().int().positive().nullable().optional(),
  platformId: z.coerce.number().int().positive(),
  type: z.enum(TX_TYPES),
  quantity: decimalString.default("0"),
  price: decimalString.default("0"),
  currency: z.enum(CURRENCIES),
  fee: decimalString.default("0"),
  executedAt: z.string().min(10), // ISO of "YYYY-MM-DDTHH:mm"
  note: z.string().max(1000).nullable().optional(),
  source: z.enum(["manual", "csv", "api"]).default("manual"),
  externalId: z.string().max(200).nullable().optional(),
});
export type TransactionInput = z.infer<typeof transactionInput>;

function normalizeDate(s: string): string {
  const d = new Date(s);
  if (isNaN(d.getTime())) throw new Error(`Ongeldige datum: ${s}`);
  return d.toISOString();
}

export function importHash(i: Pick<TransactionInput, "portfolioId" | "assetId" | "platformId" | "type" | "quantity" | "price" | "currency" | "executedAt" | "externalId">): string {
  const s = [i.portfolioId, i.assetId ?? "", i.platformId, i.type, i.quantity, i.price, i.currency, normalizeDate(i.executedAt), i.externalId ?? ""].join("|");
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);
}

export async function createTransaction(raw: TransactionInput): Promise<Transaction> {
  const input = transactionInput.parse(raw);
  const executedAt = normalizeDate(input.executedAt);
  const needsAsset = ["buy", "sell", "transfer_in", "transfer_out"];
  if (needsAsset.includes(input.type) && !input.assetId) throw new Error("Aankoop, verkoop of overboeking heeft een asset nodig.");
  if (needsAsset.includes(input.type) && Number(input.quantity) <= 0) throw new Error("Aantal moet groter dan 0 zijn.");
  const fx = await fxForTransaction(input.currency, executedAt);
  const hash = input.source === "manual" ? null : importHash({ ...input, executedAt });
  const db = getDb();
  if (hash) {
    const dup = db.select().from(schema.transactions).where(eq(schema.transactions.hash, hash)).get();
    if (dup) throw new DuplicateTransactionError(dup.id);
  }
  return db
    .insert(schema.transactions)
    .values({
      portfolioId: input.portfolioId,
      assetId: input.assetId ?? null,
      platformId: input.platformId,
      type: input.type,
      quantity: input.quantity,
      price: input.price,
      currency: input.currency,
      fee: input.fee,
      feeCurrency: input.currency,
      executedAt,
      fxEur: fx.fxEur,
      fxUsd: fx.fxUsd,
      note: input.note ?? null,
      source: input.source,
      externalId: input.externalId ?? null,
      hash,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

export class DuplicateTransactionError extends Error {
  existingId: number;
  constructor(id: number) {
    super(`Transactie bestaat al (id ${id}).`);
    this.existingId = id;
  }
}

export async function updateTransaction(id: number, raw: Partial<TransactionInput>): Promise<Transaction> {
  const db = getDb();
  const existing = db.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get();
  if (!existing) throw new Error("Transactie niet gevonden.");
  if (existing.source === "api") throw new Error("Deze transactie komt uit een API-koppeling en is alleen-lezen; boek een correctie of pas de koppeling aan.");
  const merged = transactionInput.parse({ ...existing, ...raw, executedAt: raw.executedAt ?? existing.executedAt });
  const executedAt = normalizeDate(merged.executedAt);
  const fx = await fxForTransaction(merged.currency, executedAt);
  db.update(schema.transactions)
    .set({
      portfolioId: merged.portfolioId,
      assetId: merged.assetId ?? null,
      platformId: merged.platformId,
      type: merged.type,
      quantity: merged.quantity,
      price: merged.price,
      currency: merged.currency,
      fee: merged.fee,
      feeCurrency: merged.currency,
      executedAt,
      fxEur: fx.fxEur,
      fxUsd: fx.fxUsd,
      note: merged.note ?? null,
    })
    .where(eq(schema.transactions.id, id))
    .run();
  return db.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get()!;
}

export function deleteTransaction(id: number) {
  const db = getDb();
  const existing = db.select().from(schema.transactions).where(eq(schema.transactions.id, id)).get();
  if (existing?.source === "api") throw new Error("Deze transactie komt uit een API-koppeling en is alleen-lezen; verwijder de koppeling om de transacties te verwijderen.");
  db.delete(schema.transactions).where(eq(schema.transactions.id, id)).run();
}

/** Wisselkoersen van transacties (opnieuw) invullen, bijv. na een offline periode. */
export async function refillMissingFx(): Promise<number> {
  const db = getDb();
  const rows = db.select().from(schema.transactions).all().filter((t) => t.fxEur == null || t.fxUsd == null);
  let n = 0;
  for (const t of rows) {
    try {
      const fx = await fxForTransaction(t.currency, t.executedAt);
      db.update(schema.transactions).set({ fxEur: fx.fxEur, fxUsd: fx.fxUsd }).where(eq(schema.transactions.id, t.id)).run();
      n++;
    } catch {
      /* later opnieuw */
    }
  }
  return n;
}
