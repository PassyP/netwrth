/**
 * Planning van de automatische taken, gedeeld door de worker (cron-expressies) en de instellingen (wat een interval
 * werkelijk doet en wanneer de volgende ronde is). Puur: geen database, bruikbaar in client en server.
 */

/** Cron-expressie voor een interval in minuten: 0 = uit; 1–59 = elke m minuten; vanaf 60 = elke h uur (afgerond, max. dagelijks). */
export function intervalCron(minutes: number): string | null {
  const m = Math.floor(Number(minutes) || 0);
  if (m <= 0) return null;
  if (m < 60) return `*/${m} * * * *`;
  const h = Math.max(1, Math.round(m / 60));
  return h >= 24 ? "0 0 * * *" : `0 */${h} * * *`;
}

/** Cron-expressie voor een dagelijkse tijd "HH:MM" (ongeldig → 23:45, de standaard van de dagelijkse ronde). */
export function dailyCron(hhmm: string): string {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  const h = m ? Number(m[1]) : 23;
  const mi = m ? Number(m[2]) : 45;
  return `${mi} ${h} * * *`;
}

/**
 * Keuzes in de instellingen: alleen intervallen die de klok gelijkmatig verdelen (delers van 60 minuten en van 24 uur),
 * zodat de cron precies doet wat het label zegt. 0 = alleen de dagelijkse ronde en de knop Verversen.
 */
export const INTERVAL_PRESETS = [0, 5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440] as const;

export function isPresetInterval(minutes: number): boolean {
  return (INTERVAL_PRESETS as readonly number[]).includes(Math.floor(Number(minutes) || 0));
}

/** Kort label van een preset, bijv. "Elk uur", "Elke 10 min", "Dagelijks om 00:00". */
export function presetLabel(minutes: number): string {
  const m = Math.floor(Number(minutes) || 0);
  if (m <= 0) return "Alleen dagelijkse ronde en handmatig";
  if (m < 60) return `Elke ${m} min`;
  if (m >= 1440) return "Dagelijks om 00:00";
  const h = m / 60;
  return h === 1 ? "Elk uur" : `Elke ${h} uur`;
}

const listNl = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} en ${items[items.length - 1]}`);

/**
 * Wat een interval werkelijk doet. Een preset beschrijft zichzelf; een andere waarde (uit een oudere versie of via de
 * API) wordt niet stil omgezet maar getoond als "Aangepast" met de uitkomst van intervalCron, bijv. 90 min → elke 2 uur
 * en 45 min → om :00 en :45 (cron telt vanaf het hele uur).
 */
export function describeInterval(minutes: number): { label: string; custom: boolean; note: string | null } {
  const m = Math.floor(Number(minutes) || 0);
  if (isPresetInterval(m)) return { label: presetLabel(m), custom: false, note: null };
  if (m < 60) {
    const runs: string[] = [];
    for (let x = 0; x < 60; x += m) runs.push(`:${String(x).padStart(2, "0")}`);
    const note = runs.length <= 4 ? `draait om ${listNl(runs)} van elk uur` : `telt elk heel uur opnieuw vanaf :00`;
    return { label: `Aangepast: elke ${m} min`, custom: true, note };
  }
  const h = Math.max(1, Math.round(m / 60));
  if (h >= 24) return { label: `Aangepast: ${m} min`, custom: true, note: "wordt dagelijks om 00:00" };
  const hours: string[] = [];
  for (let x = 0; x < 24; x += h) hours.push(String(x));
  const note = 24 % h === 0 ? `wordt elke ${h} uur` : `wordt elke ${h} uur, om ${listNl(hours)} uur`;
  return { label: `Aangepast: ${m} min`, custom: true, note };
}

// ---------------------------------------------------------------------------------------------------------------------
// Volgende ronde

type Field = { any: true } | { step: number } | { value: number };

function parseField(f: string): Field | null {
  if (f === "*") return { any: true };
  const step = f.match(/^\*\/(\d+)$/);
  if (step) return { step: Number(step[1]) };
  if (/^\d+$/.test(f)) return { value: Number(f) };
  return null;
}

function fieldMatches(f: Field, v: number): boolean {
  if ("any" in f) return true;
  if ("step" in f) return f.step > 0 && v % f.step === 0;
  return f.value === v;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsIn(date: Date, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number } {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute) };
}

/**
 * Het volgende moment (na `from`) waarop een cron-expressie van de worker afgaat, in de gegeven tijdzone. Alleen de
 * vormen die de worker gebruikt: minuut en uur als *, *\/n of een getal, en * voor dag, maand en weekdag.
 */
export function nextRun(cronExpr: string, from: Date, timeZone: string): Date | null {
  const [mf, hf, ...rest] = cronExpr.trim().split(/\s+/);
  const minute = parseField(mf);
  const hour = parseField(hf);
  if (!minute || !hour || rest.some((r) => r !== "*")) return null;
  const start = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 2 * 24 * 60 + 120; i++) {
    const t = new Date(start + i * 60_000);
    const p = partsIn(t, timeZone);
    if (fieldMatches(minute, p.mi) && fieldMatches(hour, p.h)) return t;
  }
  return null;
}

/** "15:00", of "morgen 00:00" als de volgende ronde niet vandaag (in de tijdzone van de planning) is. */
export function formatNextRun(next: Date, now: Date, timeZone: string): string {
  const a = partsIn(next, timeZone);
  const b = partsIn(now, timeZone);
  const hhmm = `${String(a.h).padStart(2, "0")}:${String(a.mi).padStart(2, "0")}`;
  if (a.y === b.y && a.mo === b.mo && a.d === b.d) return hhmm;
  // kalenderdag + 1 (niet +24 uur: rond de zomertijdwissel heeft een dag 23 of 25 uur)
  const t = new Date(Date.UTC(b.y, b.mo - 1, b.d + 1));
  if (a.y === t.getUTCFullYear() && a.mo === t.getUTCMonth() + 1 && a.d === t.getUTCDate()) return `morgen ${hhmm}`;
  return `${String(a.d).padStart(2, "0")}-${String(a.mo).padStart(2, "0")} ${hhmm}`;
}

/** Bestaat deze IANA-tijdzone in deze runtime? (Een onbekende zone zou alle cronjobs laten falen.) */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 60) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
