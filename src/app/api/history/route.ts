import { handler, json, parsePortfolioId } from "@/lib/api";
import { computeHistory, HISTORY_FILTERS, type HistoryFilter } from "@/lib/history";
import { shiftDays } from "@/lib/prices/fx";
import { awaitHistoryCoverage } from "@/lib/prices/quotes";

const RANGES: Record<string, number | null> = { "1D": 1, "1W": 7, "1M": 30, "3M": 91, "1J": 365, "5J": 1826, Alles: null };

/** ?category=…&platform=…&currency=…&asset=… (sleutels zoals in de allocatie, samen = en); zonder filter het hele portfolio. */
function parseFilter(params: URLSearchParams): HistoryFilter | undefined {
  const filter: HistoryFilter = {};
  for (const k of HISTORY_FILTERS) {
    const v = params.get(k);
    if (v) filter[k] = v;
  }
  return Object.keys(filter).length > 0 ? filter : undefined;
}

export const GET = handler(async (req) => {
  const params = new URL(req.url).searchParams;
  const range = params.get("range") ?? "Alles";
  const filter = parseFilter(params);
  const days = RANGES[range] ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const from = days == null ? undefined : shiftDays(today, -days);
  // Oudere koersen tot de eerste transactie eenmalig via Yahoo aanvullen (daarna staan ze in de database en kost dit
  // alleen twee aggregaties): zonder koers ligt de lijn tot de eerste dag van de koersfeed plat op kostprijs. Net zo de
  // gaten in de ECB-reeksen, anders rekent de lijn daar met de laatste wisselkoers ervóór.
  await awaitHistoryCoverage(8000);
  return json(computeHistory(parsePortfolioId(req), from, filter));
});
