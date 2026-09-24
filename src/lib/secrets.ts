import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, schema, dataDir } from "./db";

/**
 * Geheimen (eToro-keys, VAPID-keys) staan versleuteld in de database (AES-256-GCM).
 * De sleutel wordt bij de eerste start aangemaakt in <DATA_DIR>/secret.key (of via env APP_SECRET).
 */
export function masterKey(): Buffer {
  if (process.env.APP_SECRET) return crypto.createHash("sha256").update(process.env.APP_SECRET).digest();
  const file = path.join(dataDir(), "secret.key");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

export function decrypt(payload: string): string {
  const [ivB, tagB, encB] = payload.split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encB, "base64")), decipher.final()]).toString("utf8");
}

export type SecretName = "etoroApiKey" | "etoroUserKey" | "vapidPublicKey" | "vapidPrivateKey" | "loginPassword" | "loginRecovery" | `conn:${number}:${"apiKey" | "apiSecret"}` | `wallet:${number}:xpub`;

export function getSecret(name: SecretName): string | null {
  const row = getDb().select().from(schema.secrets).where(eq(schema.secrets.name, name)).get();
  if (!row) return null;
  try {
    return decrypt(row.encryptedValue);
  } catch {
    return null;
  }
}

export function setSecret(name: SecretName, value: string) {
  const db = getDb();
  const now = new Date().toISOString();
  const encryptedValue = encrypt(value);
  const existing = db.select().from(schema.secrets).where(eq(schema.secrets.name, name)).get();
  if (existing) db.update(schema.secrets).set({ encryptedValue, updatedAt: now }).where(eq(schema.secrets.name, name)).run();
  else db.insert(schema.secrets).values({ name, encryptedValue, updatedAt: now }).run();
}

export function deleteSecret(name: SecretName) {
  getDb().delete(schema.secrets).where(eq(schema.secrets.name, name)).run();
}

/** Alleen de laatste vier tekens, voor weergave. */
export function maskSecret(name: SecretName): { present: boolean; last4: string | null; updatedAt: string | null } {
  const row = getDb().select().from(schema.secrets).where(eq(schema.secrets.name, name)).get();
  if (!row) return { present: false, last4: null, updatedAt: null };
  const v = getSecret(name);
  return { present: !!v, last4: v ? v.slice(-4) : null, updatedAt: row.updatedAt };
}
