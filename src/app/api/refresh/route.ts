import { handler, json } from "@/lib/api";
import { ensureHistoryCoverage, refreshAll } from "@/lib/prices/quotes";
import { ensureBtcCoverage, ensureFxCoverage } from "@/lib/prices/fx";
import { syncAll } from "@/lib/connections/sync";

export const POST = handler(async () => {
  // eerst de Bitcoin-wallet-koppelingen (eigen node, snel); Kraken en eToro blijven bij de dagelijkse ronde
  const wallets = await syncAll("manual", { providers: ["bitcoin"] });
  const report = await refreshAll("manual");
  await ensureHistoryCoverage().catch(() => undefined); // oudere koersen tot de eerste transactie (eenmalig per gat)
  await ensureBtcCoverage().catch(() => undefined); // BTC-EUR-reeks voor de weergave in BTC
  await ensureFxCoverage().catch(() => undefined); // gaten in de ECB-reeksen (USD, CHF, GBP)
  return json({ ...report, wallets: wallets.map((w) => ({ connectionId: w.connectionId, ok: w.ok, created: w.created, message: w.message })) });
});
