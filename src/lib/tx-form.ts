/**
 * Regels achter het transactieformulier (components/transaction-form.tsx): welke velden een soort transactie toont, de
 * controle vóór het opslaan, het totaal onder de bedragen en wat er voor verborgen velden naar de API gaat. Los van React,
 * zodat het zonder browser te testen is.
 */
import Decimal from "decimal.js";

export const TX_FORM_TYPES = ["buy", "sell", "dividend", "interest", "staking", "fee", "deposit", "withdrawal", "transfer_in", "transfer_out"] as const;
export type TxType = (typeof TX_FORM_TYPES)[number];

/** De keuze "Soort" in groepen. De hoofdgroepen staan altijd open; de rest zit achter "Meer". */
export const TX_GROUPS: readonly { label: string; types: readonly TxType[]; main: boolean }[] = [
  { label: "Handel", types: ["buy", "sell"], main: true },
  { label: "Geld", types: ["deposit", "withdrawal", "fee"], main: true },
  { label: "Inkomsten", types: ["dividend", "interest", "staking"], main: false },
  { label: "Overboeking", types: ["transfer_in", "transfer_out"], main: false },
];

export function isMainType(type: TxType): boolean {
  return TX_GROUPS.some((g) => g.main && g.types.includes(type));
}

/** Eén regel uitleg onder de keuze, zodat je vóór het invullen weet wat de soort doet. */
export const TX_TYPE_HINTS: Record<TxType, string> = {
  buy: "Je koopt een asset op dit platform.",
  sell: "Je verkoopt een asset; winst of verlies wordt berekend tegen je kostprijs.",
  deposit: "Geld dat je op dit platform zet.",
  withdrawal: "Geld dat je van dit platform haalt.",
  fee: "Losse kosten die niet bij een aan- of verkoop horen, zoals bewaarloon.",
  dividend: "Uitkering van een aandeel of fonds, in geld.",
  interest: "Rente die een asset oplevert.",
  staking: "Beloning voor het staken van een asset, in de munt zelf of in geld.",
  transfer_in: "Een asset komt binnen van een ander platform of wallet; geen winst of verlies.",
  transfer_out: "Een asset gaat naar een ander platform of wallet; geen winst of verlies.",
};

/** Dezelfde regel als de server (`decimalString` in lib/transactions.ts): één komma of punt als decimaalteken, geen duizendtallen. */
export function parseDecimal(s: string): Decimal | null {
  const v = s.replace(",", ".").trim();
  return /^-?\d+(\.\d+)?$/.test(v) ? new Decimal(v) : null;
}

export function isNonZero(s: string | null | undefined): boolean {
  const d = parseDecimal(s ?? "");
  return d !== null && !d.isZero();
}

/** Staking in crypto: ontvangen in de munt zelf (aantal, lot met kostprijs 0) of in geld (bedrag, telt als inkomsten). */
export type StakeIn = "coin" | "cash";

export interface TxLayout {
  asset: boolean;
  /** Veld Aantal. Bij vastgoed staat het aantal vast op 1 (`quantityIsOne`) en is er geen veld. */
  quantity: boolean;
  quantityIsOne: boolean;
  /** Prijs- of bedragveld, met het label dat bij deze soort hoort. */
  price: boolean;
  priceLabel: string;
  priceRequired: boolean;
  priceHint: string | null;
  /** Kosten: altijd zichtbaar, achter "+ Kosten toevoegen", of niet (tellen voor deze soort nergens mee). */
  fee: "show" | "link" | "none";
  feeLabel: string;
  /** Staking in crypto: keuze tussen ontvangen in de munt of in geld. */
  stakeChoice: boolean;
}

export function txLayout(type: TxType, category: string | null | undefined, stakeIn: StakeIn): TxLayout {
  const re = category === "real_estate";
  const base: TxLayout = { asset: true, quantity: false, quantityIsOne: false, price: true, priceLabel: "Bedrag", priceRequired: true, priceHint: null, fee: "link", feeLabel: "Kosten", stakeChoice: false };
  switch (type) {
    case "buy":
    case "sell":
      return {
        ...base,
        quantity: !re,
        quantityIsOne: re,
        priceLabel: re ? (type === "buy" ? "Aankoopprijs" : "Verkoopprijs") : "Prijs per stuk",
        fee: "show",
        feeLabel: re ? (type === "buy" ? "Aankoopkosten" : "Verkoopkosten") : "Kosten",
      };
    case "transfer_in":
      // de prijs mag leeg: bij een overboeking tussen eigen platforms neemt calc/transfers.ts de kostprijs van de opname over
      return {
        ...base,
        quantity: !re,
        quantityIsOne: re,
        priceLabel: re ? "Kostprijs" : "Kostprijs per stuk",
        priceRequired: false,
        priceHint: "Je oorspronkelijke kostprijs, of de marktprijs als je die niet weet. Bij een overboeking tussen je eigen platforms neemt de app de kostprijs van de overboeking uit over.",
      };
    case "transfer_out":
      // de engine verlaagt alleen de lots: prijs en kosten tellen nergens mee
      return { ...base, quantity: !re, quantityIsOne: re, price: false, priceLabel: "Prijs per stuk", priceRequired: false, fee: "none" };
    case "staking":
      if (category !== "crypto") return base;
      return stakeIn === "coin" ? { ...base, stakeChoice: true, quantity: true, price: false, priceRequired: false, fee: "none" } : { ...base, stakeChoice: true };
    case "fee":
      return { ...base, asset: false, fee: "none" };
    case "deposit":
    case "withdrawal":
      return { ...base, asset: false };
    default:
      return base; // dividend, rente
  }
}

/**
 * Bedragen die al in een bestaande transactie staan. Die velden blijven zichtbaar, ook als de soort ze niet meer toont,
 * zodat bewerken nooit stilletjes een bedrag op 0 zet.
 */
export interface TxKeep {
  price: boolean;
  fee: boolean;
}

export interface TxVisible {
  quantity: boolean;
  price: boolean;
  fee: boolean;
}

export function txVisible(layout: TxLayout, keep: TxKeep, feeOpened: boolean): TxVisible {
  return {
    quantity: layout.quantity,
    price: layout.price || keep.price,
    fee: layout.fee === "show" || (layout.fee === "link" && feeOpened) || (layout.fee === "none" && keep.fee),
  };
}

export type TxField = "asset" | "platform" | "quantity" | "price" | "fee" | "executedAt";

/** Volgorde op het scherm: de eerste fout krijgt de focus. */
export const TX_FIELD_ORDER: readonly TxField[] = ["asset", "platform", "quantity", "price", "fee", "executedAt"];

export interface TxValues {
  quantity: string;
  price: string;
  fee: string;
}

export function validateTx(v: TxValues & { layout: TxLayout; visible: TxVisible; hasAsset: boolean; hasPlatform: boolean; addingWallet: boolean; executedAt: string }): Partial<Record<TxField, string>> {
  const e: Partial<Record<TxField, string>> = {};
  if (v.layout.asset && !v.hasAsset) e.asset = "Kies een asset.";
  if (v.addingWallet) e.platform = "Voeg de nieuwe wallet toe, of kies een bestaand platform.";
  else if (!v.hasPlatform) e.platform = "Kies een platform of voeg een wallet toe.";
  if (v.visible.quantity) {
    const q = parseDecimal(v.quantity);
    if (!v.quantity.trim()) e.quantity = "Vul het aantal in.";
    else if (!q) e.quantity = "Geen geldig aantal. Gebruik bijvoorbeeld 0,5.";
    else if (q.lte(0)) e.quantity = "Het aantal moet groter dan 0 zijn.";
  }
  if (v.visible.price) {
    const p = parseDecimal(v.price);
    // alleen verplicht als de soort het veld zelf toont; een veld dat alleen voor een bestaand bedrag zichtbaar bleef niet
    const required = v.layout.price && v.layout.priceRequired;
    const what = v.layout.priceLabel === "Bedrag" ? "het bedrag" : `de ${v.layout.priceLabel.toLowerCase()}`;
    if (!v.price.trim()) {
      if (required) e.price = `Vul ${what} in.`;
    } else if (!p) e.price = "Geen geldig bedrag. Gebruik bijvoorbeeld 105,20.";
    else if (required && p.lte(0)) e.price = `${what[0].toUpperCase()}${what.slice(1)} moet groter dan 0 zijn.`;
    else if (p.isNegative()) e.price = "Mag niet negatief zijn.";
  }
  if (v.visible.fee && v.fee.trim() && !parseDecimal(v.fee)) e.fee = "Geen geldig bedrag. Gebruik bijvoorbeeld 1,50.";
  if (!v.executedAt || isNaN(new Date(v.executedAt).getTime())) e.executedAt = "Vul een datum en tijd in.";
  return e;
}

/**
 * Het totaal onder de bedragen, zoals de engine en de kasstromen het boeken. Alleen als er iets te rekenen valt (aantal ×
 * prijs, of kosten erbij); `value` is null zolang een getal ontbreekt of ongeldig is.
 */
export function txTotal(type: TxType, visible: TxVisible, v: TxValues): { label: string; value: Decimal | null } | null {
  // alleen bij aan- en verkoop en overboeking in is de prijs per stuk; bij de rest (ook staking) is het een bedrag
  const perUnit = (type === "buy" || type === "sell" || type === "transfer_in") && visible.quantity;
  if (type === "transfer_out" || !visible.price) return null;
  if (!perUnit && !visible.fee) return null;
  const p = parseDecimal(v.price);
  const q = perUnit ? parseDecimal(v.quantity) : null;
  const f = visible.fee && v.fee.trim() ? parseDecimal(v.fee) : new Decimal(0);
  // aantal × prijs; zonder aantalveld (vastgoed: aantal 1, of een soort met alleen een bedrag) is de prijs het bedrag
  const gross = p && perUnit ? (q ? q.mul(p) : null) : p;
  const ok = gross !== null && f !== null;
  switch (type) {
    case "buy":
      return { label: "Totaal betaald", value: ok ? gross.plus(f) : null };
    case "sell":
      return { label: f && !f.isZero() ? "Opbrengst na kosten" : "Opbrengst", value: ok ? gross.minus(f) : null };
    case "transfer_in":
      return { label: "Kostprijs totaal", value: ok ? gross.plus(f) : null };
    case "withdrawal":
      return { label: "Totaal incl. kosten", value: ok ? gross.plus(f) : null };
    case "fee":
      return { label: "Totaal", value: ok ? gross.plus(f) : null };
    case "deposit":
      return { label: "Netto gestort", value: ok ? gross.minus(f) : null };
    default:
      return { label: "Netto ontvangen", value: ok ? gross.minus(f) : null }; // dividend, rente, staking in geld
  }
}

/** Wat er naar de API gaat: zichtbare velden zoals ingetypt (de server leest de komma), verborgen velden als "0", vastgoed met aantal 1. */
export function txAmounts(layout: TxLayout, visible: TxVisible, v: TxValues): TxValues {
  return {
    quantity: visible.quantity ? v.quantity.trim() : layout.quantityIsOne ? "1" : "0",
    price: visible.price ? v.price.trim() || "0" : "0",
    fee: visible.fee ? v.fee.trim() || "0" : "0",
  };
}
