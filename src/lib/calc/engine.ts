import Decimal from "decimal.js";
import type { TxType } from "../db/schema";

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export type CostMethod = "average" | "fifo";
export type DisplayCurrency = "EUR" | "USD" | "BTC";

/** Minimale transactie-vorm die de rekenkern nodig heeft (alles decimale strings). */
export interface EngineTx {
  id: number;
  type: TxType;
  quantity: string;
  price: string; // per stuk bij buy/sell; totaalbedrag bij dividend/interest/staking/fee/deposit/withdrawal
  fee: string;
  currency: string;
  executedAt: string; // ISO
  fxEur: string | null; // 1 eenheid transactievaluta in EUR op transactiedatum
  fxUsd: string | null;
  fxBtc?: string | null; // 1 eenheid transactievaluta in BTC; berekend bij het laden (niet opgeslagen)
  /** transfer_in die een overboeking tussen eigen platforms is: prijs/fx dragen de meegenomen kostprijs, geen nieuwe inleg */
  internal?: boolean;
}

export interface Lot {
  txId: number;
  executedAt: string;
  pricePerUnit: Decimal; // aankoopprijs per stuk (excl. kosten)
  quantityOriginal: Decimal;
  costOriginal: Decimal; // incl. kosten, native
  quantityOpen: Decimal;
  costOpen: Decimal; // native
  costOpenEur: Decimal;
  costOpenUsd: Decimal;
  costOpenBtc: Decimal;
  internal?: boolean; // lot uit een overboeking tussen eigen platforms (kostprijs meegenomen)
}

/** Overboeking naar elders: het aantal dat vertrok en de kostprijs die daarbij uit de lots verdween (gaat mee naar de ontvanger). */
export interface TransferOutEvent {
  txId: number;
  executedAt: string;
  quantity: Decimal; // werkelijk uit de lots gehaald (ten hoogste de open positie)
  cost: Decimal; // native
  costEur: Decimal;
  costUsd: Decimal;
  costBtc: Decimal;
}

export interface RealizedEvent {
  txId: number;
  executedAt: string;
  quantity: Decimal;
  proceeds: Decimal; // native, na verkoopkosten
  proceedsEur: Decimal;
  proceedsUsd: Decimal;
  proceedsBtc: Decimal;
  cost: Decimal; // kostprijs verkocht deel, native
  costEur: Decimal;
  costUsd: Decimal;
  costBtc: Decimal;
  pnl: Decimal;
  pnlEur: Decimal;
  pnlUsd: Decimal;
  pnlBtc: Decimal;
  lots: { txId: number; quantity: Decimal }[];
}

export interface IncomeEvent {
  txId: number;
  type: TxType;
  executedAt: string;
  amount: Decimal; // native (na eventuele kosten)
  amountEur: Decimal;
  amountUsd: Decimal;
  amountBtc: Decimal;
}

export interface EngineResult {
  quantity: Decimal;
  cost: Decimal; // kostprijs open lots, native
  costEur: Decimal;
  costUsd: Decimal;
  costBtc: Decimal;
  avgCost: Decimal; // per stuk, native (0 als geen positie)
  lots: Lot[];
  realized: RealizedEvent[];
  realizedPnl: Decimal;
  realizedPnlEur: Decimal;
  realizedPnlUsd: Decimal;
  realizedPnlBtc: Decimal;
  income: IncomeEvent[];
  incomeEur: Decimal;
  incomeUsd: Decimal;
  incomeBtc: Decimal;
  fees: IncomeEvent[]; // losse kosten (type fee)
  transfers: TransferOutEvent[]; // overboekingen naar elders, met de kostprijs die meeging
  feesEur: Decimal;
  feesUsd: Decimal;
  feesBtc: Decimal;
  totalBuyCost: Decimal; // som van alle aankoopkostprijzen, native (voor rendement)
  totalBuyCostEur: Decimal;
  totalBuyCostUsd: Decimal;
  totalBuyCostBtc: Decimal;
  warnings: string[];
}

export const D = (v: Decimal.Value | null | undefined): Decimal => new Decimal(v ?? 0);
const ZERO = new Decimal(0);

export function fxFor(tx: Pick<EngineTx, "currency" | "fxEur" | "fxUsd" | "fxBtc">, to: DisplayCurrency): Decimal {
  if (tx.currency === to) return new Decimal(1);
  // zonder BTC-koers telt het bedrag als 0 BTC (niet als 1:1); portfolio.ts meldt de ontbrekende koers
  if (to === "BTC") return tx.fxBtc != null ? new Decimal(tx.fxBtc) : ZERO;
  const v = to === "EUR" ? tx.fxEur : tx.fxUsd;
  if (v == null) return new Decimal(1);
  return new Decimal(v);
}

function sortTx(txs: EngineTx[]): EngineTx[] {
  return [...txs].sort((a, b) => (a.executedAt < b.executedAt ? -1 : a.executedAt > b.executedAt ? 1 : a.id - b.id));
}

/**
 * Verwerkt de transacties van één (portfolio, asset, platform)-combinatie tot lots, gerealiseerd resultaat en inkomsten.
 * - buy: nieuw lot met kostprijs = aantal × prijs + kosten
 * - sell: opbrengst = aantal × prijs − kosten; kostprijs verkocht deel volgens methode (FIFO of gemiddeld/pro rata)
 * - dividend/interest/staking: inkomsten; staking met aantal > 0 = lot met kostprijs 0
 * - fee: losse kosten
 */
export interface PositionStep {
  txId: number;
  executedAt: string;
  quantity: Decimal;
  cost: Decimal; // kostprijs open lots, native
  costEur: Decimal;
  costUsd: Decimal;
  costBtc: Decimal;
}

interface Position {
  quantity: Decimal;
  cost: Decimal;
  costEur: Decimal;
  costUsd: Decimal;
  costBtc: Decimal;
}

const EMPTY_POSITION: Position = { quantity: ZERO, cost: ZERO, costEur: ZERO, costUsd: ZERO, costBtc: ZERO };

/** Eén lot bij de som van de open lots optellen. */
function addLot(p: Position, l: Lot): Position {
  if (l.quantityOpen.isZero()) return p; // volledig gesloten lot: draagt niets bij
  return {
    quantity: p.quantity.plus(l.quantityOpen),
    cost: p.cost.plus(l.costOpen),
    costEur: p.costEur.plus(l.costOpenEur),
    costUsd: p.costUsd.plus(l.costOpenUsd),
    costBtc: p.costBtc.plus(l.costOpenBtc),
  };
}

/** Som van de open lots — dezelfde optelling als het eindresultaat, maar op een tussenmoment. */
function openPosition(lots: Lot[]): Position {
  let p = EMPTY_POSITION;
  for (const l of lots) p = addLot(p, l);
  return p;
}

/**
 * @param onStep optioneel: wordt per dag met transacties aangeroepen (na de laatste transactie van die dag) met de open
 *   positie op dat moment, zodat een dag-tijdlijn (historiegrafiek) in één doorloop ontstaat in plaats van per
 *   transactie de hele berekening te herhalen.
 */
export function processTransactions(input: EngineTx[], method: CostMethod, onStep?: (step: PositionStep) => void): EngineResult {
  const txs = sortTx(input);
  const lots: Lot[] = [];
  const realized: RealizedEvent[] = [];
  const income: IncomeEvent[] = [];
  const fees: IncomeEvent[] = [];
  const transfers: TransferOutEvent[] = [];
  const warnings: string[] = [];
  let totalBuyCost = ZERO;
  let totalBuyCostEur = ZERO;
  let totalBuyCostUsd = ZERO;
  let totalBuyCostBtc = ZERO;

  // De open positie wordt bijgehouden in plaats van bij elke stap en elke verkoop opnieuw over alle lots opgeteld
  // (met honderden lots en honderden verkopen was dat een groot deel van de rekentijd). Een nieuw lot wordt bij de
  // lopende som opgeteld: precies dezelfde optelling in dezelfde volgorde als een volledige doorloop, dus met dezelfde
  // afronding. Een verkoop of overboeking wijzigt bestaande lots; daarna is de som ongeldig (null) en wordt hij bij de
  // eerstvolgende vraag opnieuw over alle lots berekend.
  let position: Position | null = EMPTY_POSITION; // som van de open lots, lege lots overgeslagen (zoals openPosition)
  let openQtySum: Decimal | null = ZERO; // som van quantityOpen over álle lots, zoals een verkoop hem altijd optelde
  const currentPosition = (): Position => {
    if (!position) position = openPosition(lots);
    return position;
  };
  const openQuantity = (): Decimal => openQtySum ?? lots.reduce((s, l) => s.plus(l.quantityOpen), ZERO);
  const pushLot = (lot: Lot) => {
    lots.push(lot);
    if (position) position = addLot(position, lot);
    if (openQtySum) openQtySum = openQtySum.plus(lot.quantityOpen);
  };
  const lotsChanged = () => {
    position = null;
    openQtySum = null;
  };

  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];
    const qty = D(tx.quantity);
    const price = D(tx.price);
    const fee = D(tx.fee);
    const fxE = fxFor(tx, "EUR");
    const fxU = fxFor(tx, "USD");
    const fxB = fxFor(tx, "BTC");

    switch (tx.type) {
      case "buy":
      case "transfer_in": {
        // transfer_in: overboeking van elders; kostprijs = opgegeven prijs (marktwaarde of oorspronkelijke kostprijs) × aantal
        const cost = qty.mul(price).plus(fee);
        const internal = tx.type === "transfer_in" && !!tx.internal;
        pushLot({
          txId: tx.id,
          executedAt: tx.executedAt,
          pricePerUnit: price,
          quantityOriginal: qty,
          costOriginal: cost,
          quantityOpen: qty,
          costOpen: cost,
          costOpenEur: cost.mul(fxE),
          costOpenUsd: cost.mul(fxU),
          costOpenBtc: cost.mul(fxB),
          internal,
        });
        // een interne overboeking is geen nieuwe inleg: die kostprijs telde al mee bij de oorspronkelijke aankoop
        if (!internal) {
          totalBuyCost = totalBuyCost.plus(cost);
          totalBuyCostEur = totalBuyCostEur.plus(cost.mul(fxE));
          totalBuyCostUsd = totalBuyCostUsd.plus(cost.mul(fxU));
          totalBuyCostBtc = totalBuyCostBtc.plus(cost.mul(fxB));
        }
        break;
      }
      case "sell": {
        const openQty = openQuantity();
        let toSell = qty;
        if (toSell.gt(openQty)) {
          warnings.push(`Verkoop ${tx.id}: ${qty.toString()} verkocht terwijl ${openQty.toString()} open stond; overschot zonder kostprijs verwerkt.`);
          toSell = openQty;
        }
        const proceeds = qty.mul(price).minus(fee);
        let cost = ZERO;
        let costEur = ZERO;
        let costUsd = ZERO;
        let costBtc = ZERO;
        const consumed: { txId: number; quantity: Decimal }[] = [];

        if (method === "fifo") {
          let remaining = toSell;
          for (const lot of lots) {
            if (remaining.lte(0)) break;
            if (lot.quantityOpen.lte(0)) continue;
            const take = Decimal.min(lot.quantityOpen, remaining);
            const frac = take.div(lot.quantityOpen);
            const c = lot.costOpen.mul(frac);
            const cE = lot.costOpenEur.mul(frac);
            const cU = lot.costOpenUsd.mul(frac);
            const cB = lot.costOpenBtc.mul(frac);
                        lot.quantityOpen = lot.quantityOpen.minus(take);
            lot.costOpen = lot.costOpen.minus(c);
            lot.costOpenEur = lot.costOpenEur.minus(cE);
            lot.costOpenUsd = lot.costOpenUsd.minus(cU);
            lot.costOpenBtc = lot.costOpenBtc.minus(cB);
            cost = cost.plus(c);
            costEur = costEur.plus(cE);
            costUsd = costUsd.plus(cU);
            costBtc = costBtc.plus(cB);
            consumed.push({ txId: lot.txId, quantity: take });
            remaining = remaining.minus(take);
          }
        } else {
          // gemiddelde kostprijs: elk open lot naar rato verlagen
          if (openQty.gt(0) && toSell.gt(0)) {
            const frac = toSell.div(openQty);
            for (const lot of lots) {
              if (lot.quantityOpen.lte(0)) continue;
              const take = lot.quantityOpen.mul(frac);
              const c = lot.costOpen.mul(frac);
              const cE = lot.costOpenEur.mul(frac);
              const cU = lot.costOpenUsd.mul(frac);
              const cB = lot.costOpenBtc.mul(frac);
                            lot.quantityOpen = lot.quantityOpen.minus(take);
              lot.costOpen = lot.costOpen.minus(c);
              lot.costOpenEur = lot.costOpenEur.minus(cE);
              lot.costOpenUsd = lot.costOpenUsd.minus(cU);
              lot.costOpenBtc = lot.costOpenBtc.minus(cB);
              cost = cost.plus(c);
              costEur = costEur.plus(cE);
              costUsd = costUsd.plus(cU);
              costBtc = costBtc.plus(cB);
              consumed.push({ txId: lot.txId, quantity: take });
            }
          }
        }
        lotsChanged();
        const proceedsEur = proceeds.mul(fxE);
        const proceedsUsd = proceeds.mul(fxU);
        const proceedsBtc = proceeds.mul(fxB);
        realized.push({
          txId: tx.id,
          executedAt: tx.executedAt,
          quantity: qty,
          proceeds,
          proceedsEur,
          proceedsUsd,
          proceedsBtc,
          cost,
          costEur,
          costUsd,
          costBtc,
          pnl: proceeds.minus(cost),
          pnlEur: proceedsEur.minus(costEur),
          pnlUsd: proceedsUsd.minus(costUsd),
          pnlBtc: proceedsBtc.minus(costBtc),
          lots: consumed,
        });
        break;
      }
      case "transfer_out": {
        // overboeking naar elders: lots verlagen zonder gerealiseerd resultaat; de kostprijs die verdwijnt wordt gemeld
        // (transfers), zodat de ontvangende kant hem kan overnemen (calc/transfers.ts)
        const openQty = openQuantity();
        let remaining = Decimal.min(qty, openQty);
        if (qty.gt(openQty)) warnings.push(`Overboeking ${tx.id}: ${qty.toString()} overgeboekt terwijl ${openQty.toString()} open stond.`);
        const moved = { quantity: ZERO, cost: ZERO, costEur: ZERO, costUsd: ZERO, costBtc: ZERO };
        const takeFrom = (lot: Lot, take: Decimal) => {
          const frac = take.div(lot.quantityOpen);
          const c = lot.costOpen.mul(frac);
          const cE = lot.costOpenEur.mul(frac);
          const cU = lot.costOpenUsd.mul(frac);
          const cB = lot.costOpenBtc.mul(frac);
          lot.costOpen = lot.costOpen.minus(c);
          lot.costOpenEur = lot.costOpenEur.minus(cE);
          lot.costOpenUsd = lot.costOpenUsd.minus(cU);
          lot.costOpenBtc = lot.costOpenBtc.minus(cB);
          lot.quantityOpen = lot.quantityOpen.minus(take);
          moved.quantity = moved.quantity.plus(take);
          moved.cost = moved.cost.plus(c);
          moved.costEur = moved.costEur.plus(cE);
          moved.costUsd = moved.costUsd.plus(cU);
          moved.costBtc = moved.costBtc.plus(cB);
        };
        if (method === "fifo") {
          for (const lot of lots) {
            if (remaining.lte(0)) break;
            if (lot.quantityOpen.lte(0)) continue;
            const take = Decimal.min(lot.quantityOpen, remaining);
            takeFrom(lot, take);
            remaining = remaining.minus(take);
          }
        } else if (openQty.gt(0) && remaining.gt(0)) {
          const frac = remaining.div(openQty);
          for (const lot of lots) {
            if (lot.quantityOpen.lte(0)) continue;
            takeFrom(lot, lot.quantityOpen.mul(frac));
          }
        }
        transfers.push({ txId: tx.id, executedAt: tx.executedAt, ...moved });
        lotsChanged();
        break;
      }
      case "dividend":
      case "interest":
      case "staking": {
        if (tx.type === "staking" && qty.gt(0)) {
          // staking-reward in de munt zelf: lot met kostprijs 0
          pushLot({
            txId: tx.id,
            executedAt: tx.executedAt,
            pricePerUnit: ZERO,
            quantityOriginal: qty,
            costOriginal: ZERO,
            quantityOpen: qty,
            costOpen: ZERO,
            costOpenEur: ZERO,
            costOpenUsd: ZERO,
            costOpenBtc: ZERO,
          });
        }
        const amount = price.minus(fee);
        if (!amount.eq(0)) {
          income.push({ txId: tx.id, type: tx.type, executedAt: tx.executedAt, amount, amountEur: amount.mul(fxE), amountUsd: amount.mul(fxU), amountBtc: amount.mul(fxB) });
        }
        break;
      }
      case "fee": {
        const amount = price.plus(fee);
        fees.push({ txId: tx.id, type: tx.type, executedAt: tx.executedAt, amount, amountEur: amount.mul(fxE), amountUsd: amount.mul(fxU), amountBtc: amount.mul(fxB) });
        break;
      }
      default:
        // deposit/withdrawal raken de positie niet
        break;
    }
    // alleen de laatste transactie van een moment telt voor een tijdlijn; bij meerdere transacties op één tijdstip
    // wordt één stap gemeld, na de laatste
    if (onStep && (i === txs.length - 1 || txs[i + 1].executedAt.slice(0, 10) !== tx.executedAt.slice(0, 10))) {
      onStep({ txId: tx.id, executedAt: tx.executedAt, ...currentPosition() });
    }
  }

  const { quantity, cost, costEur, costUsd, costBtc } = currentPosition();
  const sum = (arr: { [k: string]: unknown }[], key: string) => arr.reduce((s, e) => s.plus(e[key] as Decimal), ZERO);

  return {
    quantity,
    cost,
    costEur,
    costUsd,
    costBtc,
    avgCost: quantity.gt(0) ? cost.div(quantity) : ZERO,
    lots,
    realized,
    realizedPnl: sum(realized as unknown as { [k: string]: unknown }[], "pnl"),
    realizedPnlEur: sum(realized as unknown as { [k: string]: unknown }[], "pnlEur"),
    realizedPnlUsd: sum(realized as unknown as { [k: string]: unknown }[], "pnlUsd"),
    realizedPnlBtc: sum(realized as unknown as { [k: string]: unknown }[], "pnlBtc"),
    income,
    incomeEur: sum(income as unknown as { [k: string]: unknown }[], "amountEur"),
    incomeUsd: sum(income as unknown as { [k: string]: unknown }[], "amountUsd"),
    incomeBtc: sum(income as unknown as { [k: string]: unknown }[], "amountBtc"),
    fees,
    transfers,
    feesEur: sum(fees as unknown as { [k: string]: unknown }[], "amountEur"),
    feesUsd: sum(fees as unknown as { [k: string]: unknown }[], "amountUsd"),
    feesBtc: sum(fees as unknown as { [k: string]: unknown }[], "amountBtc"),
    totalBuyCost,
    totalBuyCostEur,
    totalBuyCostUsd,
    totalBuyCostBtc,
    warnings,
  };
}

/** Aantal dat op een bepaald moment (inclusief) open stond, plus kostprijs open lots op dat moment. */
export function stateAt(input: EngineTx[], method: CostMethod, atIso: string): { quantity: Decimal; costEur: Decimal; costUsd: Decimal } {
  const r = processTransactions(input.filter((t) => t.executedAt <= atIso), method);
  return { quantity: r.quantity, costEur: r.costEur, costUsd: r.costUsd };
}

/** Kas per valuta uit stortingen/opnames/aankopen/verkopen/inkomsten/kosten. */
export function cashFlows(input: EngineTx[]): Record<string, Decimal> {
  const out: Record<string, Decimal> = {};
  const add = (ccy: string, v: Decimal) => {
    out[ccy] = (out[ccy] ?? ZERO).plus(v);
  };
  for (const tx of input) {
    const qty = D(tx.quantity);
    const price = D(tx.price);
    const fee = D(tx.fee);
    switch (tx.type) {
      case "deposit":
        add(tx.currency, price.minus(fee));
        break;
      case "withdrawal":
        add(tx.currency, price.plus(fee).neg());
        break;
      case "buy":
        add(tx.currency, qty.mul(price).plus(fee).neg());
        break;
      case "sell":
        add(tx.currency, qty.mul(price).minus(fee));
        break;
      case "dividend":
      case "interest":
        add(tx.currency, price.minus(fee));
        break;
      case "staking":
        if (qty.eq(0)) add(tx.currency, price.minus(fee));
        break;
      case "fee":
        add(tx.currency, price.plus(fee).neg());
        break;
    }
  }
  return out;
}
