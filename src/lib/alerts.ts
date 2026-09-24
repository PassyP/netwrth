import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { latestQuote } from "./prices/quotes";
import { fxNowSync } from "./prices/fx";
import { notify } from "./notify";
import { formatMoney } from "./format";

/** Controleert alle actieve alerts tegen de laatste koers (in de valuta van de alert). */
export async function checkAlerts(): Promise<number> {
  const db = getDb();
  const active = db.select().from(schema.alerts).where(eq(schema.alerts.status, "active")).all();
  let fired = 0;
  for (const alert of active) {
    const asset = db.select().from(schema.assets).where(eq(schema.assets.id, alert.assetId)).get();
    const q = asset ? latestQuote(asset.id) : null;
    if (!asset || !q) continue;
    let price = new Decimal(q.price);
    if (q.currency !== alert.currency) {
      const fx = fxNowSync(q.currency);
      if (!fx) continue;
      if (alert.currency === "EUR") price = price.mul(fx.fxEur);
      else if (alert.currency === "USD") price = price.mul(fx.fxUsd);
      else continue;
    }
    const threshold = new Decimal(alert.threshold);
    const hit = alert.condition === "above" ? price.gte(threshold) : price.lte(threshold);
    if (!hit) continue;
    const now = new Date().toISOString();
    db.update(schema.alerts).set({ status: "triggered", triggeredAt: now, triggeredPrice: price.toFixed(6) }).where(eq(schema.alerts.id, alert.id)).run();
    fired++;
    await notify(
      `${asset.symbol} ${alert.condition === "above" ? "boven" : "onder"} ${formatMoney(threshold, alert.currency)}`,
      `${asset.name} staat op ${formatMoney(price, alert.currency)} (drempel ${formatMoney(threshold, alert.currency)}).`
    );
  }
  return fired;
}
