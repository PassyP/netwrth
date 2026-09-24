import { handler, json, parsePortfolioId } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { computeHistory, HISTORY_FILTERS, type HistoryFilter } from "@/lib/history";
import { shiftDays } from "@/lib/prices/fx";
import { awaitHistoryCoverage } from "@/lib/prices/quotes";

const RANGES: Record<string, number | null> = { "1D": 1, "1W": 7, "1M": 30, "3M": 91, "1J": 365, "5J": 1826, Alles: null };

/** ?by=category|platform|currency|asset&key=… (de sleutel van een allocatiesegment); zonder `by` het hele portfolio. */
function parseFilter(params: URLSearchParams): HistoryFilter | undefined {
  const by = params.get("by");
  if (by == null) return undefined;
  const key = params.get("key");
  if (!(HISTORY_FILTERS as readonly string[]).includes(by) || !key) throw new ApiError("Ongeldig filter voor de historie");
  return { by: by as HistoryFilter["by"], key };
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
