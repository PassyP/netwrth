import { and, desc, eq, isNotNull, lte, min, ne, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import { CURRENCIES, type Asset, type PriceQuote } from "../db/schema";
import * as etoro from "./etoro";
import * as yahoo from "./yahoo";
import { krakenMarket } from "@/lib/prices/kraken";
import { ensureBtcCoverage, ensureFxCoverage, fetchLatestFx, shiftDays } from "./fx";
import { checkAlerts } from "../alerts";

/**
 * eToro-rates hebben geen valuta; de app behandelt ze overal als USD (kandidaten en koppelingen maken eToro-assets in USD
 * aan). Koersen van eToro worden daarom altijd als USD opgeslagen, ook als assets.currency iets anders zegt (bijv. een
 * crypto-asset in EUR uit een CSV-import dat later eToro als feed kreeg). De dagslot van getClosingPrices is eveneens USD.
 */
export const ETORO_QUOTE_CURRENCY = "USD";

/**
 * Eenmalige reparatie van oudere eToro-koersrijen die met assets.currency (bijv. EUR) waren gelabeld terwijl de koers
 * USD was. Zonder herlabeling laat de assetgrafiek (filtert op de valuta van de laatste rij) alle dagen van vóór de fix
 * weg, toont de portfoliohistorie een sprong op de wisseldag en vindt previousClose geen vorige slot over de grens heen.
 * Idempotent en goedkoop; draait bij elke verversronde (alle assets) en backfill (per asset), zodat de eerste USD-rij
 * nooit naast een EUR-gelabelde historie komt te staan. Geeft het aantal herlabelde rijen terug.
 */
export function repairEtoroQuoteCurrency(assetId?: number): number {
  const legacy = and(eq(schema.priceQuotes.source, "etoro"), ne(schema.priceQuotes.currency, ETORO_QUOTE_CURRENCY));
  const r = getDb()
    .update(schema.priceQuotes)
    .set({ currency: ETORO_QUOTE_CURRENCY })
    .where(assetId != null ? and(legacy, eq(schema.priceQuotes.assetId, assetId)) : legacy)
    .run();
  if (r.changes > 0) console.log(`[koersen] ${r.changes} eToro-koersrij(en) herlabeld naar ${ETORO_QUOTE_CURRENCY}${assetId != null ? ` (asset ${assetId})` : ""}`);
  return r.changes;
}

/**
 * Koers van een dag opslaan (upsert op asset+dag). previousClose hoort bij déze koers en valuta: zonder waarde wordt een
 * eerdere previousClose van die dag gewist, anders zou een eToro- of handmatige koers in USD nog met de Kraken-open in
 * EUR worden vergeleken en een onzinnige dagverandering opleveren.
 */
export function saveQuote(assetId: number, tsIso: string, price: number | string, currency: string, source: string, previousClose?: number | string | null) {
  const db = getDb();
  const day = tsIso.slice(0, 10);
  const prev = previousClose != null ? String(previousClose) : null;
  db.insert(schema.priceQuotes)
    .values({ assetId, ts: tsIso, day, price: String(price), currency, source, previousClose: prev })
    .onConflictDoUpdate({
      target: [schema.priceQuotes.assetId, schema.priceQuotes.day],
      set: { ts: tsIso, price: String(price), currency, source, previousClose: prev },
    })
    .run();
}

/**
 * Dagkoers uit de Yahoo-backfill van oudere dagen opslaan: schrijft als de dag nog geen rij heeft of alleen een
 * Yahoo-rij (een eerdere, mogelijk te grove aanvulling), en laat rijen van de eigen koersfeed (kraken, etoro) en
 * handmatige koersen staan. previousClose blijft onaangeroerd. Geeft true als er is geschreven.
 */
export function saveBackfilledQuote(assetId: number, tsIso: string, price: number | string, currency: string): boolean {
  const r = getDb()
    .insert(schema.priceQuotes)
    .values({ assetId, ts: tsIso, day: tsIso.slice(0, 10), price: String(price), currency, source: "yahoo", previousClose: null })
    .onConflictDoUpdate({
      target: [schema.priceQuotes.assetId, schema.priceQuotes.day],
      set: { ts: tsIso, price: String(price), currency, source: "yahoo" },
      setWhere: eq(schema.priceQuotes.source, "yahoo"),
    })
    .run();
  return r.changes > 0;
}

export function latestQuote(assetId: number): PriceQuote | null {
  return getDb().select().from(schema.priceQuotes).where(eq(schema.priceQuotes.assetId, assetId)).orderBy(desc(schema.priceQuotes.day)).limit(1).get() ?? null;
}

export function quoteOnOrBefore(assetId: number, day: string): PriceQuote | null {
  return (
    getDb()
      .select()
      .from(schema.priceQuotes)
      .where(and(eq(schema.priceQuotes.assetId, assetId), lte(schema.priceQuotes.day, day)))
      .orderBy(desc(schema.priceQuotes.day))
      .limit(1)
      .get() ?? null
  );
}

/** Vorige dagslot: het previous_close-veld van de laatste quote, anders de rij van de dag ervoor (alleen in dezelfde valuta). */
export function previousClose(assetId: number): string | null {
  const latest = latestQuote(assetId);
  if (!latest) return null;
  if (latest.previousClose) return latest.previousClose;
  const rows = getDb().select().from(schema.priceQuotes).where(eq(schema.priceQuotes.assetId, assetId)).orderBy(desc(schema.priceQuotes.day)).limit(2).all();
  return rows.length > 1 && rows[1].currency === latest.currency ? rows[1].price : null;
}

export function quoteHistory(assetId: number, fromDay: string): PriceQuote[] {
  return getDb()
    .select()
    .from(schema.priceQuotes)
    .where(and(eq(schema.priceQuotes.assetId, assetId), lte(schema.priceQuotes.day, "9999-12-31")))
    .orderBy(schema.priceQuotes.day)
    .all()
    .filter((q) => q.day >= fromDay);
}

export interface RefreshReport {
  startedAt: string;
  finishedAt: string;
  updated: number;
  /** mislukte koersen; `assetId` als het om een asset gaat (niet bij FX of alerts) */
  failed: { asset: string; assetId?: number; error: string }[];
  fxDate: string | null;
}

function logJob(job: string, startedAt: string, ok: boolean, message: string, details?: unknown) {
  getDb()
    .insert(schema.jobRuns)
    .values({ job, startedAt, finishedAt: new Date().toISOString(), ok, message, details: details === undefined ? null : JSON.stringify(details) })
    .run();
}

/** "20 bijgewerkt, 2 mislukt: AAA, BBB" (hoogstens vijf namen), zodat de taaklog zegt wélke koersen mislukten. */
export function refreshSummary(updated: number, failed: { asset: string }[]): string {
  const names = [...new Set(failed.map((f) => f.asset))];
  const shown = names.slice(0, 5).join(", ");
  const more = names.length > 5 ? ` en ${names.length - 5} meer` : "";
  return `${updated} bijgewerkt, ${failed.length} mislukt${names.length ? `: ${shown}${more}` : ""}`;
}

/** Wie de ronde start: de knop Verversen, de dagelijkse ronde of het koersinterval (standaard elk uur); komt als `refresh:<trigger>` in de taaklog. */
export type RefreshTrigger = "manual" | "scheduled" | "interval";

/** Eén verversronde: alle actieve assets met een koersbron, plus de wisselkoersen, plus alerts. */
export async function refreshAll(trigger: RefreshTrigger = "manual"): Promise<RefreshReport> {
  const db = getDb();
  const startedAt = new Date().toISOString();
  const report: RefreshReport = { startedAt, finishedAt: startedAt, updated: 0, failed: [], fxDate: null };
  const assets = db.select().from(schema.assets).where(eq(schema.assets.active, true)).all();

  try {
    report.fxDate = await fetchLatestFx();
  } catch (e) {
    report.failed.push({ asset: "FX (ECB)", error: e instanceof Error ? e.message : String(e) });
  }

  // eToro: één rates-call voor alle instrumenten; eerst oudere rijen met een verkeerd valutalabel herstellen
  const etoroAssets = assets.filter((a) => a.priceSource === "etoro" && a.sourceId);
  try {
    repairEtoroQuoteCurrency();
  } catch (e) {
    report.failed.push({ asset: "eToro-historie", error: e instanceof Error ? e.message : String(e) });
  }
  if (etoroAssets.length > 0) {
    try {
      const ids = etoroAssets.map((a) => Number(a.sourceId));
      const rates = await etoro.getRates(ids);
      const byId = new Map(rates.map((r) => [r.instrumentId, r]));
      // dagslot ter referentie (verandering vandaag)
      let closes = new Map<number, number>();
      try {
        const c = await etoro.getClosingPrices(ids);
        closes = new Map(c.map((x) => [x.instrumentId, x.closingPrices?.daily?.price ?? x.officialClosingPrice]));
      } catch {
        /* optioneel */
      }
      for (const a of etoroAssets) {
        const r = byId.get(Number(a.sourceId));
        if (!r) {
          report.failed.push({ asset: a.symbol, assetId: a.id, error: "geen koers in eToro-antwoord" });
          continue;
        }
        const mid = (r.bid + r.ask) / 2;
        const prev = closes.get(Number(a.sourceId));
        saveQuote(a.id, new Date().toISOString(), mid, ETORO_QUOTE_CURRENCY, "etoro", prev && prev > 0 ? prev : null);
        report.updated++;
      }
    } catch (e) {
      for (const a of etoroAssets) report.failed.push({ asset: a.symbol, assetId: a.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Kraken: één Ticker-ronde voor alle pairs (chunkt intern per 50); koers in de quote-valuta van het pair
  const krakenAssets = assets.filter((a) => a.priceSource === "kraken" && a.sourceId);
  if (krakenAssets.length > 0) {
    try {
      const quotes = await krakenMarket.getQuotes(krakenAssets.map((a) => a.sourceId!));
      const now = new Date().toISOString();
      for (const a of krakenAssets) {
        const q = quotes.get(a.sourceId!);
        if (!q) {
          report.failed.push({ asset: a.symbol, assetId: a.id, error: `Kraken: geen koers voor ${a.sourceId}` });
          continue;
        }
        saveQuote(a.id, now, q.price, q.currency, "kraken", q.previousClose);
        report.updated++;
      }
    } catch (e) {
      for (const a of krakenAssets) report.failed.push({ asset: a.symbol, assetId: a.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Yahoo: per symbool
  for (const a of assets.filter((x) => x.priceSource === "yahoo" && x.sourceId)) {
    try {
      const q = await yahoo.getQuote(a.sourceId!);
      saveQuote(a.id, new Date().toISOString(), q.price, q.currency, "yahoo", q.previousClose);
      report.updated++;
    } catch (e) {
      report.failed.push({ asset: a.symbol, assetId: a.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  report.finishedAt = new Date().toISOString();
  logJob(`refresh:${trigger}`, startedAt, report.failed.length === 0, refreshSummary(report.updated, report.failed), report.failed.length ? { failed: report.failed.slice(0, 100) } : undefined);

  try {
    await checkAlerts();
  } catch (e) {
    report.failed.push({ asset: "alerts", error: e instanceof Error ? e.message : String(e) });
  }
  return report;
}

/** Historische dagslotkoersen ophalen (voor grafieken en backfill van snapshots). */
export async function backfillHistory(asset: Asset, days = 365): Promise<number> {
  if (!asset.sourceId) return 0;
  let n = 0;
  const today = new Date().toISOString().slice(0, 10);
  if (asset.priceSource === "etoro") {
    repairEtoroQuoteCurrency(asset.id);
    const candles = await etoro.getDailyCandles(Number(asset.sourceId), days);
    for (const c of candles) {
      const day = c.fromDate.slice(0, 10);
      if (day >= today) continue;
      saveQuote(asset.id, `${day}T21:00:00.000Z`, c.close, ETORO_QUOTE_CURRENCY, "etoro");
      n++;
    }
  } else if (asset.priceSource === "yahoo") {
    const range = days > 365 * 2 ? "5y" : days > 365 ? "2y" : "1y";
    const h = await yahoo.getDailyHistory(asset.sourceId, range);
    for (const c of h.candles) {
      if (c.date >= today) continue;
      saveQuote(asset.id, `${c.date}T21:00:00.000Z`, c.close, h.currency, "yahoo");
      n++;
    }
  } else if (asset.priceSource === "kraken") {
    const h = await krakenMarket.getDailyHistory(asset.sourceId, days);
    for (const c of h.candles) {
      if (c.date >= today) continue;
      saveQuote(asset.id, `${c.date}T21:00:00.000Z`, c.close, h.currency, "kraken");
      n++;
    }
  }
  return n;
}

/**
 * Yahoo-tickers om de oude dagen van een asset mee aan te vullen, in volgorde van voorkeur. Een Yahoo-asset gebruikt zijn
 * eigen ticker. Crypto noteert Yahoo als <munt>-<valuta>: eerst de valuta van de huidige koersfeed (dan blijft de hele
 * historie in één valuta en laat de assetgrafiek, die op de valuta van de laatste rij filtert, geen dagen weg), dan de
 * valuta van het asset en USD, waarin Yahoo vrijwel elke munt kent. Aandelen en ETF's via eToro of Kraken krijgen geen
 * kandidaten: hun symbool is zonder beurssuffix geen betrouwbare Yahoo-ticker. Handmatige assets blijven handmatig.
 */
export function yahooHistoryTickers(asset: Pick<Asset, "symbol" | "category" | "currency" | "priceSource" | "sourceId">, feedCurrency: string | null): string[] {
  if (asset.priceSource === "yahoo") return asset.sourceId ? [asset.sourceId] : [];
  if (asset.category !== "crypto" || (asset.priceSource !== "kraken" && asset.priceSource !== "etoro")) return [];
  const out: string[] = [];
  for (const ccy of [feedCurrency, asset.currency, "USD"]) {
    if (!ccy || !(CURRENCIES as readonly string[]).includes(ccy)) continue;
    const ticker = `${asset.symbol.toUpperCase()}-${ccy}`;
    if (!out.includes(ticker)) out.push(ticker);
  }
  return out;
}

const DAY_MS = 86400 * 1000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
/** Marge vóór de eerste transactie: op die dag zelf hoeft geen candle te vallen (weekend, feestdag). */
const LEAD_DAYS = 7;
/** Onder deze dichtheid (rijen per dag) is een oude reeks te grof: dagkoersen geven ≥ 0,69 (beursdagen), week- of maandcandles ≤ 0,15. */
const MIN_DENSITY = 0.5;
const MIN_SPAN_DAYS = 14;

export interface HistoryCoverage {
  /** Dag van de eerste koersrij, of null zonder rijen. */
  firstRow: string | null;
  /** Dag van de eerste rij van de eigen koersfeed (source = priceSource); null voor een Yahoo-asset of zonder feedrij. Daarvóór ligt het aan te vullen stuk. */
  feedStart: string | null;
  /** Begin en einde (exclusief) van het stuk dat de backfill vult, en het aantal rijen dat daar nu in staat. */
  from: string;
  to: string;
  rows: number;
}

/** Hoe ver de koershistorie van een asset terugreikt ten opzichte van zijn eerste transactie. */
export function historyCoverage(asset: Pick<Asset, "id" | "priceSource">, firstDay: string, today = new Date().toISOString().slice(0, 10)): HistoryCoverage {
  const db = getDb();
  const own = eq(schema.priceQuotes.assetId, asset.id);
  const firstRow = db.select({ day: min(schema.priceQuotes.day) }).from(schema.priceQuotes).where(own).get()?.day ?? null;
  const feedStart = asset.priceSource === "yahoo" ? null : (db.select({ day: min(schema.priceQuotes.day) }).from(schema.priceQuotes).where(and(own, eq(schema.priceQuotes.source, asset.priceSource))).get()?.day ?? null);
  const from = shiftDays(firstDay, -LEAD_DAYS);
  const to = feedStart ?? today;
  const rows = db.select({ n: sql<number>`count(*)` }).from(schema.priceQuotes).where(and(own, sql`${schema.priceQuotes.day} >= ${from}`, sql`${schema.priceQuotes.day} < ${to}`)).get()?.n ?? 0;
  return { firstRow, feedStart, from, to, rows };
}

/**
 * Moet het oude stuk (opnieuw) worden opgehaald? Ja als er geen koers op of vóór de eerste transactie is, of als het
 * stuk tussen de eerste transactie en de feed te dun bezet is: een eerdere aanvulling met week- of maandcandles
 * (Yahoo's antwoord op `range=max`) waardeert elke dag met de slot van een hele week of maand.
 */
export function needsOlderHistory(c: HistoryCoverage, firstDay: string): boolean {
  if (c.firstRow == null || c.firstRow > firstDay) return true;
  const start = c.firstRow > c.from ? c.firstRow : c.from;
  const span = daysBetween(start, c.to);
  return span >= MIN_SPAN_DAYS && c.rows < span * MIN_DENSITY;
}

/**
 * Oudere dagslotkoersen aanvullen van een week vóór firstDay (de eerste transactie van het asset) tot de eerste rij van
 * de eigen koersfeed. Die feed reikt niet ver genoeg terug — Kraken geeft hoogstens 720 dagcandles, de backfill bij
 * aanmaken een jaar — en zonder koers waardeert de historie een positie tegen kostprijs: een vlakke lijn die op de
 * eerste koersdag naar marktwaarde springt. Yahoo levert met een periode (niet `range=max`, zie getDailyHistoryBetween)
 * voor crypto en de meeste ETF's de volledige dagreeks. Rijen van de eigen feed en handmatige koersen blijven staan;
 * eerdere Yahoo-rijen worden overschreven, zodat een te grove reeks zichzelf herstelt. Geeft het aantal geschreven
 * rijen terug: 0 als de historie al ver genoeg terugreikt, er geen ticker is of Yahoo die dagen niet kent. Gooit alleen
 * als geen enkele ticker een antwoord gaf (Yahoo onbereikbaar of onbekend).
 */
export async function backfillOlderHistory(asset: Asset, firstDay: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const cov = historyCoverage(asset, firstDay, today);
  if (!needsOlderHistory(cov, firstDay)) return 0;
  const tickers = yahooHistoryTickers(asset, latestQuote(asset.id)?.currency ?? null);
  if (tickers.length === 0) return 0;
  const toDay = shiftDays(cov.to, -1);
  if (toDay < cov.from) return 0;
  let lastError: unknown = null;
  for (const ticker of tickers) {
    let h: Awaited<ReturnType<typeof yahoo.getDailyHistoryBetween>>;
    try {
      h = await yahoo.getDailyHistoryBetween(ticker, cov.from, toDay);
    } catch (e) {
      lastError = e;
      continue;
    }
    let n = 0;
    for (const c of h.candles) {
      if (c.date < cov.from || c.date > toDay || c.date >= today) continue;
      if (saveBackfilledQuote(asset.id, `${c.date}T21:00:00.000Z`, c.close, h.currency)) n++;
    }
    return n; // de eerste ticker met een antwoord telt, ook als de reeks pas na firstDay begint: een andere valuta reikt niet verder terug
  }
  if (lastError) throw lastError;
  return 0;
}

/** Assets waarvan de koershistorie later begint dan hun eerste transactie, ontbreekt of te grof is, en waarvoor Yahoo een ticker kan leveren. */
export function historyGaps(): { asset: Asset; firstDay: string }[] {
  const db = getDb();
  const firstTx = db
    .select({ assetId: schema.transactions.assetId, day: min(sql<string>`substr(${schema.transactions.executedAt}, 1, 10)`) })
    .from(schema.transactions)
    .where(isNotNull(schema.transactions.assetId))
    .groupBy(schema.transactions.assetId)
    .all();
  const assets = new Map(db.select().from(schema.assets).where(eq(schema.assets.active, true)).all().map((a) => [a.id, a]));
  const today = new Date().toISOString().slice(0, 10);
  const out: { asset: Asset; firstDay: string }[] = [];
  for (const r of firstTx) {
    const asset = r.assetId != null ? assets.get(r.assetId) : undefined;
    if (!asset || !r.day || yahooHistoryTickers(asset, null).length === 0) continue;
    if (needsOlderHistory(historyCoverage(asset, r.day, today), r.day)) out.push({ asset, firstDay: r.day });
  }
  return out;
}

export interface CoverageReport {
  filled: number;
  assets: string[];
  failed: { asset: string; error: string }[];
}

// `${assetId}:${firstDay}` → tijdstip (ms) vanaf wanneer een nieuwe poging mag; Infinity = klaar (gevuld, of Yahoo kent de dagen niet).
// Procesgeheugen: na een herstart volgt hoogstens één nieuwe poging per gat, en een oudere transactie (nieuwe firstDay) telt als nieuw gat.
const coverageAttempts = new Map<string, number>();
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
let coverageRun: Promise<CoverageReport> | null = null;

/**
 * Koershistorie van alle assets terugtrekken tot hun eerste transactie (zie backfillOlderHistory). Idempotent en goedkoop
 * als er niets te vullen is: twee aggregaties op de database, geen netwerk. Per asset en eerste transactiedag één
 * poging; na een fout (Yahoo onbereikbaar) een uur later opnieuw. Gelijktijdige aanroepen delen dezelfde run.
 */
export function ensureHistoryCoverage(): Promise<CoverageReport> {
  if (coverageRun) return coverageRun;
  coverageRun = (async () => {
    const report: CoverageReport = { filled: 0, assets: [], failed: [] };
    const now = Date.now();
    for (const { asset, firstDay } of historyGaps()) {
      const key = `${asset.id}:${firstDay}`;
      if ((coverageAttempts.get(key) ?? 0) > now) continue;
      try {
        const n = await backfillOlderHistory(asset, firstDay);
        coverageAttempts.set(key, Infinity);
        if (n > 0) {
          report.filled += n;
          report.assets.push(asset.symbol);
          console.log(`[koersen] ${asset.symbol}: ${n} oudere dagkoers(en) van Yahoo aangevuld tot ${firstDay}`);
        }
      } catch (e) {
        coverageAttempts.set(key, Date.now() + RETRY_AFTER_FAILURE_MS);
        const error = e instanceof Error ? e.message : String(e);
        report.failed.push({ asset: asset.symbol, error });
        console.warn(`[koersen] oudere historie van ${asset.symbol} niet aangevuld: ${error}`);
      }
    }
    return report;
  })().finally(() => {
    coverageRun = null;
  });
  return coverageRun;
}

/**
 * Wacht hoogstens ms op ensureHistoryCoverage en het aanvullen van de BTC- en ECB-reeksen; wat langer duurt loopt op de
 * achtergrond door en zit in de volgende laadbeurt.
 */
export async function awaitHistoryCoverage(ms: number): Promise<void> {
  const run = Promise.all([ensureHistoryCoverage().catch(() => undefined), ensureBtcCoverage().catch(() => undefined), ensureFxCoverage().catch(() => undefined)]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([run, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}
