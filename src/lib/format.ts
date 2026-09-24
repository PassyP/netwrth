import Decimal from "decimal.js";
import type { PriceSource } from "@/lib/db/schema";
import { isValidTimeZone } from "./schedule";

const SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", CHF: "CHF ", GBP: "£", BTC: "₿" };

/** Valutateken zonder spatie ("€", "$", "₿"); onbekende valuta → code. */
export function currencySymbol(currency: string): string {
  return (SYMBOLS[currency] ?? currency).trim();
}

/**
 * Wat er staat als "Bedragen verbergen" aan staat: altijd even lang, zodat ook de grootte van een bedrag niet uitlekt.
 * In de UI zet `hidden` dit aan via <Money>/<Qty>/<Price> of useFormat() uit components/ui.tsx; de server nooit.
 */
export const MASK = "••••";

/** Cookie (per apparaat) voor "Bedragen verbergen"; layout.tsx leest hem, zodat er na herladen niets even oplicht. */
export const HIDE_AMOUNTS_COOKIE = "pm_hide_amounts";

export function formatMoney(value: Decimal.Value, currency: string, opts: { decimals?: number; sign?: boolean; hidden?: boolean } = {}): string {
  const d = new Decimal(value ?? 0);
  const decimals = opts.decimals ?? (currency === "BTC" ? 8 : 2);
  const abs = d.abs().toFixed(decimals);
  const [int, frac] = abs.split(".");
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const num = frac !== undefined ? `${intFmt},${frac}` : intFmt;
  const sym = SYMBOLS[currency] ?? `${currency} `;
  // teken blijft ook verborgen staan: het zegt alleen óf er winst is, en het percentage ernaast is zichtbaar
  const sign = d.isNegative() ? "−" : opts.sign && d.gt(0) ? "+" : "";
  return `${sign}${sym}${opts.hidden ? MASK : num}`;
}

export function formatPercent(value: Decimal.Value, opts: { sign?: boolean; decimals?: number } = {}): string {
  const d = new Decimal(value ?? 0);
  const decimals = opts.decimals ?? 2;
  const sign = d.isNegative() ? "−" : opts.sign && d.gt(0) ? "+" : "";
  return `${sign}${d.abs().toFixed(decimals).replace(".", ",")}%`;
}

export function formatQuantity(value: Decimal.Value, opts: { hidden?: boolean } = {}): string {
  if (opts.hidden) return MASK;
  const d = new Decimal(value ?? 0);
  const s = d.toSignificantDigits(10).toFixed();
  const [int, frac] = s.split(".");
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return frac ? `${intFmt},${frac}` : intFmt;
}

/** Prijs per stuk. Blijft zichtbaar bij "Bedragen verbergen", behalve met `hidden` (vastgoed: daar is de koers je eigen waardering). */
export function formatPrice(value: Decimal.Value, currency: string, opts: { decimals?: number; hidden?: boolean } = {}): string {
  const d = new Decimal(value ?? 0);
  const decimals = opts.decimals ?? (currency === "BTC" ? 8 : d.abs().lt(1) ? 4 : 2);
  return formatMoney(d, currency, { decimals, hidden: opts.hidden });
}

/**
 * Vrije tekst van de server (notities, waarschuwingen, meldingen) waarin bedragen of aantallen kunnen staan, bij
 * "Bedragen verbergen": elk getal wordt MASK. Ook datums en tellingen, maar dat is in die stand geen verlies.
 */
export function maskNumbers(text: string): string {
  return text.replace(/\d+(?:[.,]\d+)*/g, MASK);
}

/**
 * Onder dit bedrag (in de weergavevaluta) geldt een positie als "stof": restjes van een fractie van een cent die na
 * jaren handelen op een beurs achterblijven en de lijsten vervuilen. Alleen de weergave; totalen tellen ze gewoon mee.
 */
export const DUST_THRESHOLD = 1;

/** Is dit bedrag (in de weergavevaluta) stof? */
export function isDust(value: string | number | null | undefined): boolean {
  return Math.abs(Number(value ?? 0)) < DUST_THRESHOLD;
}

/**
 * Het bedrag waarop de stofdrempel wordt getoetst: de weergavevaluta, behalve bij BTC — "minder dan ₿ 1" zou vrijwel
 * alles zijn, dus daar geldt de drempel in euro.
 */
export function dustAmount(value: { EUR: string; USD: string; BTC: string }, currency: string): string {
  return currency === "USD" ? value.USD : value.EUR;
}

/** De stofdrempel als tekst in de weergavevaluta, bijv. "€ 1" (bij BTC ook in euro, zie dustAmount). */
export function dustLabel(currency: string): string {
  return `${currency === "USD" ? "$" : "€"} ${DUST_THRESHOLD}`;
}

let displayTimeZone = "Europe/Amsterdam";

/** Tijdzone voor getoonde datums en tijden: de instelling timezone (dezelfde als van de planning), gezet door de app. */
export function setDisplayTimeZone(tz: string | null | undefined) {
  if (tz && isValidTimeZone(tz)) displayTimeZone = tz;
}

export function getDisplayTimeZone(): string {
  return displayTimeZone;
}

export function formatDate(iso: string, withTime = false): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: displayTimeZone });
  if (!withTime) return date;
  const time = d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: displayTimeZone });
  return `${date} ${time}`;
}

export const CATEGORY_LABELS: Record<string, string> = {
  crypto: "Crypto",
  stock: "Aandelen",
  etf: "ETF's",
  commodity: "Grondstoffen",
  real_estate: "Vastgoed",
};

export const CATEGORY_COLORS: Record<string, string> = {
  crypto: "#f7931a",
  stock: "#4f8cff",
  etf: "#22c55e",
  commodity: "#eab308",
  real_estate: "#a855f7",
};

export const PRICE_SOURCE_LABELS: Record<PriceSource, string> = {
  etoro: "eToro",
  yahoo: "Yahoo Finance",
  kraken: "Kraken",
  manual: "handmatig",
  none: "geen koersbron",
};

/** Korte naam als er een bron-id bij staat, bijv. "Yahoo (VWRL.L)". */
const PRICE_SOURCE_SHORT: Partial<Record<PriceSource, string>> = { yahoo: "Yahoo" };

/** Label van een koersbron, met bron-id als die bekend is: "Yahoo (VWRL.L)", "Kraken (XXBTZEUR)". Onbekende bron → ongewijzigd. */
export function priceSourceLabel(source: string, sourceId?: string | null): string {
  if (!Object.hasOwn(PRICE_SOURCE_LABELS, source)) return source;
  const s = source as PriceSource;
  const label = PRICE_SOURCE_LABELS[s];
  if (!sourceId || s === "manual" || s === "none") return label;
  return `${PRICE_SOURCE_SHORT[s] ?? label} (${sourceId})`;
}

export const TX_TYPE_LABELS: Record<string, string> = {
  buy: "Aankoop",
  sell: "Verkoop",
  dividend: "Dividend",
  interest: "Rente",
  staking: "Staking",
  fee: "Kosten",
  deposit: "Storting",
  withdrawal: "Opname",
  transfer_in: "Overboeking in",
  transfer_out: "Overboeking uit",
};

export const PLATFORM_TYPE_LABELS: Record<string, string> = {
  broker: "Broker",
  exchange: "Exchange",
  wallet: "Wallet",
  other: "Overig",
};
