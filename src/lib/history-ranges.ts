/**
 * Aantal dagen terug voor een periodeknop van een grafiek (?range=1W, 1M, …); null = alles. Een onbekende periode krijgt
 * `fallback`. Niet `days[range] ?? fallback`: dan wordt ook Alles (null) de fallback. Alleen eigen sleutels: "constructor"
 * of "__proto__" mag niet op Object.prototype uitkomen.
 */
export function rangeDays(days: Readonly<Record<string, number | null>>, range: string, fallback: number | null): number | null {
  return Object.hasOwn(days, range) ? days[range] : fallback;
}
