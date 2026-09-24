import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { Asset, Transaction } from "./db/schema";
import type { EngineTx } from "./calc/engine";
import { loadTransactions, toEngineTx, computePortfolio, isBitcoin, linkedEngineTxs, engineRuns, type Money } from "./portfolio";
import { getSettings } from "./settings";
import { BTC, shiftDays } from "./prices/fx";

export interface HistoryPoint {
  date: string;
  value: Money;
  invested: Money;
}

/**
 * Deel van het portfolio voor de grafiek, met dezelfde sleutels als de allocatie: categorie, platform-id, valuta van
 * het asset en asset-id. Een aangeklikt segment van de donut is één veld; de filters van het overzicht (categorie en
 * platform) mogen samen, en tellen dan allebei.
 */
export const HISTORY_FILTERS = ["category", "platform", "currency", "asset"] as const;
export type HistoryFilter = Partial<Record<(typeof HISTORY_FILTERS)[number], string>>;

function inFilter(filter: HistoryFilter, t: Transaction, asset: Asset | undefined): boolean {
  if (filter.category != null && asset?.category !== filter.category) return false;
  if (filter.platform != null && String(t.platformId) !== filter.platform) return false;
  if (filter.currency != null && asset?.currency !== filter.currency) return false;
  if (filter.asset != null && String(t.assetId) !== filter.asset) return false;
  return true;
}

/** Bedrag met vaste decimalen; een heel klein negatief getal uit de afronding wordt geen "-0.00". */
function fixed(v: number, digits: number): string {
  return (Math.abs(v) < 0.5 / 10 ** digits ? 0 : v).toFixed(digits);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Sorted lookup: laatste element met key <= day. */
function lastOnOrBefore<T extends { day: string }>(arr: T[], day: string): T | null {
  let lo = 0;
  let hi = arr.length - 1;
  let ans: T | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].day <= day) {
      ans = arr[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * Waarde en inleg per dag, berekend uit transacties, dagslotkoersen en ECB-koersen.
 * Inleg = kostprijs van de open lots op die dag (historische wisselkoers, of koers van de dag bij ignoreFx).
 * Met `filter` alleen de groepen die daaraan voldoen; de reeks begint dan bij de eerste transactie daarvan.
 */
export function computeHistory(portfolioId: number | null, fromDay?: string, filter?: HistoryFilter): HistoryPoint[] {
  const db = getDb();
  const settings = getSettings();
  const txs = loadTransactions(portfolioId).filter((t) => t.assetId != null);
  if (txs.length === 0) return [];
  const assets = new Map(db.select().from(schema.assets).all().map((a) => [a.id, a]));

  // groepen per asset+platform
  const groups = new Map<string, Transaction[]>();
  for (const t of txs) {
    const k = `${t.assetId}-${t.platformId}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }
  for (const list of groups.values()) list.sort((a, b) => (a.executedAt < b.executedAt ? -1 : 1));
  // De groepen die in de grafiek meetellen. De tijdlijnen worden wel voor alle groepen opgevraagd (engineRuns bewaart
  // per bereik alleen wat je meegeeft), zodat een gefilterde grafiek de cache van het totaalbeeld niet leegt.
  const shown = filter ? new Map([...groups].filter(([, list]) => inFilter(filter, list[0], assets.get(list[0].assetId!)))) : groups;
  if (shown.size === 0) return [];
  const shownAssets = new Set([...shown.values()].map((list) => list[0].assetId!));

  // Koersen, schulden en wisselkoersen als gewone getallen: de dag-loop rekent voor elke dag en elke groep, en met Decimal
  // was dat bij jaren historie het grootste deel van een verzoek. Voor een grafiek is een double ruim precies genoeg (de
  // bedragen gaan met 2 of 8 decimalen de deur uit); de lot-berekening zelf (engineRuns) blijft exact.
  const quotes = new Map<number, { day: string; price: number; currency: string }[]>();
  for (const assetId of shownAssets) {
    const rows = db
      .select({ day: schema.priceQuotes.day, price: schema.priceQuotes.price, currency: schema.priceQuotes.currency })
      .from(schema.priceQuotes)
      .where(eq(schema.priceQuotes.assetId, assetId))
      .orderBy(schema.priceQuotes.day)
      .all();
    quotes.set(assetId, rows.map((r) => ({ day: r.day, price: Number(r.price), currency: r.currency })));
  }
  // schuld (vastgoed) per asset
  const debts = new Map<number, { day: string; debt: number; currency: string }[]>();
  for (const assetId of shownAssets) {
    if (assets.get(assetId)?.category !== "real_estate") continue;
    const rows = db.select().from(schema.valuations).where(eq(schema.valuations.assetId, assetId)).orderBy(schema.valuations.date).all();
    debts.set(assetId, rows.map((r) => ({ day: r.date, debt: Number(r.debt), currency: r.currency })));
  }
  // wisselkoersen per valuta (1 EUR = x)
  const fxRows = db.select({ date: schema.fxRates.date, currency: schema.fxRates.currency, ratePerEur: schema.fxRates.ratePerEur }).from(schema.fxRates).orderBy(schema.fxRates.date).all();
  const fx = new Map<string, { day: string; rate: number }[]>();
  for (const r of fxRows) {
    if (!fx.has(r.currency)) fx.set(r.currency, []);
    fx.get(r.currency)!.push({ day: r.date, rate: Number(r.ratePerEur) });
  }
  const rateOn = (ccy: string, day: string): number | null => (ccy === "EUR" ? 1 : lastOnOrBefore(fx.get(ccy) ?? [], day)?.rate ?? null);

  const firstDay = [...shown.values()].map((list) => list[0].executedAt.slice(0, 10)).sort()[0];
  let day = fromDay && fromDay > firstDay ? fromDay : firstDay;
  const end = todayStr();
  const points: HistoryPoint[] = [];

  // Per groep één keer door de transacties: een tijdlijn van de open positie na elke transactie. De dag-loop schuift
  // daarna alleen een index op; eerder werd per transactie de hele lot-berekening vanaf het begin herhaald (kwadratisch).
  // De tijdlijnen blijven in het geheugen zolang de invoer van de groep niet verandert, en worden gedeeld met het
  // overzicht (zie engineRuns in portfolio.ts).
  // engine-invoer per groep, met overboekingen tussen eigen platforms gekoppeld (zelfde koppeling als het overzicht)
  const linked = linkedEngineTxs(portfolioId == null ? txs : loadTransactions(null).filter((t) => t.assetId != null), settings.costMethod);
  const engineGroups = new Map<string, EngineTx[]>();
  for (const [k, list] of groups) {
    const ids = new Set(list.map((t) => t.id));
    engineGroups.set(k, (linked.get(k) ?? list.map((t) => toEngineTx(t))).filter((t) => ids.has(t.id)));
  }
  const timelines = new Map([...engineRuns(portfolioId, settings.costMethod, engineGroups)].map(([k, run]) => [k, run.steps]));
  const state = new Map<string, { idx: number; quantity: number; cost: number; costEur: number; costUsd: number; costBtc: number; currency: string; assetId: number; btc: boolean }>();
  for (const [k, list] of shown) {
    const assetId = list[0].assetId!;
    const asset = assets.get(assetId);
    // Bitcoin zelf telt 1:1 (zie isBitcoin)
    state.set(k, { idx: 0, quantity: 0, cost: 0, costEur: 0, costUsd: 0, costBtc: 0, currency: list[0].currency, assetId, btc: asset ? isBitcoin(asset) : false });
  }
  // toestand tot en met upToDay
  const advance = (k: string, upToDay: string) => {
    const s = state.get(k)!;
    const steps = timelines.get(k)!;
    const cutoff = `${upToDay}T23:59:59.999Z`;
    let moved = false;
    while (s.idx < steps.length && steps[s.idx].executedAt <= cutoff) {
      s.idx++;
      moved = true;
    }
    if (moved) {
      const st = steps[s.idx - 1];
      s.quantity = st.quantity.toNumber();
      s.cost = st.cost.toNumber();
      s.costEur = st.costEur.toNumber();
      s.costUsd = st.costUsd.toNumber();
      s.costBtc = st.costBtc.toNumber();
    }
    return moved;
  };
  if (day > firstDay) for (const k of shown.keys()) advance(k, shiftDays(day, -1));

  // Dagen waarop de uitkomst kan veranderen: een transactie, koers, wisselkoers of waardering. Op alle andere dagen is
  // het punt gelijk aan dat van de dag ervoor en wordt het gekopieerd in plaats van opnieuw berekend.
  const eventDays = new Set<string>();
  for (const k of shown.keys()) for (const st of timelines.get(k)!) eventDays.add(st.executedAt.slice(0, 10));
  for (const rows of quotes.values()) for (const r of rows) eventDays.add(r.day);
  for (const rows of debts.values()) for (const r of rows) eventDays.add(r.day);
  for (const r of fxRows) eventDays.add(r.date);

  let prev: HistoryPoint | null = null;
  while (day <= end) {
    if (prev && !eventDays.has(day)) {
      const copy: HistoryPoint = { date: day, value: prev.value, invested: prev.invested };
      points.push(copy);
      prev = copy;
      day = shiftDays(day, 1);
      continue;
    }
    // wisselkoersen van deze dag: per valuta één keer opgezocht, niet per groep
    const rates = new Map<string, number | null>();
    const rate = (ccy: string): number | null => {
      if (!rates.has(ccy)) rates.set(ccy, rateOn(ccy, day));
      return rates.get(ccy)!;
    };
    // zonder BTC-koers op die dag telt het bedrag als 0 BTC; EUR en USD blijven kloppen
    const toEurUsdBtc = (amount: number, ccy: string): [number, number, number] | null => {
      const rC = rate(ccy);
      const rU = rate("USD");
      if (!rC || !rU) return null;
      const eur = amount / rC;
      return [eur, eur * rU, eur * (rate(BTC) ?? 0)];
    };
    let vE = 0;
    let vU = 0;
    let vB = 0;
    let iE = 0;
    let iU = 0;
    let iB = 0;
    for (const k of shown.keys()) {
      advance(k, day);
      const s = state.get(k)!;
      if (s.quantity <= 0) continue;
      const q = lastOnOrBefore(quotes.get(s.assetId) ?? [], day);
      // zonder koers op die dag: waarderen tegen kostprijs
      const conv = q ? toEurUsdBtc(s.quantity * q.price, q.currency) : toEurUsdBtc(s.cost, s.currency);
      if (conv) {
        vE += conv[0];
        vU += conv[1];
        vB += q && s.btc ? s.quantity : conv[2];
      }
      const d = lastOnOrBefore(debts.get(s.assetId) ?? [], day);
      if (d && d.debt > 0) {
        const debt = toEurUsdBtc(d.debt, d.currency);
        if (debt) {
          vE -= debt[0];
          vU -= debt[1];
          vB -= debt[2];
        }
      }
      if (settings.ignoreFx) {
        const cost = toEurUsdBtc(s.cost, s.currency);
        if (cost) {
          iE += cost[0];
          iU += cost[1];
          iB += cost[2];
        }
      } else {
        iE += s.costEur;
        iU += s.costUsd;
        iB += s.costBtc;
      }
    }
    prev = {
      date: day,
      value: { EUR: fixed(vE, 2), USD: fixed(vU, 2), BTC: fixed(vB, 8) },
      invested: { EUR: fixed(iE, 2), USD: fixed(iU, 2), BTC: fixed(iB, 8) },
    };
    points.push(prev);
    day = shiftDays(day, 1);
  }
  return points;
}

/** Dagelijkse snapshot per portfolio (wordt door de worker om 23:59 geschreven). */
export function takeSnapshots(date: string = todayStr()): number {
  const db = getDb();
  const portfolios = db.select().from(schema.portfolios).all();
  let n = 0;
  for (const p of portfolios) {
    const v = computePortfolio(p.id);
    db.insert(schema.portfolioSnapshots)
      .values({ portfolioId: p.id, date, valueEur: v.totals.netValue.EUR, valueUsd: v.totals.netValue.USD, investedEur: v.totals.cost.EUR, investedUsd: v.totals.cost.USD })
      .onConflictDoUpdate({
        target: [schema.portfolioSnapshots.portfolioId, schema.portfolioSnapshots.date],
        set: { valueEur: v.totals.netValue.EUR, valueUsd: v.totals.netValue.USD, investedEur: v.totals.cost.EUR, investedUsd: v.totals.cost.USD },
      })
      .run();
    n++;
  }
  db.insert(schema.jobRuns).values({ job: "snapshot", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ok: true, message: `${n} portfolios` }).run();
  return n;
}
