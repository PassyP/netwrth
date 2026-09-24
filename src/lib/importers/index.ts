import * as XLSX from "xlsx";
import { getDb, schema } from "../db";
import { eq } from "drizzle-orm";
import { ASSET_CATEGORIES, TX_TYPES, type AssetCategory, type Currency, type PriceSource, type TxType } from "../db/schema";
import { categoryClashMessage, findAssetByIsin, findCategoryClash, findCryptoBySymbol, findNonCryptoAsset, upsertAsset, primeAssetPrice } from "../assets";
import { createTransaction, DuplicateTransactionError } from "../transactions";

export interface ParsedSheet {
  sheetName: string;
  headers: string[];
  rows: Record<string, string>[];
}

export type ImportProfile = "swissquote-positions" | "generic";

export interface ImportDraft {
  rowIndex: number;
  type: TxType;
  symbol: string;
  isin: string | null;
  name: string | null;
  quantity: string;
  price: string;
  currency: Currency;
  fee: string;
  executedAt: string; // ISO
  category: AssetCategory;
  note: string | null;
  externalId: string | null;
  existingAssetId: number | null;
  warning: string | null;
}

export interface ColumnMapping {
  date?: string;
  type?: string;
  symbol?: string;
  isin?: string;
  name?: string;
  quantity?: string;
  price?: string;
  currency?: string;
  fee?: string;
  note?: string;
  defaultType?: TxType;
  defaultCurrency?: Currency;
  defaultCategory?: AssetCategory;
}

function cell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

export function parseSpreadsheet(buf: Buffer, filename: string): ParsedSheet {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true, raw: false });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: "" });
  if (matrix.length === 0) return { sheetName, headers: [], rows: [] };
  // kopregel = eerste rij met minstens 3 gevulde cellen
  let headerIdx = matrix.findIndex((r) => r.filter((c) => cell(c) !== "").length >= 3);
  if (headerIdx < 0) headerIdx = 0;
  const rawHeaders = matrix[headerIdx].map((h, i) => cell(h) || `kolom${i + 1}`);
  const rows: Record<string, string>[] = [];
  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const r = matrix[i];
    const obj: Record<string, string> = {};
    let filled = 0;
    rawHeaders.forEach((h, j) => {
      const v = cell(r[j]);
      obj[h] = v;
      if (v !== "") filled++;
    });
    if (filled > 0) rows.push(obj);
  }
  void filename;
  return { sheetName, headers: rawHeaders, rows };
}

/**
 * Swissquote herkennen aan de vaste kolomnamen van de positie-export. ISIN telt daar niet in mee: die kolom staat er
 * niet altijd bij (bijv. een export met alleen aandelen), en zonder herkenning valt het bestand terug op de generieke
 * kolommapping — die kent de datum uit de bestandsnaam niet en houdt de sectie- en totaalregels voor posities, waardoor
 * er niets bruikbaars overblijft. "Unit cost" samen met "CCY" is specifiek genoeg voor Swissquote.
 */
export function detectProfile(headers: string[]): ImportProfile {
  const h = headers.map((x) => x.toLowerCase());
  if (h.includes("symbol") && h.includes("quantity") && h.includes("unit cost") && h.includes("ccy")) return "swissquote-positions";
  return "generic";
}

/** Datum/tijd uit de Swissquote-bestandsnaam: Positions_1234567_2026_01_15_09_30.xlsx (lokale tijd). */
export function dateFromFilename(filename: string): string | null {
  const m = filename.match(/(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})/);
  if (!m) return null;
  return localToIso(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

/** Lokale tijd (Europe/Amsterdam) naar ISO UTC. */
export function localToIso(y: number, mo: number, d: number, h: number, mi: number, tz = "Europe/Amsterdam"): string {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asLocal = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
  const offset = asLocal - guess;
  return new Date(guess - offset).toISOString();
}

function num(v: string): string {
  const s = v.replace(/\s/g, "").replace(/'/g, "");
  // 1.234,56 → 1234.56 ; 1,234.56 → 1234.56
  if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) return s.replace(/\./g, "").replace(",", ".");
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return s.replace(/,/g, "");
  return s.replace(",", ".");
}

/**
 * Bestaand asset voor een importregel: op ISIN, voor crypto op symbool ongeacht valuta (één BTC), anders op symbool+valuta —
 * nooit over de grens crypto/niet-crypto heen (de aandelenregel AMP/USD hoort niet bij de munt AMP; commitImport meldt
 * die botsing als fout in plaats van de rij te laten omslaan).
 */
function lookupExisting(symbol: string, isin: string | null, currency: string, category: AssetCategory): number | null {
  if (isin) {
    const a = findAssetByIsin(isin);
    if (a) return a.id;
  }
  if (category === "crypto") return findCryptoBySymbol(symbol)?.id ?? null;
  return findNonCryptoAsset(symbol, currency)?.id ?? null;
}

export function swissquotePositionsToDrafts(sheet: ParsedSheet, filename: string): ImportDraft[] {
  const executedAt = dateFromFilename(filename) ?? new Date().toISOString();
  const drafts: ImportDraft[] = [];
  let currentCategory: AssetCategory = "etf";
  sheet.rows.forEach((r, idx) => {
    const first = cell(r[sheet.headers[0]]);
    const symbol = cell(r["Symbol"]);
    if (!symbol && first) {
      const f = first.toLowerCase();
      if (f.includes("etf")) currentCategory = "etf";
      else if (f.includes("crypto")) currentCategory = "crypto";
      else if (f.includes("stock") || f.includes("share") || f.includes("equit")) currentCategory = "stock";
      else if (f.includes("fund")) currentCategory = "etf";
      return;
    }
    // "Total" en de subtotaalregel per sectie ("Shares subtotal in EUR") zijn geen posities
    const lower = symbol.toLowerCase();
    if (!symbol || lower === "total" || lower.includes("subtotal")) return;
    const quantity = num(cell(r["Quantity"]));
    const price = num(cell(r["Unit cost"]));
    const currency = (cell(r["CCY"]) || "USD").toUpperCase() as Currency;
    const isin = cell(r["ISIN"]) || null;
    if (!/^\d+(\.\d+)?$/.test(quantity) || Number(quantity) <= 0) {
      drafts.push({ rowIndex: idx, type: "buy", symbol, isin, name: null, quantity, price, currency, fee: "0", executedAt, category: currentCategory, note: null, externalId: null, existingAssetId: null, warning: "Ongeldig aantal" });
      return;
    }
    drafts.push({
      rowIndex: idx,
      type: "buy",
      symbol,
      isin,
      name: null,
      quantity,
      price,
      currency,
      fee: "0",
      executedAt,
      category: currentCategory,
      note: `Swissquote-positie-export ${filename}: aantal × gemiddelde kostprijs`,
      externalId: `sq-pos:${isin ?? symbol}:${executedAt.slice(0, 10)}`,
      existingAssetId: lookupExisting(symbol, isin, currency, currentCategory),
      warning: null,
    });
  });
  return drafts;
}

export function guessMapping(headers: string[]): ColumnMapping {
  const find = (...names: string[]) => headers.find((h) => names.some((n) => h.toLowerCase().replace(/[^a-z]/g, "") === n)) ?? headers.find((h) => names.some((n) => h.toLowerCase().includes(n)));
  return {
    date: find("date", "datum", "time", "tijd", "opendate", "executedat"),
    type: find("type", "action", "side", "transactietype", "soort"),
    symbol: find("symbol", "ticker", "instrument", "asset"),
    isin: find("isin"),
    name: find("name", "naam", "description", "omschrijving"),
    quantity: find("quantity", "aantal", "units", "amount"),
    price: find("price", "prijs", "unitcost", "openrate", "koers"),
    currency: find("currency", "ccy", "valuta"),
    fee: find("fee", "fees", "kosten", "commission"),
    note: find("note", "notitie", "comment"),
    defaultType: "buy",
    defaultCurrency: "USD",
    defaultCategory: "stock",
  };
}

function normalizeType(v: string, fallback: TxType): TxType {
  const t = v.toLowerCase();
  if (!t) return fallback;
  if (t.includes("buy") || t.includes("koop") || t.includes("open")) return "buy";
  if (t.includes("sell") || t.includes("verkoop") || t.includes("close")) return "sell";
  if (t.includes("div")) return "dividend";
  if (t.includes("interest") || t.includes("rente")) return "interest";
  if (t.includes("stak")) return "staking";
  if (t.includes("fee") || t.includes("kost")) return "fee";
  if (t.includes("deposit") || t.includes("stort")) return "deposit";
  if (t.includes("withdraw") || t.includes("opname")) return "withdrawal";
  return (TX_TYPES as readonly string[]).includes(t) ? (t as TxType) : fallback;
}

function parseDate(v: string): string | null {
  if (!v) return null;
  const s = v.trim();
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) return localToIso(Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4] ?? 12), Number(m[5] ?? 0));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m && !s.endsWith("Z") && !/[+-]\d{2}:\d{2}$/.test(s)) return localToIso(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 12), Number(m[5] ?? 0));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function genericToDrafts(sheet: ParsedSheet, mapping: ColumnMapping, filename: string): ImportDraft[] {
  const drafts: ImportDraft[] = [];
  sheet.rows.forEach((r, idx) => {
    const get = (k: keyof ColumnMapping) => (mapping[k] ? cell(r[mapping[k] as string]) : "");
    const symbol = get("symbol").toUpperCase();
    const type = normalizeType(get("type"), mapping.defaultType ?? "buy");
    const executedAt = parseDate(get("date"));
    const currency = ((get("currency") || mapping.defaultCurrency || "USD").toUpperCase() as Currency) || "USD";
    const quantity = num(get("quantity") || "0");
    const price = num(get("price") || "0");
    const fee = num(get("fee") || "0");
    const isin = get("isin") || null;
    let warning: string | null = null;
    if (!executedAt) warning = "Geen geldige datum";
    else if (["buy", "sell"].includes(type) && (!symbol || Number(quantity) <= 0)) warning = "Symbool of aantal ontbreekt";
    drafts.push({
      rowIndex: idx,
      type,
      symbol,
      isin,
      name: get("name") || null,
      quantity,
      price,
      currency,
      fee,
      executedAt: executedAt ?? new Date().toISOString(),
      category: mapping.defaultCategory ?? "stock",
      note: get("note") || `Import ${filename}`,
      externalId: null,
      existingAssetId: symbol ? lookupExisting(symbol, isin, currency, mapping.defaultCategory ?? "stock") : null,
      warning,
    });
  });
  return drafts;
}

export interface CommitOptions {
  portfolioId: number;
  platformId: number;
  yahooSuffix: string; // bijv. ".L" voor London Stock Exchange
  priceSource: PriceSource;
  categoryOverrides?: Record<string, AssetCategory>; // per symbool
}

export interface CommitResult {
  created: number;
  duplicates: number;
  skipped: number;
  errors: { row: number; error: string }[];
  newAssets: string[];
}

export async function commitImport(drafts: ImportDraft[], opts: CommitOptions): Promise<CommitResult> {
  const result: CommitResult = { created: 0, duplicates: 0, skipped: 0, errors: [], newAssets: [] };
  const db = getDb();
  const platform = db.select().from(schema.platforms).where(eq(schema.platforms.id, opts.platformId)).get();
  if (!platform) throw new Error("Platform niet gevonden.");
  const toPrime: number[] = [];
  for (const d of drafts) {
    if (d.warning) {
      result.skipped++;
      continue;
    }
    try {
      let assetId = d.existingAssetId;
      if (!assetId && ["buy", "sell", "dividend", "staking", "interest"].includes(d.type) && d.symbol) {
        const category = opts.categoryOverrides?.[d.symbol] ?? d.category;
        // crypto (ook via een categorie-override bij het bevestigen): bestaand asset met dit symbool hergebruiken, ongeacht valuta
        const existingCrypto = category === "crypto" ? findCryptoBySymbol(d.symbol) : null;
        if (existingCrypto) {
          assetId = existingCrypto.id;
        } else {
          // nieuwe crypto net als bij de koppelingen en het toevoegen in USD noteren (de koers bepaalt de waarderingsvaluta),
          // zodat elke latere weg naar hetzelfde symbool (eToro, Yahoo, Kraken, sync) hetzelfde asset vindt
          const safeCategory: AssetCategory = (ASSET_CATEGORIES as readonly string[]).includes(category) ? category : "stock";
          const currency = safeCategory === "crypto" ? "USD" : d.currency;
          // symbool+valuta al bezet aan de andere kant van de grens crypto/niet-crypto: upsertAsset zou die rij van
          // categorie, bron en naam laten wisselen (zelfde regel als bij het toevoegen en de sync) → fout op deze regel
          const clash = findCategoryClash(d.symbol, currency, safeCategory);
          if (clash) throw new Error(categoryClashMessage(clash));
          const asset = upsertAsset({
            symbol: d.symbol,
            name: d.name ?? d.symbol,
            category: safeCategory,
            currency,
            priceSource: opts.priceSource,
            sourceId: opts.priceSource === "yahoo" ? `${d.symbol}${opts.yahooSuffix}` : null,
            isin: d.isin,
            exchange: null,
            logoUrl: null,
          });
          assetId = asset.id;
          if (!result.newAssets.includes(d.symbol)) {
            result.newAssets.push(d.symbol);
            toPrime.push(asset.id);
          }
        }
      }
      await createTransaction({
        portfolioId: opts.portfolioId,
        assetId: assetId ?? null,
        platformId: opts.platformId,
        type: d.type,
        quantity: d.quantity,
        price: d.price,
        currency: d.currency,
        fee: d.fee,
        executedAt: d.executedAt,
        note: d.note,
        source: "csv",
        externalId: d.externalId,
      });
      result.created++;
    } catch (e) {
      if (e instanceof DuplicateTransactionError) result.duplicates++;
      else result.errors.push({ row: d.rowIndex + 2, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // koersen van nieuwe assets op de achtergrond ophalen
  for (const id of toPrime) {
    const a = db.select().from(schema.assets).where(eq(schema.assets.id, id)).get();
    if (a) void primeAssetPrice(a);
  }
  return result;
}
