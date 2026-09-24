import { eq } from "drizzle-orm";
import { handler, json, idFromParams } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { rangeDays } from "@/lib/history-ranges";
import { quoteHistory, backfillHistory, awaitHistoryCoverage } from "@/lib/prices/quotes";
import { shiftDays } from "@/lib/prices/fx";

const RANGES: Record<string, number | null> = { "1D": 2, "1W": 7, "1M": 30, "3M": 91, "1J": 365, "5J": 1826, Alles: null };

export const GET = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  const range = new URL(req.url).searchParams.get("range") ?? "1J";
  const days = rangeDays(RANGES, range, 365);
  const from = days == null ? "1900-01-01" : shiftDays(new Date().toISOString().slice(0, 10), -days);
  if (days == null) await awaitHistoryCoverage(8000); // Alles: oudere dagen tot de eerste transactie eenmalig via Yahoo aanvullen
  let rows = quoteHistory(id, from);
  if (rows.length < 5 && new URL(req.url).searchParams.get("backfill") !== "0") {
    const asset = getDb().select().from(schema.assets).where(eq(schema.assets.id, id)).get();
    if (asset && (asset.priceSource === "etoro" || asset.priceSource === "yahoo" || asset.priceSource === "kraken")) {
      try {
        await backfillHistory(asset, days == null ? 1000 : days);
        rows = quoteHistory(id, from);
      } catch {
        /* offline */
      }
    }
  }
  return json(rows.map((r) => ({ day: r.day, price: r.price, currency: r.currency })));
});
