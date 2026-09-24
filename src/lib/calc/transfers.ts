/**
 * Overboekingen tussen eigen platforms (Kraken → hardwarewallet, wallet → exchange): dezelfde coins verhuizen, er wordt
 * niets gekocht. Zonder koppeling boekt de ontvangende kant de ontvangst tegen dagkoers, waardoor de kostprijs ("inleg")
 * van de positie verspringt naar de marktwaarde van dat moment en de aankoop dubbel meetelt in de totale inleg.
 *
 * Hier wordt elke transfer_in gematcht aan een transfer_out van een ander platform voor hetzelfde asset: binnen een
 * venster (de opname mag hoogstens 2 uur ná en 72 uur vóór de ontvangst liggen) en met een hoeveelheid die op de
 * opname-/minerfee na gelijk is. Een gematchte ontvangst krijgt de kostprijs die bij de zender uit de lots verdween
 * (inclusief het fee-deel: verhuizen kost iets, maar is geen aankoop) en telt niet als nieuwe inleg. Kettingen
 * (A → B → C) worden opgelost door te herhalen tot de uitkomst stabiel is. Alles is puur; de opgeslagen transacties
 * veranderen niet.
 */
import Decimal from "decimal.js";
import { processTransactions, type CostMethod, type EngineTx, type TransferOutEvent } from "./engine";

export interface TransferGroup {
  key: string; // `${assetId}-${platformId}`
  assetId: number;
  platformId: number;
  txs: EngineTx[];
}

export interface TransferMatch {
  assetId: number;
  inKey: string;
  inTxId: number;
  outKey: string;
  outTxId: number;
}

const BEFORE_MS = 2 * 3600_000; // ontvangst mag iets vóór de geboekte opname liggen (klokverschil exchange vs. blok)
const AFTER_MS = 72 * 3600_000; // en tot drie dagen erna (bevestigingen, batch-opnames)
const MAX_PASSES = 6;

/** Hoeveel de opname groter mag zijn dan de ontvangst: opname-/minerfee, hoogstens 1 % of 0,002 stuks. */
function feeTolerance(outQty: Decimal): Decimal {
  return Decimal.max(outQty.mul("0.01"), new Decimal("0.002"));
}

/** Koppelt ontvangsten aan opnames op een ander platform; elke opname hoogstens één keer, de dichtstbijzijnde in tijd wint. */
export function matchInternalTransfers(groups: TransferGroup[]): TransferMatch[] {
  const byAsset = new Map<number, TransferGroup[]>();
  for (const g of groups) {
    if (!byAsset.has(g.assetId)) byAsset.set(g.assetId, []);
    byAsset.get(g.assetId)!.push(g);
  }
  const matches: TransferMatch[] = [];
  for (const [assetId, list] of byAsset) {
    if (list.length < 2) continue;
    const ins: { key: string; platformId: number; tx: EngineTx; t: number; qty: Decimal }[] = [];
    const outs: { key: string; platformId: number; tx: EngineTx; t: number; qty: Decimal; used: boolean }[] = [];
    for (const g of list) {
      for (const tx of g.txs) {
        const t = Date.parse(tx.executedAt);
        if (tx.type === "transfer_in") ins.push({ key: g.key, platformId: g.platformId, tx, t, qty: new Decimal(tx.quantity) });
        else if (tx.type === "transfer_out") outs.push({ key: g.key, platformId: g.platformId, tx, t, qty: new Decimal(tx.quantity), used: false });
      }
    }
    ins.sort((a, b) => a.t - b.t);
    for (const i of ins) {
      if (i.qty.lte(0)) continue;
      let best: (typeof outs)[number] | null = null;
      let bestDist = Infinity;
      for (const o of outs) {
        if (o.used || o.platformId === i.platformId) continue;
        if (i.t < o.t - BEFORE_MS || i.t > o.t + AFTER_MS) continue;
        const diff = o.qty.minus(i.qty);
        if (diff.lt("-0.00000001") || diff.gt(feeTolerance(o.qty))) continue;
        const dist = Math.abs(i.t - o.t);
        if (dist < bestDist) {
          best = o;
          bestDist = dist;
        }
      }
      if (best) {
        best.used = true;
        matches.push({ assetId, inKey: i.key, inTxId: i.tx.id, outKey: best.key, outTxId: best.tx.id });
      }
    }
  }
  return matches;
}

function carried(tx: EngineTx, ev: TransferOutEvent, senderCurrency: string): EngineTx {
  const qty = new Decimal(tx.quantity);
  if (ev.cost.lte(0) || qty.lte(0)) return { ...tx, price: "0", fee: "0", internal: true }; // zender had geen kostprijs (bijv. staking-reward)
  const ratio = (v: Decimal) => v.div(ev.cost).toString();
  return { ...tx, price: ev.cost.div(qty).toString(), fee: "0", currency: senderCurrency, fxEur: ratio(ev.costEur), fxUsd: ratio(ev.costUsd), fxBtc: ratio(ev.costBtc), internal: true };
}

export interface LinkOptions {
  /** transfer_in-transacties die zonder match kostprijs 0 krijgen (wallet met "geen kostprijs voor ontvangsten zonder tegenpartij") */
  zeroCostIds?: Set<number>;
}

/**
 * Past de gematchte ontvangsten aan met de kostprijs van de zender. Geeft per groep de (eventueel aangepaste) transacties
 * terug; groepen zonder match komen ongewijzigd terug. Ontvangsten uit `zeroCostIds` zonder match worden intern met
 * kostprijs 0 (de coins kwamen van eigen geld elders; geen nieuwe inleg).
 */
export function linkInternalTransfers(groups: TransferGroup[], method: CostMethod, opts: LinkOptions = {}): { txs: Map<string, EngineTx[]>; matches: TransferMatch[] } {
  const matches = matchInternalTransfers(groups);
  const matched = new Set(matches.map((m) => m.inTxId));
  const zero = opts.zeroCostIds;
  const base = new Map(
    groups.map((g) => [g.key, zero && g.txs.some((t) => zero.has(t.id) && !matched.has(t.id)) ? g.txs.map((t) => (zero.has(t.id) && !matched.has(t.id) && t.type === "transfer_in" ? { ...t, price: "0", fee: "0", internal: true } : t)) : g.txs])
  );
  if (!matches.length) return { txs: base, matches };
  const senders = new Set(matches.map((m) => m.outKey));
  let current = base;
  let signature = "";
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    // kostprijs die elke gematchte opname bij de zender uit de lots haalde, met de huidige (mogelijk al aangepaste) invoer
    const removed = new Map<number, { ev: TransferOutEvent; currency: string }>();
    for (const key of senders) {
      const list = current.get(key)!;
      const byId = new Map(list.map((t) => [t.id, t]));
      for (const ev of processTransactions(list, method).transfers) removed.set(ev.txId, { ev, currency: byId.get(ev.txId)!.currency });
    }
    const overrides = new Map<number, EngineTx>();
    for (const m of matches) {
      const r = removed.get(m.outTxId);
      const tx = base.get(m.inKey)!.find((t) => t.id === m.inTxId);
      if (r && tx) overrides.set(m.inTxId, carried(tx, r.ev, r.currency));
    }
    const next = new Map<string, EngineTx[]>();
    for (const [key, list] of base) next.set(key, list.some((t) => overrides.has(t.id)) ? list.map((t) => overrides.get(t.id) ?? t) : list);
    const sig = [...overrides.entries()].map(([id, t]) => `${id}:${t.price}:${t.currency}:${t.fxEur}:${t.fxUsd}:${t.fxBtc}`).join("|");
    // Ontving geen enkele zender zelf een gekoppelde overboeking (geen ketting), dan blijft de invoer van de zenders
    // gelijk en levert nog een ronde precies hetzelfde op: één doorloop is dan genoeg. Dat scheelt de helft van de
    // rekentijd, want elke ronde rekent de lots van de zenders opnieuw door.
    const sendersChanged = [...senders].some((key) => next.get(key) !== current.get(key));
    current = next;
    if (sig === signature || !sendersChanged) break; // stabiel: ook kettingen (A → B → C) zijn nu doorgerekend
    signature = sig;
  }
  return { txs: current, matches };
}
