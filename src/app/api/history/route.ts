import { handler, json, parsePortfolioId } from "@/lib/api";
import { computeHistory } from "@/lib/history";
import { shiftDays } from "@/lib/prices/fx";
import { awaitHistoryCoverage } from "@/lib/prices/quotes";

const RANGES: Record<string, number | null> = { "1D": 1, "1W": 7, "1M": 30, "3M": 91, "1J": 365, Alles: null };

export const GET = handler(async (req) => {
  const range = new URL(req.url).searchParams.get("range") ?? "Alles";
  const days = RANGES[range] ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const from = days == null ? undefined : shiftDays(today, -days);
  // Oudere koersen tot de eerste transactie eenmalig via Yahoo aanvullen (daarna staan ze in de database en kost dit
  // alleen twee aggregaties): zonder koers ligt de lijn tot de eerste dag van de koersfeed plat op kostprijs. Net zo de
  // gaten in de ECB-reeksen, anders rekent de lijn daar met de laatste wisselkoers ervóór.
  await awaitHistoryCoverage(8000);
  return json(computeHistory(parsePortfolioId(req), from));
});
