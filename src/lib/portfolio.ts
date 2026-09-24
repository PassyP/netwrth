import Decimal from "decimal.js";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { Asset, Platform, Transaction } from "./db/schema";
import { processTransactions, cashFlows, type EngineTx, type EngineResult, type DisplayCurrency, type CostMethod } from "./calc/engine";
import { linkInternalTransfers, type TransferGroup } from "./calc/transfers";
import { BTC, btcFactor, fxNowSync } from "./prices/fx";
import { latestQuote, previousClose } from "./prices/quotes";
import { getSettings, type AppSettings } from "./settings";
import { CATEGORY_LABELS } from "./format";

export type Money = { EUR: string; USD: string; BTC: string };

export interface LotView {
  txId: number;
  internal: boolean; // uit een overboeking tussen eigen platforms: kostprijs meegenomen, geen nieuwe inleg
  executedAt: string;
  quantityOpen: string;
  quantityOriginal: string;
  pricePerUnit: string;
  costOpen: string;
  cost: Money;
  value: Money;
  unrealized: Money;
  unrealizedPct: string;
}

export interface RealizedView {
  txId: number;
  executedAt: string;
  quantity: string;
  proceeds: string;
  cost: string;
  pnl: Money;
}

export interface PositionView {
  key: string;
  assetId: number;
  symbol: string;
  name: string;
  category: string;
  currency: string;
  costCurrency: string; // valuta van de transacties (kostprijs, lots)
  priceSource: string;
  logoUrl: string | null;
  platformId: number;
  platformName: string;
  quantity: string;
  avgCost: string;
  price: string | null;
  priceMissing: boolean;
  priceCurrency: string | null;
  priceTime: string | null;
  previousClose: string | null;
  value: Money;
  cost: Money;
  unrealized: Money;
  unrealizedPct: Money;
  dayChange: Money;
  dayChangePct: string | null;
  realized: Money;
  income: Money;
  fees: Money;
  debt: Money;
  netValue: Money;
  lots: LotView[];
  realizedEvents: RealizedView[];
  warnings: string[];
}

export interface AllocationSlice {
  key: string;
  label: string;
  value: Money;
  pct: number;
  color?: string;
}

export interface PortfolioView {
  portfolioId: number | null;
  displayCurrency: DisplayCurrency;
  hideDust: boolean; // weergave-instelling; meegestuurd zodat een pagina niet van de shell afhangt
  totals: {
    value: Money;
    netValue: Money;
    cost: Money;
    unrealized: Money;
    unrealizedPct: Money;
    realized: Money;
    income: Money;
    fees: Money;
    dayChange: Money;
    dayChangePct: Money;
    totalResult: Money;
    returnPct: Money;
    totalBuyCost: Money;
    debt: Money;
  };
  positions: PositionView[];
  allocation: { byCategory: AllocationSlice[]; byPlatform: AllocationSlice[]; byCurrency: AllocationSlice[]; byAsset: AllocationSlice[] };
  cash: { platformId: number; platformName: string; currency: string; amount: string }[];
  lastUpdated: string | null;
  fxMissing: string[];
}

const ZERO = new Decimal(0);

/** De munt bitcoin (niet een aandeel of ETF met ticker BTC): in de BTC-weergave is 1 BTC altijd precies ₿1. */
export function isBitcoin(a: Pick<Asset, "symbol" | "category">): boolean {
  return a.category === "crypto" && a.symbol.toUpperCase() === "BTC";
}
const money = (eur: Decimal, usd: Decimal, btc: Decimal): Money => ({ EUR: eur.toFixed(2), USD: usd.toFixed(2), BTC: btc.toFixed(8) });
const pct = (num: Decimal, den: Decimal): string => (den.eq(0) ? "0.00" : num.div(den).mul(100).toFixed(2));

export function toEngineTx(t: Transaction): EngineTx {
  return {
    id: t.id,
    type: t.type,
    quantity: t.quantity,
    price: t.price,
    fee: t.fee,
    currency: t.currency,
    executedAt: t.executedAt,
    fxEur: t.fxEur,
    fxUsd: t.fxUsd,
    fxBtc: btcFactor(t.fxEur, t.currency, t.executedAt),
  };
}

interface GroupCalc {
  asset: Asset;
  platform: Platform;
  txs: Transaction[];
  result: EngineResult;
}

/**
 * Transacties per (asset, platform) als engine-invoer, met overboekingen tussen eigen platforms gekoppeld: een ontvangst
 * die bij een opname elders hoort, krijgt de kostprijs van de zender mee (zie calc/transfers.ts). Neem álle transacties
 * mee, ook uit andere portfolios, zodat de tegenpartij van een overboeking altijd zichtbaar is.
 */
export function linkedEngineTxs(all: Transaction[], method: CostMethod): Map<string, EngineTx[]> {
  const byKey = new Map<string, TransferGroup>();
  for (const t of all) {
    if (t.assetId == null) continue;
    const key = `${t.assetId}-${t.platformId}`;
    if (!byKey.has(key)) byKey.set(key, { key, assetId: t.assetId, platformId: t.platformId, txs: [] });
    byKey.get(key)!.txs.push(toEngineTx(t));
  }
  // wallet-koppelingen met "geen kostprijs voor ontvangsten zonder tegenpartij": zulke API-ontvangsten tellen niet als inleg
  const zeroPlatforms = new Set(
    getDb()
      .select()
      .from(schema.connections)
      .all()
      .filter((c) => c.provider === "bitcoin" && c.receiptCost === "none")
      .map((c) => c.platformId)
  );
  const zeroCostIds = new Set(all.filter((t) => zeroPlatforms.has(t.platformId) && t.type === "transfer_in" && t.source === "api" && (t.externalId ?? "").startsWith("btc:")).map((t) => t.id));
  return linkInternalTransfers([...byKey.values()], method, { zeroCostIds }).txs;
}

export function loadTransactions(portfolioId: number | null): Transaction[] {
  const db = getDb();
  const q = db.select().from(schema.transactions);
  const rows = portfolioId == null ? q.all() : q.where(eq(schema.transactions.portfolioId, portfolioId)).all();
  if (portfolioId != null) return rows;
  // Alles = alleen niet-gearchiveerde portfolios
  const active = new Set(db.select().from(schema.portfolios).where(eq(schema.portfolios.archived, false)).all().map((p) => p.id));
  return rows.filter((r) => active.has(r.portfolioId));
}

export function computePortfolio(portfolioId: number | null, settingsOverride?: Partial<AppSettings>): PortfolioView {
  const db = getDb();
  const settings = { ...getSettings(), ...settingsOverride };
  const txs = loadTransactions(portfolioId);
  const assets = new Map(db.select().from(schema.assets).all().map((a) => [a.id, a]));
  const platforms = new Map(db.select().from(schema.platforms).all().map((p) => [p.id, p]));
  const fxMissing = new Set<string>();

  const groups = new Map<string, GroupCalc>();
  for (const t of txs) {
    if (t.assetId == null) continue;
    const asset = assets.get(t.assetId);
    const platform = platforms.get(t.platformId);
    if (!asset || !platform) continue;
    const key = `${t.assetId}-${t.platformId}`;
    if (!groups.has(key)) groups.set(key, { asset, platform, txs: [], result: null as unknown as EngineResult });
    groups.get(key)!.txs.push(t);
  }

  const positions: PositionView[] = [];
  let lastUpdated: string | null = null;
  const T = {
    value: [ZERO, ZERO, ZERO],
    cost: [ZERO, ZERO, ZERO],
    realized: [ZERO, ZERO, ZERO],
    income: [ZERO, ZERO, ZERO],
    fees: [ZERO, ZERO, ZERO],
    dayChange: [ZERO, ZERO, ZERO],
    prevValue: [ZERO, ZERO, ZERO],
    buyCost: [ZERO, ZERO, ZERO],
    debt: [ZERO, ZERO, ZERO],
  };

  const fxCache = new Map<string, { fxEur: Decimal; fxUsd: Decimal; fxBtc: Decimal }>();
  const fxNow = (ccy: string) => {
    if (!fxCache.has(ccy)) {
      const f = fxNowSync(ccy);
      if (!f) {
        fxMissing.add(ccy);
        fxCache.set(ccy, { fxEur: new Decimal(ccy === "EUR" ? 1 : 0), fxUsd: new Decimal(ccy === "USD" ? 1 : 0), fxBtc: new Decimal(ccy === BTC ? 1 : 0) });
      } else {
        if (!f.fxBtc) fxMissing.add(BTC);
        fxCache.set(ccy, { ...f, fxBtc: f.fxBtc ?? ZERO });
      }
    }
    return fxCache.get(ccy)!;
  };

  // overboekingen tussen eigen platforms: de kostprijs verhuist mee; de tegenpartij kan in een ander portfolio staan
  const linked = linkedEngineTxs(portfolioId == null ? txs : loadTransactions(null), settings.costMethod);
  for (const [key, g] of groups) {
    const ids = new Set(g.txs.map((t) => t.id));
    g.result = processTransactions((linked.get(key) ?? g.txs.map(toEngineTx)).filter((t) => ids.has(t.id)), settings.costMethod);
    const r = g.result;
    const a = g.asset;
    const q = latestQuote(a.id);
    const prevClose = previousClose(a.id);
    if (q && (!lastUpdated || q.ts > lastUpdated)) lastUpdated = q.ts;
    // zonder koers: waarderen tegen gemiddelde kostprijs (gemarkeerd als priceMissing). Die kostprijs staat in de
    // transactievaluta, dus ook de omrekening loopt via die valuta — niet via assets.currency, want een crypto-asset staat
    // altijd in USD terwijl de transacties (import, Kraken) vaak in EUR zijn (zie history.ts, dat s.currency gebruikt).
    const priceMissing = !q;
    const costCurrency = g.txs[0]?.currency ?? a.currency;
    const priceCcy = q?.currency ?? costCurrency;
    const fxP = fxNow(priceCcy);
    const fxA = fxNow(costCurrency);
    const price = q ? new Decimal(q.price) : r.quantity.gt(0) ? r.avgCost : null;

    const valueNative = price ? r.quantity.mul(price) : ZERO;
    const valueEur = valueNative.mul(fxP.fxEur);
    const valueUsd = valueNative.mul(fxP.fxUsd);
    // Bitcoin zelf telt 1:1: via koers → EUR/USD → BTC-EUR zou 0,1 BTC als 0,0999 BTC verschijnen
    const isBtc = isBitcoin(a);
    const toBtc = (native: Decimal) => (isBtc && price && !price.isZero() ? native.div(price) : native.mul(fxP.fxBtc));
    const valueBtc = toBtc(valueNative);

    // kostprijs in weergavevaluta: historisch (standaard) of tegen koers van vandaag
    const costEur = settings.ignoreFx ? r.cost.mul(fxA.fxEur) : r.costEur;
    const costUsd = settings.ignoreFx ? r.cost.mul(fxA.fxUsd) : r.costUsd;
    const costBtc = settings.ignoreFx ? r.cost.mul(fxA.fxBtc) : r.costBtc;
    const realizedEur = settings.ignoreFx ? r.realizedPnl.mul(fxA.fxEur) : r.realizedPnlEur;
    const realizedUsd = settings.ignoreFx ? r.realizedPnl.mul(fxA.fxUsd) : r.realizedPnlUsd;
    const realizedBtc = settings.ignoreFx ? r.realizedPnl.mul(fxA.fxBtc) : r.realizedPnlBtc;
    const buyCostEur = settings.ignoreFx ? r.totalBuyCost.mul(fxA.fxEur) : r.totalBuyCostEur;
    const buyCostUsd = settings.ignoreFx ? r.totalBuyCost.mul(fxA.fxUsd) : r.totalBuyCostUsd;
    const buyCostBtc = settings.ignoreFx ? r.totalBuyCost.mul(fxA.fxBtc) : r.totalBuyCostBtc;

    // verandering vandaag
    let dayEur = ZERO;
    let dayUsd = ZERO;
    let dayBtc = ZERO;
    let dayPct: string | null = null;
    if (price && prevClose) {
      const diff = price.minus(prevClose).mul(r.quantity);
      dayEur = diff.mul(fxP.fxEur);
      dayUsd = diff.mul(fxP.fxUsd);
      dayBtc = isBtc ? ZERO : diff.mul(fxP.fxBtc);
      dayPct = pct(price.minus(prevClose), new Decimal(prevClose));
      T.prevValue[0] = T.prevValue[0].plus(new Decimal(prevClose).mul(r.quantity).mul(fxP.fxEur));
      T.prevValue[1] = T.prevValue[1].plus(new Decimal(prevClose).mul(r.quantity).mul(fxP.fxUsd));
      T.prevValue[2] = T.prevValue[2].plus(isBtc ? valueBtc : new Decimal(prevClose).mul(r.quantity).mul(fxP.fxBtc));
    } else {
      T.prevValue[0] = T.prevValue[0].plus(valueEur);
      T.prevValue[1] = T.prevValue[1].plus(valueUsd);
      T.prevValue[2] = T.prevValue[2].plus(valueBtc);
    }

    // vastgoed: schuld uit laatste waardering
    let debtEur = ZERO;
    let debtUsd = ZERO;
    let debtBtc = ZERO;
    if (a.category === "real_estate") {
      const v = db.select().from(schema.valuations).where(eq(schema.valuations.assetId, a.id)).orderBy(desc(schema.valuations.date), desc(schema.valuations.id)).limit(1).get();
      if (v && new Decimal(v.debt).gt(0)) {
        const f = fxNow(v.currency);
        debtEur = new Decimal(v.debt).mul(f.fxEur);
        debtUsd = new Decimal(v.debt).mul(f.fxUsd);
        debtBtc = new Decimal(v.debt).mul(f.fxBtc);
      }
    }

    const lots: LotView[] = r.lots
      .filter((l) => l.quantityOpen.gt(0))
      .map((l) => {
        const lv = price ? l.quantityOpen.mul(price) : ZERO;
        const lvEur = lv.mul(fxP.fxEur);
        const lvUsd = lv.mul(fxP.fxUsd);
        const lvBtc = toBtc(lv);
        const lcEur = settings.ignoreFx ? l.costOpen.mul(fxA.fxEur) : l.costOpenEur;
        const lcUsd = settings.ignoreFx ? l.costOpen.mul(fxA.fxUsd) : l.costOpenUsd;
        const lcBtc = settings.ignoreFx ? l.costOpen.mul(fxA.fxBtc) : l.costOpenBtc;
        return {
          txId: l.txId,
          internal: !!l.internal,
          executedAt: l.executedAt,
          quantityOpen: l.quantityOpen.toFixed(8),
          quantityOriginal: l.quantityOriginal.toFixed(8),
          pricePerUnit: l.pricePerUnit.toFixed(6),
          costOpen: l.costOpen.toFixed(2),
          cost: money(lcEur, lcUsd, lcBtc),
          value: money(lvEur, lvUsd, lvBtc),
          unrealized: money(lvEur.minus(lcEur), lvUsd.minus(lcUsd), lvBtc.minus(lcBtc)),
          unrealizedPct: pct(lv.minus(l.costOpen), l.costOpen),
        };
      });

    const realizedEvents: RealizedView[] = r.realized.map((e) => ({
      txId: e.txId,
      executedAt: e.executedAt,
      quantity: e.quantity.toFixed(8),
      proceeds: e.proceeds.toFixed(2),
      cost: e.cost.toFixed(2),
      pnl: money(
        settings.ignoreFx ? e.pnl.mul(fxA.fxEur) : e.pnlEur,
        settings.ignoreFx ? e.pnl.mul(fxA.fxUsd) : e.pnlUsd,
        settings.ignoreFx ? e.pnl.mul(fxA.fxBtc) : e.pnlBtc
      ),
    }));

    const unrealizedEur = valueEur.minus(costEur);
    const unrealizedUsd = valueUsd.minus(costUsd);
    const unrealizedBtc = valueBtc.minus(costBtc);

    positions.push({
      key: `${a.id}-${g.platform.id}`,
      assetId: a.id,
      symbol: a.symbol,
      name: a.name,
      category: a.category,
      currency: a.currency,
      costCurrency,
      priceSource: a.priceSource,
      logoUrl: a.logoUrl,
      platformId: g.platform.id,
      platformName: g.platform.name,
      quantity: r.quantity.toFixed(8),
      avgCost: r.avgCost.toFixed(6),
      price: price ? price.toFixed(6) : null,
      priceMissing,
      priceCurrency: priceCcy,
      priceTime: q?.ts ?? null,
      previousClose: prevClose,
      value: money(valueEur, valueUsd, valueBtc),
      cost: money(costEur, costUsd, costBtc),
      unrealized: money(unrealizedEur, unrealizedUsd, unrealizedBtc),
      unrealizedPct: { EUR: pct(unrealizedEur, costEur), USD: pct(unrealizedUsd, costUsd), BTC: pct(unrealizedBtc, costBtc) },
      dayChange: money(dayEur, dayUsd, dayBtc),
      dayChangePct: dayPct,
      realized: money(realizedEur, realizedUsd, realizedBtc),
      income: money(r.incomeEur, r.incomeUsd, r.incomeBtc),
      fees: money(r.feesEur, r.feesUsd, r.feesBtc),
      debt: money(debtEur, debtUsd, debtBtc),
      netValue: money(valueEur.minus(debtEur), valueUsd.minus(debtUsd), valueBtc.minus(debtBtc)),
      lots,
      realizedEvents,
      warnings: r.warnings,
    });

    T.value[0] = T.value[0].plus(valueEur);
    T.value[1] = T.value[1].plus(valueUsd);
    T.value[2] = T.value[2].plus(valueBtc);
    T.cost[0] = T.cost[0].plus(costEur);
    T.cost[1] = T.cost[1].plus(costUsd);
    T.cost[2] = T.cost[2].plus(costBtc);
    T.realized[0] = T.realized[0].plus(realizedEur);
    T.realized[1] = T.realized[1].plus(realizedUsd);
    T.realized[2] = T.realized[2].plus(realizedBtc);
    T.income[0] = T.income[0].plus(r.incomeEur);
    T.income[1] = T.income[1].plus(r.incomeUsd);
    T.income[2] = T.income[2].plus(r.incomeBtc);
    T.fees[0] = T.fees[0].plus(r.feesEur);
    T.fees[1] = T.fees[1].plus(r.feesUsd);
    T.fees[2] = T.fees[2].plus(r.feesBtc);
    T.dayChange[0] = T.dayChange[0].plus(dayEur);
    T.dayChange[1] = T.dayChange[1].plus(dayUsd);
    T.dayChange[2] = T.dayChange[2].plus(dayBtc);
    T.buyCost[0] = T.buyCost[0].plus(buyCostEur);
    T.buyCost[1] = T.buyCost[1].plus(buyCostUsd);
    T.buyCost[2] = T.buyCost[2].plus(buyCostBtc);
    T.debt[0] = T.debt[0].plus(debtEur);
    T.debt[1] = T.debt[1].plus(debtUsd);
    T.debt[2] = T.debt[2].plus(debtBtc);
  }

  // losse kosten zonder asset (bijv. bewaarloon op platformniveau)
  for (const t of txs) {
    if (t.assetId != null || t.type !== "fee") continue;
    const e = toEngineTx(t);
    const amount = new Decimal(t.price).plus(t.fee);
    const fE = t.currency === "EUR" ? new Decimal(1) : new Decimal(e.fxEur ?? fxNow(t.currency).fxEur);
    const fU = t.currency === "USD" ? new Decimal(1) : new Decimal(e.fxUsd ?? fxNow(t.currency).fxUsd);
    const fB = e.fxBtc != null ? new Decimal(e.fxBtc) : ZERO;
    T.fees[0] = T.fees[0].plus(amount.mul(fE));
    T.fees[1] = T.fees[1].plus(amount.mul(fU));
    T.fees[2] = T.fees[2].plus(amount.mul(fB));
  }

  positions.sort((a, b) => new Decimal(b.value.EUR).minus(a.value.EUR).toNumber());

  const unrealized = [0, 1, 2].map((i) => T.value[i].minus(T.cost[i]));
  const totalResult = [0, 1, 2].map((i) => unrealized[i].plus(T.realized[i]).plus(T.income[i]).minus(T.fees[i]));

  // allocatie op basis van netto waarde (vastgoed minus schuld)
  const netTotal = [0, 1, 2].map((i) => T.value[i].minus(T.debt[i]));
  const slices = (keyOf: (p: PositionView) => string, labelOf: (p: PositionView) => string): AllocationSlice[] => {
    const m = new Map<string, { label: string; eur: Decimal; usd: Decimal; btc: Decimal }>();
    for (const p of positions) {
      const k = keyOf(p);
      const cur = m.get(k) ?? { label: labelOf(p), eur: ZERO, usd: ZERO, btc: ZERO };
      cur.eur = cur.eur.plus(p.netValue.EUR);
      cur.usd = cur.usd.plus(p.netValue.USD);
      cur.btc = cur.btc.plus(p.netValue.BTC);
      m.set(k, cur);
    }
    return [...m.entries()]
      .map(([key, v]) => ({ key, label: v.label, value: money(v.eur, v.usd, v.btc), pct: netTotal[0].eq(0) ? 0 : v.eur.div(netTotal[0]).mul(100).toDecimalPlaces(2).toNumber() }))
      .sort((a, b) => b.pct - a.pct);
  };

  // kas per platform/valuta
  const cash: PortfolioView["cash"] = [];
  const byPlatform = new Map<number, Transaction[]>();
  for (const t of txs) {
    if (!byPlatform.has(t.platformId)) byPlatform.set(t.platformId, []);
    byPlatform.get(t.platformId)!.push(t);
  }
  for (const [pid, list] of byPlatform) {
    if (!list.some((t) => t.type === "deposit" || t.type === "withdrawal")) continue; // alleen platforms waar je kas bijhoudt
    const flows = cashFlows(list.map(toEngineTx));
    for (const [ccy, amt] of Object.entries(flows)) {
      if (amt.abs().lt("0.005")) continue;
      cash.push({ platformId: pid, platformName: platforms.get(pid)?.name ?? "?", currency: ccy, amount: amt.toFixed(2) });
    }
  }

  return {
    portfolioId,
    displayCurrency: settings.displayCurrency,
    hideDust: settings.hideDust,
    totals: {
      value: money(T.value[0], T.value[1], T.value[2]),
      netValue: money(netTotal[0], netTotal[1], netTotal[2]),
      cost: money(T.cost[0], T.cost[1], T.cost[2]),
      unrealized: money(unrealized[0], unrealized[1], unrealized[2]),
      unrealizedPct: { EUR: pct(unrealized[0], T.cost[0]), USD: pct(unrealized[1], T.cost[1]), BTC: pct(unrealized[2], T.cost[2]) },
      realized: money(T.realized[0], T.realized[1], T.realized[2]),
      income: money(T.income[0], T.income[1], T.income[2]),
      fees: money(T.fees[0], T.fees[1], T.fees[2]),
      dayChange: money(T.dayChange[0], T.dayChange[1], T.dayChange[2]),
      dayChangePct: { EUR: pct(T.dayChange[0], T.prevValue[0]), USD: pct(T.dayChange[1], T.prevValue[1]), BTC: pct(T.dayChange[2], T.prevValue[2]) },
      totalResult: money(totalResult[0], totalResult[1], totalResult[2]),
      returnPct: { EUR: pct(totalResult[0], T.buyCost[0]), USD: pct(totalResult[1], T.buyCost[1]), BTC: pct(totalResult[2], T.buyCost[2]) },
      totalBuyCost: money(T.buyCost[0], T.buyCost[1], T.buyCost[2]),
      debt: money(T.debt[0], T.debt[1], T.debt[2]),
    },
    positions,
    allocation: {
      byCategory: slices((p) => p.category, (p) => CATEGORY_LABELS[p.category] ?? p.category),
      byPlatform: slices((p) => String(p.platformId), (p) => p.platformName),
      byCurrency: slices((p) => p.currency, (p) => p.currency),
      byAsset: slices((p) => String(p.assetId), (p) => p.symbol),
    },
    cash,
    lastUpdated,
    fxMissing: [...fxMissing],
  };
}
