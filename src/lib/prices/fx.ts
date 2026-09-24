import Decimal from "decimal.js";
import { and, desc, eq, inArray, lte, min, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import { getDailyHistoryBetween, getQuote } from "./yahoo";

/**
 * Wisselkoersen: ECB-referentiekoersen via Frankfurter (api.frankfurter.dev, ECB-data).
 * Opslag: 1 EUR = rate_per_eur × valuta, per werkdag. Weekend/feestdag = laatst gepubliceerde koers.
 */
const FX_BASE = process.env.FX_BASE_URL || "https://api.frankfurter.dev/v1";
export const FX_CURRENCIES = ["USD", "CHF", "GBP"] as const;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`FX ${res.status} bij ${url}`);
  return (await res.json()) as T;
}

/**
 * Bitcoin als weergavevaluta: staat in dezelfde tabel als "valuta" BTC (1 EUR = x BTC), maar komt niet van de ECB.
 * Bron: Yahoo BTC-EUR (dagslot; vandaag de actuele koers). Crypto handelt ook in het weekend, dus elke dag een rij.
 */
export const BTC = "BTC";
const BTC_TICKER = "BTC-EUR";

function upsert(date: string, currency: string, rate: number | string, source = "ECB") {
  const db = getDb();
  db.insert(schema.fxRates)
    .values({ date, currency, ratePerEur: String(rate), source })
    .onConflictDoUpdate({ target: [schema.fxRates.date, schema.fxRates.currency], set: { ratePerEur: String(rate) } })
    .run();
}

/** Haalt een datumbereik op (max ~ 1 jaar per call) en slaat het op. */
export async function fetchFxRange(start: string, end: string): Promise<number> {
  const data = await fetchJson<{ rates: Record<string, Record<string, number>> }>(
    `${FX_BASE}/${start}..${end}?base=EUR&symbols=${FX_CURRENCIES.join(",")}`
  );
  let n = 0;
  for (const [date, rates] of Object.entries(data.rates ?? {})) {
    for (const [ccy, rate] of Object.entries(rates)) {
      upsert(date, ccy, rate);
      n++;
    }
  }
  return n;
}

export async function fetchLatestFx(): Promise<string> {
  // BTC los van de ECB: een storing bij Yahoo mag de wisselkoersen niet tegenhouden (en andersom)
  const btc = fetchLatestBtc().catch((e) => console.warn(`[fx] BTC-koers niet opgehaald: ${e instanceof Error ? e.message : String(e)}`));
  const data = await fetchJson<{ date: string; rates: Record<string, number> }>(`${FX_BASE}/latest?base=EUR&symbols=${FX_CURRENCIES.join(",")}`);
  for (const [ccy, rate] of Object.entries(data.rates ?? {})) upsert(data.date, ccy, rate);
  await btc;
  return data.date;
}

/** BTC per 1 EUR uit een BTC-EUR-koers (EUR per 1 BTC). */
function btcPerEur(eurPerBtc: number): string {
  return new Decimal(1).div(eurPerBtc).toFixed(18);
}

/** Dagslotkoersen BTC-EUR van Yahoo tussen twee dagen (inclusief). */
export async function fetchBtcRange(start: string, end: string): Promise<number> {
  const { currency, candles } = await getDailyHistoryBetween(BTC_TICKER, start, end);
  if (currency !== "EUR") throw new Error(`Yahoo ${BTC_TICKER} in ${currency} in plaats van EUR`);
  let n = 0;
  for (const c of candles) {
    if (!(c.close > 0)) continue;
    upsert(c.date, BTC, btcPerEur(c.close), "Yahoo");
    n++;
  }
  return n;
}

/** Actuele BTC-EUR-koers als rij van vandaag. */
export async function fetchLatestBtc(): Promise<void> {
  const q = await getQuote(BTC_TICKER);
  if (q.currency !== "EUR") throw new Error(`Yahoo ${BTC_TICKER} in ${q.currency} in plaats van EUR`);
  if (!(q.price > 0)) throw new Error(`Yahoo ${BTC_TICKER}: geen geldige koers`);
  upsert(todayStr(), BTC, btcPerEur(q.price), "Yahoo");
}

/**
 * Best-effort aanvulling van een koersreeks tot de eerste transactie en tot vandaag. Eén geslaagde poging per dag en
 * eerste transactiedag, na een fout een uur later opnieuw; gelijktijdige aanroepen delen dezelfde run.
 */
function dailyCoverage(label: string, source: string, fill: (fromDate: string) => Promise<number>): () => Promise<number> {
  // `${eerste transactiedag}:${vandaag}` → tijdstip (ms) vanaf wanneer een nieuwe poging mag; Infinity = klaar voor vandaag
  const attempts = new Map<string, number>();
  let run: Promise<number> | null = null;
  return () => {
    if (run) return run;
    run = (async () => {
      const first = getDb()
        .select({ day: min(sql<string>`substr(${schema.transactions.executedAt}, 1, 10)`) })
        .from(schema.transactions)
        .get()?.day;
      if (!first) return 0;
      const key = `${first}:${todayStr()}`;
      if ((attempts.get(key) ?? 0) > Date.now()) return 0;
      try {
        const n = await fill(first);
        attempts.set(key, Infinity);
        if (n > 0) console.log(`[fx] ${label}: ${n} dagkoers(en) van ${source} aangevuld vanaf ${first}`);
        return n;
      } catch (e) {
        attempts.set(key, Date.now() + 60 * 60 * 1000);
        console.warn(`[fx] ${label}-historie niet aangevuld: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    })().finally(() => {
      run = null;
    });
    return run;
  };
}

/** BTC-reeks aanvullen tot de eerste transactie en tot vandaag (zie dailyCoverage en ensureBtcHistory). */
export const ensureBtcCoverage = dailyCoverage("BTC-EUR", "Yahoo", ensureBtcHistory);

/** Zorgt dat de BTC-reeks teruggaat tot fromDate (eerste transactie) en tot vandaag loopt. */
export async function ensureBtcHistory(fromDate: string): Promise<number> {
  const db = getDb();
  const rows = db.select({ date: schema.fxRates.date }).from(schema.fxRates).where(eq(schema.fxRates.currency, BTC)).orderBy(schema.fxRates.date).all();
  const today = todayStr();
  let n = 0;
  const fill = async (from: string, to: string) => {
    let start = from;
    while (start <= to) {
      const end = shiftDays(start, 364) > to ? to : shiftDays(start, 364);
      n += await fetchBtcRange(start, end);
      start = shiftDays(end, 1);
    }
  };
  if (rows.length === 0) {
    await fill(fromDate, today);
    return n;
  }
  const oldest = rows[0].date;
  const newest = rows[rows.length - 1].date;
  // Yahoo's BTC-EUR begint in 2014; een oudere eerste transactie zou anders bij elke ronde opnieuw vragen
  if (oldest > fromDate && oldest > "2014-09-18") await fill(fromDate, shiftDays(oldest, -1));
  if (newest < today) await fill(shiftDays(newest, 1), today);
  return n;
}

function lookup(date: string, currency: string): { date: string; rate: Decimal } | null {
  const row = getDb()
    .select()
    .from(schema.fxRates)
    .where(and(eq(schema.fxRates.currency, currency), lte(schema.fxRates.date, date)))
    .orderBy(desc(schema.fxRates.date))
    .limit(1)
    .get();
  if (!row) return null;
  return { date: row.date, rate: new Decimal(row.ratePerEur) };
}

/** 1 EUR = x currency op (of vlak voor) de datum; haalt op als het ontbreekt. */
export async function ratePerEur(currency: string, date: string = todayStr()): Promise<Decimal> {
  if (currency === "EUR") return new Decimal(1);
  const hit = lookup(date, currency);
  // Recent genoeg (max 5 dagen oud) → gebruiken; anders proberen op te halen.
  if (hit && daysBetween(hit.date, date) <= 5) return hit.rate;
  try {
    const start = shiftDays(date, -10);
    const end = date > todayStr() ? todayStr() : date;
    if (currency === BTC) await fetchBtcRange(start, end);
    else await fetchFxRange(start, end);
  } catch {
    // offline: val terug op wat er is
  }
  const again = lookup(date, currency) ?? lookup(todayStr(), currency);
  if (!again) throw new Error(`Geen wisselkoers voor ${currency} beschikbaar (offline en geen cache).`);
  return again.rate;
}

export function ratePerEurSync(currency: string, date: string = todayStr()): Decimal | null {
  if (currency === "EUR") return new Decimal(1);
  return lookup(date, currency)?.rate ?? null;
}

/** Omrekenfactoren voor een transactie: 1 eenheid `currency` in EUR en in USD op de datum (BTC: zie btcFactor). */
export async function fxForTransaction(currency: string, isoDate: string): Promise<{ fxEur: string; fxUsd: string }> {
  const date = isoDate.slice(0, 10);
  const rCcy = await ratePerEur(currency, date); // 1 EUR = rCcy currency
  const rUsd = await ratePerEur("USD", date);
  const fxEur = new Decimal(1).div(rCcy);
  const fxUsd = rUsd.div(rCcy);
  return { fxEur: fxEur.toFixed(10), fxUsd: fxUsd.toFixed(10) };
}

/**
 * Sync-variant met alleen de cache (voor berekeningen die niet mogen wachten). fxBtc is null zolang er geen BTC-koers
 * is: EUR/USD blijven dan gewoon werken.
 */
export function fxNowSync(currency: string): { fxEur: Decimal; fxUsd: Decimal; fxBtc: Decimal | null } | null {
  return fxOnDateSync(currency, todayStr());
}

export function fxOnDateSync(currency: string, date: string): { fxEur: Decimal; fxUsd: Decimal; fxBtc: Decimal | null } | null {
  const rCcy = ratePerEurSync(currency, date);
  const rUsd = ratePerEurSync("USD", date);
  if (!rCcy || !rUsd) return null;
  const rBtc = ratePerEurSync(BTC, date);
  return { fxEur: new Decimal(1).div(rCcy), fxUsd: rUsd.div(rCcy), fxBtc: rBtc ? rBtc.div(rCcy) : null };
}

/**
 * 1 eenheid transactievaluta in BTC op de transactiedatum, uit de opgeslagen fxEur en de BTC-reeks. Niet in de
 * transactie opgeslagen maar bij het laden berekend: zo werken bestaande transacties zonder migratie.
 */
export function btcFactor(fxEur: string | null, currency: string, isoDate: string): string | null {
  if (currency === BTC) return "1";
  const eur = currency === "EUR" ? new Decimal(1) : fxEur != null ? new Decimal(fxEur) : null;
  const rBtc = ratePerEurSync(BTC, isoDate.slice(0, 10));
  if (!eur || !rBtc) return null;
  return eur.mul(rBtc).toFixed(18);
}

/**
 * Meer kalenderdagen tussen twee ECB-rijen betekent een ontbrekende publicatiedag: het langste gewone gat is Pasen
 * (donderdag → dinsdag, 5 dagen); kerst en nieuwjaar blijven daaronder. Zelfde grens als ratePerEur.
 */
const FX_MAX_GAP_DAYS = 5;
/** Marge vóór de eerste transactie: op die dag zelf hoeft geen koers te vallen (weekend, feestdag). */
const FX_LEAD_DAYS = 7;
/** Eerste dag van de ECB-referentiekoersen; daarvóór valt niets aan te vullen. */
const ECB_START = "1999-01-04";

/**
 * Stukken [van, tot] (inclusief) waar een ECB-reeks (oplopende datums) een publicatiedag mist tussen de eerste
 * transactie en vandaag: geen koers op of vlak vóór fromDate, twee rijen meer dan FX_MAX_GAP_DAYS uit elkaar, of een
 * laatste rij die zo ver voor vandaag ligt. Rijen van ver vóór fromDate trekken het gat niet verder terug dan de marge.
 */
export function fxGaps(dates: string[], fromDate: string, today: string = todayStr()): [string, string][] {
  const lead = shiftDays(fromDate, -FX_LEAD_DAYS);
  const after = (d: string) => (shiftDays(d, 1) > lead ? shiftDays(d, 1) : lead);
  const gaps: [string, string][] = [];
  let prev: string | null = null; // eerst het anker: de laatste rij op of vóór fromDate
  for (const d of dates) {
    if (d > today) break;
    if (d > fromDate) {
      if (prev == null) gaps.push([lead, shiftDays(d, -1)]);
      else if (daysBetween(prev, d) > FX_MAX_GAP_DAYS) gaps.push([after(prev), shiftDays(d, -1)]);
    }
    prev = d;
  }
  if (prev == null) gaps.push([lead, today]);
  else if (daysBetween(prev, today) > FX_MAX_GAP_DAYS) gaps.push([after(prev), today]);
  return gaps;
}

/**
 * Gaten samenvoegen tot zo weinig mogelijk Frankfurter-verzoeken van hoogstens een jaar: gaten die binnen een jaar na
 * het begin van het vorige verzoek vallen gaan mee in dat verzoek (de bestaande rijen ertussen worden gewoon
 * overschreven met dezelfde koers), een gat van meer dan een jaar wordt opgeknipt.
 */
export function fxRequestWindows(gaps: [string, string][]): [string, string][] {
  const out: [string, string][] = [];
  for (const [from, to] of [...gaps].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    let start = from;
    const last = out[out.length - 1];
    if (last) {
      if (to <= last[1]) continue;
      const cap = shiftDays(last[0], 364);
      if (start <= cap) {
        last[1] = to < cap ? to : cap;
        start = shiftDays(last[1], 1);
      }
    }
    while (start <= to) {
      const end = shiftDays(start, 364) < to ? shiftDays(start, 364) : to;
      out.push([start, end]);
      start = shiftDays(end, 1);
    }
  }
  return out;
}

function ecbRowCount(): number {
  return getDb().select({ n: sql<number>`count(*)` }).from(schema.fxRates).where(inArray(schema.fxRates.currency, [...FX_CURRENCIES])).get()?.n ?? 0;
}

/**
 * Vult de gaten in de ECB-reeksen (USD, CHF, GBP) van fromDate (eerste transactie) tot vandaag. Zonder deze aanvulling
 * staan er alleen rijen rond transactiedagen (ratePerEur haalt ±10 dagen op), en rekent de historie in een gat met de
 * laatste koers ervóór. Eén verzoek per jaar met gaten, alle valuta's tegelijk. Geeft het aantal nieuwe rijen terug.
 */
export async function ensureFxHistory(fromDate: string): Promise<number> {
  const from = fromDate < ECB_START ? ECB_START : fromDate;
  const today = todayStr();
  const db = getDb();
  const gaps = FX_CURRENCIES.flatMap((ccy) =>
    fxGaps(
      db.select({ date: schema.fxRates.date }).from(schema.fxRates).where(eq(schema.fxRates.currency, ccy)).orderBy(schema.fxRates.date).all().map((r) => r.date),
      from,
      today
    )
  );
  if (gaps.length === 0) return 0;
  const before = ecbRowCount();
  for (const [start, end] of fxRequestWindows(gaps)) await fetchFxRange(start, end);
  return ecbRowCount() - before;
}

/** ECB-reeksen aanvullen tot de eerste transactie en tot vandaag (zie dailyCoverage en ensureFxHistory). */
export const ensureFxCoverage = dailyCoverage("ECB", "de ECB", ensureFxHistory);

export function shiftDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000);
}
