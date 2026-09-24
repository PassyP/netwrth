import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { Asset, Transaction } from "./db/schema";
import { processTransactions, type CostMethod, type EngineTx, type PositionStep } from "./calc/engine";
import { loadTransactions, toEngineTx, computePortfolio, isBitcoin, linkedEngineTxs, type Money } from "./portfolio";
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

const ZERO = new Decimal(0);

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

interface CachedTimeline {
  version: string;
  steps: PositionStep[];
}

/**
 * Tijdlijnen per groep (asset+platform) in het geheugen van het proces. De lot-berekening is verreweg het duurste deel
 * van een historie-verzoek (honderden ms bij honderden verkopen met gemiddelde kostprijs), terwijl de uitkomst alleen
 * afhangt van de transacties in de groep, de kostprijsmethode en de BTC-reeks. Sleutel: bereik (portfolio of alles) en
 * methode; per groep een versie met precies de velden die de rekenkern ziet, zodat elke toevoeging, wijziging of
 * verwijdering van een transactie alleen die groep opnieuw laat berekenen. De stappen zijn onveranderlijk en worden
 * tussen verzoeken gedeeld; lezers mogen ze niet wijzigen.
 */
const timelineCache = new Map<string, Map<string, CachedTimeline>>();

/**
 * Versie van een groep: de transactievelden die toEngineTx doorgeeft, op id gesorteerd. fxBtc staat niet in de
 * transactie maar wordt bij het laden uit fxEur, valuta, datum en de BTC-reeks berekend (btcFactor); daarom telt de
 * BTC-reeks als geheel mee (fxBtcVersion) in plaats van per transactie een koers op te zoeken, wat ~100 ms per verzoek
 * kostte. Verandert een BTC-koers, dan worden alle groepen opnieuw berekend.
 */
function timelineVersion(txs: EngineTx[], fxBtcVersion: string): string {
  // engine-invoer, dus inclusief de meegenomen kostprijs van een interne overboeking (die hangt af van andere groepen)
  const rows = txs
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((t) => [t.id, t.type, t.quantity, t.price, t.fee, t.currency, t.executedAt, t.fxEur, t.fxUsd, t.fxBtc ?? "", t.internal ? "i" : ""].join("|"));
  return `${fxBtcVersion}\n${rows.join("\n")}`;
}

function cachedTimelines(portfolioId: number | null, method: CostMethod, groups: Map<string, EngineTx[]>, fxBtcVersion: string): Map<string, PositionStep[]> {
  const scope = `${portfolioId ?? "all"}|${method}`;
  const known = timelineCache.get(scope);
  const kept = new Map<string, CachedTimeline>();
  const timelines = new Map<string, PositionStep[]>();
  for (const [k, list] of groups) {
    const version = timelineVersion(list, fxBtcVersion);
    let entry = known?.get(k);
    if (!entry || entry.version !== version) {
      const steps: PositionStep[] = [];
      processTransactions(list, method, (st) => steps.push(st));
      entry = { version, steps };
    }
    kept.set(k, entry);
    timelines.set(k, entry.steps);
  }
  timelineCache.set(scope, kept); // groepen die niet meer voorkomen (verwijderd, ander portfolio) vallen weg
  return timelines;
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
  // De groepen die in de grafiek meetellen. De tijdlijnen worden wel voor alle groepen opgevraagd (cachedTimelines
  // bewaart per bereik alleen wat je meegeeft), zodat een gefilterde grafiek de cache van het totaalbeeld niet leegt.
  const shown = filter ? new Map([...groups].filter(([, list]) => inFilter(filter, list[0], assets.get(list[0].assetId!)))) : groups;
  if (shown.size === 0) return [];
  const shownAssets = new Set([...shown.values()].map((list) => list[0].assetId!));

  // koersen per asset
  const quotes = new Map<number, { day: string; price: Decimal; currency: string }[]>();
  for (const assetId of shownAssets) {
    const rows = db.select().from(schema.priceQuotes).where(eq(schema.priceQuotes.assetId, assetId)).orderBy(schema.priceQuotes.day).all();
    quotes.set(assetId, rows.map((r) => ({ day: r.day, price: new Decimal(r.price), currency: r.currency })));
  }
  // schuld (vastgoed) per asset
  const debts = new Map<number, { day: string; debt: Decimal; currency: string }[]>();
  for (const assetId of shownAssets) {
    if (assets.get(assetId)?.category !== "real_estate") continue;
    const rows = db.select().from(schema.valuations).where(eq(schema.valuations.assetId, assetId)).orderBy(schema.valuations.date).all();
    debts.set(assetId, rows.map((r) => ({ day: r.date, debt: new Decimal(r.debt), currency: r.currency })));
  }
  // wisselkoersen per valuta (1 EUR = x)
  const fxRows = db.select().from(schema.fxRates).orderBy(schema.fxRates.date).all();
  const fx = new Map<string, { day: string; rate: Decimal }[]>();
  for (const r of fxRows) {
    if (!fx.has(r.currency)) fx.set(r.currency, []);
    fx.get(r.currency)!.push({ day: r.date, rate: new Decimal(r.ratePerEur) });
  }
  const rateOn = (ccy: string, day: string): Decimal | null => (ccy === "EUR" ? new Decimal(1) : lastOnOrBefore(fx.get(ccy) ?? [], day)?.rate ?? null);
  // zonder BTC-koers op die dag telt het bedrag als 0 BTC; EUR en USD blijven kloppen
  const toEurUsdBtc = (amount: Decimal, ccy: string, day: string): [Decimal, Decimal, Decimal] | null => {
    const rC = rateOn(ccy, day);
    const rU = rateOn("USD", day);
    if (!rC || !rU) return null;
    const eur = amount.div(rC);
    return [eur, eur.mul(rU), eur.mul(rateOn(BTC, day) ?? ZERO)];
  };

  const firstDay = [...shown.values()].map((list) => list[0].executedAt.slice(0, 10)).sort()[0];
  let day = fromDay && fromDay > firstDay ? fromDay : firstDay;
  const end = todayStr();
  const points: HistoryPoint[] = [];

  // Per groep één keer door de transacties: een tijdlijn van de open positie na elke transactie. De dag-loop schuift
  // daarna alleen een index op; eerder werd per transactie de hele lot-berekening vanaf het begin herhaald (kwadratisch).
  // De tijdlijnen blijven in het geheugen zolang de transacties van de groep en de BTC-reeks niet veranderen (zie
  // cachedTimelines).
  const fxBtcVersion = fxRows
    .filter((r) => r.currency === BTC)
    .map((r) => `${r.date}=${r.ratePerEur}`)
    .join(",");
  // engine-invoer per groep, met overboekingen tussen eigen platforms gekoppeld (zelfde koppeling als het overzicht)
  const linked = linkedEngineTxs(portfolioId == null ? txs : loadTransactions(null).filter((t) => t.assetId != null), settings.costMethod);
  const engineGroups = new Map<string, EngineTx[]>();
  for (const [k, list] of groups) {
    const ids = new Set(list.map((t) => t.id));
    engineGroups.set(k, (linked.get(k) ?? list.map(toEngineTx)).filter((t) => ids.has(t.id)));
  }
  const timelines = cachedTimelines(portfolioId, settings.costMethod, engineGroups, fxBtcVersion);
  const state = new Map<string, { idx: number; quantity: Decimal; cost: Decimal; costEur: Decimal; costUsd: Decimal; costBtc: Decimal; currency: string }>();
  for (const [k, list] of shown) {
    state.set(k, { idx: 0, quantity: ZERO, cost: ZERO, costEur: ZERO, costUsd: ZERO, costBtc: ZERO, currency: list[0].currency });
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
      s.quantity = st.quantity;
      s.cost = st.cost;
      s.costEur = st.costEur;
      s.costUsd = st.costUsd;
      s.costBtc = st.costBtc;
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
    let vE = ZERO;
    let vU = ZERO;
    let vB = ZERO;
    let iE = ZERO;
    let iU = ZERO;
    let iB = ZERO;
    for (const [k, list] of shown) {
      advance(k, day);
      const s = state.get(k)!;
      if (s.quantity.lte(0)) continue;
      const assetId = list[0].assetId!;
      const q = lastOnOrBefore(quotes.get(assetId) ?? [], day);
      // zonder koers op die dag: waarderen tegen kostprijs
      const conv = q ? toEurUsdBtc(s.quantity.mul(q.price), q.currency, day) : toEurUsdBtc(s.cost, s.currency, day);
      if (conv) {
        vE = vE.plus(conv[0]);
        vU = vU.plus(conv[1]);
        // Bitcoin zelf telt 1:1 (zie isBitcoin)
        vB = vB.plus(q && isBitcoin(assets.get(assetId)!) ? s.quantity : conv[2]);
      }
      const d = lastOnOrBefore(debts.get(assetId) ?? [], day);
      if (d && d.debt.gt(0)) {
        const conv = toEurUsdBtc(d.debt, d.currency, day);
        if (conv) {
          vE = vE.minus(conv[0]);
          vU = vU.minus(conv[1]);
          vB = vB.minus(conv[2]);
        }
      }
      if (settings.ignoreFx) {
        const conv = toEurUsdBtc(s.cost, s.currency, day);
        if (conv) {
          iE = iE.plus(conv[0]);
          iU = iU.plus(conv[1]);
          iB = iB.plus(conv[2]);
        }
      } else {
        iE = iE.plus(s.costEur);
        iU = iU.plus(s.costUsd);
        iB = iB.plus(s.costBtc);
      }
    }
    prev = {
      date: day,
      value: { EUR: vE.toFixed(2), USD: vU.toFixed(2), BTC: vB.toFixed(8) },
      invested: { EUR: iE.toFixed(2), USD: iU.toFixed(2), BTC: iB.toFixed(8) },
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
