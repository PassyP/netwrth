import crypto from "node:crypto";
import { getSecret, setSecret, deleteSecret, masterKey } from "./secrets";

/**
 * Optionele wachtwoord-login. Zonder ingesteld wachtwoord is de app open (zoals voorheen).
 * - Het wachtwoord zelf wordt nooit opgeslagen: alleen een scrypt-hash met salt (secret "loginPassword").
 * - Na inloggen krijgt de browser een ondertekende cookie "<verlooptOp>.<hmac>". De HMAC-sleutel is afgeleid
 *   van de master key én de wachtwoord-hash, dus wijzigen/verwijderen van het wachtwoord maakt alle logins ongeldig.
 */

export const SESSION_COOKIE = "pm_session";
export const REMEMBER_MS = 90 * 24 * 60 * 60 * 1000; // "Ingelogd blijven"
export const SESSION_MS = 12 * 60 * 60 * 1000; // zonder vinkje: tot de browser sluit, maximaal 12 uur
export const MIN_PASSWORD_LENGTH = 6;

// ---------- wachtwoord-hash ----------

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [kind, saltB, hashB] = stored.split("$");
  if (kind !== "scrypt" || !saltB || !hashB) return false;
  const expected = Buffer.from(hashB, "base64");
  const actual = crypto.scryptSync(pw, Buffer.from(saltB, "base64"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// ---------- sessietoken ----------

function sign(key: Buffer, payload: string): string {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

export function signToken(key: Buffer, expiresAt: number): string {
  const payload = String(expiresAt);
  return `${payload}.${sign(key, payload)}`;
}

export function verifyToken(key: Buffer, token: string | null | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return false;
  const expected = Buffer.from(sign(key, payload));
  const actual = Buffer.from(mac);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function sessionKey(passwordHash: string): Buffer {
  return crypto.createHmac("sha256", masterKey()).update(`session:${passwordHash}`).digest();
}

// ---------- opslag ----------

function storedHash(): string | null {
  return getSecret("loginPassword");
}

export function isPasswordSet(): boolean {
  return !!storedHash();
}

export function checkPassword(pw: string): boolean {
  const h = storedHash();
  return !!h && verifyPassword(pw, h);
}

/** Zet het wachtwoord en maakt een nieuwe herstelcode; die wordt één keer teruggegeven om op te schrijven. */
export function setPassword(pw: string): string {
  setSecret("loginPassword", hashPassword(pw));
  return rotateRecoveryCode();
}

export function clearPassword() {
  deleteSecret("loginPassword");
  deleteSecret("loginRecovery");
}

// ---------- herstelcode ("Wachtwoord vergeten?") ----------

const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // zonder 0/O/1/I/L, tegen leesfouten

export function generateRecoveryCode(): string {
  const bytes = crypto.randomBytes(16);
  const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

/** Hoofdletters, zonder streepjes/spaties: "abcd 2345" en "ABCD-2345" zijn dezelfde code. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Nieuwe herstelcode opslaan (alleen de hash) en de leesbare code teruggeven. */
export function rotateRecoveryCode(): string {
  const code = generateRecoveryCode();
  setSecret("loginRecovery", hashPassword(normalizeRecoveryCode(code)));
  return code;
}

export function isRecoveryCodeSet(): boolean {
  return !!getSecret("loginRecovery");
}

export function checkRecoveryCode(code: string): boolean {
  const h = getSecret("loginRecovery");
  return !!h && verifyPassword(normalizeRecoveryCode(code), h);
}

export function createSessionToken(remember: boolean): string {
  const h = storedHash();
  if (!h) throw new Error("Geen wachtwoord ingesteld");
  return signToken(sessionKey(h), Date.now() + (remember ? REMEMBER_MS : SESSION_MS));
}

/** Toegang als er geen wachtwoord is, of als de cookie een geldig token bevat. */
export function isAuthorized(token: string | null | undefined): boolean {
  const h = storedHash();
  if (!h) return true;
  return verifyToken(sessionKey(h), token);
}

// ---------- cookies ----------

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

function isHttps(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim() === "https";
  return new URL(req.url).protocol === "https:";
}

/** Set-Cookie-header. Zonder "remember" een sessie-cookie (verdwijnt bij sluiten browser). */
export function sessionCookie(token: string, remember: boolean, req: Request): string {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (remember) parts.push(`Max-Age=${Math.floor(REMEMBER_MS / 1000)}`);
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ---------- brute-force-rem ----------

const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;
const fails = new Map<string, { count: number; until: number }>();

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}

/** Geeft het aantal seconden dat nog gewacht moet worden, of 0. */
export function lockedFor(ip: string, now = Date.now()): number {
  const f = fails.get(ip);
  if (!f || f.until <= now) return 0;
  return Math.ceil((f.until - now) / 1000);
}

export function registerFailure(ip: string, now = Date.now()) {
  const f = fails.get(ip);
  const expiredLock = !!f && f.until > 0 && f.until <= now; // na een afgelopen blokkade begint de telling opnieuw
  const count = (f && !expiredLock ? f.count : 0) + 1;
  if (count >= MAX_FAILS) fails.set(ip, { count: 0, until: now + LOCK_MS });
  else fails.set(ip, { count, until: 0 });
}

export function registerSuccess(ip: string) {
  fails.delete(ip);
}

export const failureDelay = () => new Promise((r) => setTimeout(r, 500));
