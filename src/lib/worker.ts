import cron, { type ScheduledTask } from "node-cron";
import { getDb } from "./db";
import { getSettings } from "./settings";
import { ensureHistoryCoverage, refreshAll, type RefreshTrigger } from "./prices/quotes";
import { ensureBtcCoverage, ensureFxCoverage } from "./prices/fx";
import { takeSnapshots } from "./history";
import { refillMissingFx } from "./transactions";
import { syncAll } from "./connections/sync";
import { dailyCron, intervalCron, isValidTimeZone } from "./schedule";

/**
 * Worker in hetzelfde proces: koersverversing elke `priceRefreshMinutes` (standaard elk uur: eToro, Kraken, Yahoo,
 * wisselkoersen en alerts), de dagelijkse ronde (standaard 23:45: koppelingen syncen, koersen, oudere koershistorie en
 * wisselkoersreeksen aanvullen), dagsnapshot (23:59), het aanvullen van ontbrekende wisselkoersen en — apart, elke
 * `walletSyncMinutes` — de Bitcoin-wallet-koppelingen (eigen node, geen rate limit). Tijden zijn lokale tijd
 * (instelling timezone).
 */
interface WorkerState {
  started: boolean;
  prices?: ScheduledTask;
  refresh?: ScheduledTask;
  snapshot?: ScheduledTask;
  wallet?: ScheduledTask;
  refreshBusy: boolean; // een koersronde loopt (interval of dagelijks); een tweede tegelijk slaat over
  walletBusy: boolean;
}
const g = globalThis as unknown as { __pmWorker?: WorkerState };
const state = (): WorkerState => (g.__pmWorker ??= { started: false, refreshBusy: false, walletBusy: false });

export { intervalCron } from "./schedule";

/**
 * Eén koersronde vanuit de worker. Valt de dagelijkse ronde op een tijdstip van het interval (bijv. 14:00 bij elk uur),
 * dan zouden beide dezelfde koersen tegelijk ophalen; wie het laatst komt slaat over.
 */
async function runRefresh(trigger: Exclude<RefreshTrigger, "manual">): Promise<void> {
  const w = state();
  const label = trigger === "interval" ? "interval" : "dagelijks";
  if (w.refreshBusy) {
    console.log(`[worker] verversing (${label}) overgeslagen: er loopt al een koersronde`);
    return;
  }
  w.refreshBusy = true;
  try {
    const r = await refreshAll(trigger);
    console.log(`[worker] verversing (${label}): ${r.updated} bijgewerkt, ${r.failed.length} mislukt`);
  } catch (e) {
    console.error(`[worker] verversing (${label}) mislukt`, e);
  } finally {
    w.refreshBusy = false;
  }
}

export function startWorker() {
  const w = state();
  if (w.started) return;
  getDb(); // migraties + seed
  w.started = true;
  scheduleJobs();
  // bij opstarten: ontbrekende FX en oudere koershistorie (tot de eerste transactie) aanvullen (best effort, niet blokkerend)
  setTimeout(() => {
    refillMissingFx()
      .catch(() => undefined)
      .then(() => ensureHistoryCoverage())
      .catch(() => undefined)
      .then(() => ensureBtcCoverage())
      .catch(() => undefined)
      .then(() => ensureFxCoverage())
      .catch(() => undefined);
  }, 5000);
  console.log("[worker] gestart");
}

export function scheduleJobs() {
  const settings = getSettings();
  // een onbekende tijdzone zou elke cron laten falen nadat de oude taken al gestopt zijn
  const s = { ...settings, timezone: isValidTimeZone(settings.timezone) ? settings.timezone : "Europe/Amsterdam" };
  const w = state();
  w.prices?.stop();
  w.refresh?.stop();
  w.snapshot?.stop();
  w.wallet?.stop();
  // koersen per interval (standaard elk uur): alleen de koersbronnen, geen koppelingen (Kraken en eToro hebben een rate limit)
  const pricesExpr = intervalCron(s.priceRefreshMinutes);
  w.prices = pricesExpr ? cron.schedule(pricesExpr, () => runRefresh("interval"), { timezone: s.timezone }) : undefined;
  w.refresh = cron.schedule(
    dailyCron(s.refreshTime),
    async () => {
      try {
        const syncs = await syncAll("scheduled");
        if (syncs.length) console.log(`[worker] koppelingen: ${syncs.map((s) => `#${s.connectionId} ${s.ok ? "ok" : "fout"} (${s.message})`).join(", ")}`);
      } catch (e) {
        console.error("[worker] sync koppelingen mislukt", e);
      }
      await runRefresh("scheduled");
      await ensureBtcCoverage().catch(() => undefined); // BTC-EUR-reeks voor de weergave in BTC
      await ensureFxCoverage().catch(() => undefined); // gaten in de ECB-reeksen (USD, CHF, GBP)
      try {
        const c = await ensureHistoryCoverage();
        if (c.filled > 0 || c.failed.length > 0) console.log(`[worker] oudere koershistorie: ${c.filled} dagkoersen (${c.assets.join(", ")}), ${c.failed.length} mislukt`);
      } catch (e) {
        console.error("[worker] oudere koershistorie mislukt", e);
      }
    },
    { timezone: s.timezone }
  );
  w.snapshot = cron.schedule(
    dailyCron(s.snapshotTime),
    () => {
      try {
        const n = takeSnapshots();
        console.log(`[worker] snapshot: ${n} portfolios`);
      } catch (e) {
        console.error("[worker] snapshot mislukt", e);
      }
    },
    { timezone: s.timezone }
  );
  const walletExpr = intervalCron(s.walletSyncMinutes);
  w.wallet = walletExpr
    ? cron.schedule(
        walletExpr,
        async () => {
          if (w.walletBusy) return; // een lange eerste sync niet inhalen
          w.walletBusy = true;
          try {
            const runs = await syncAll("interval", { providers: ["bitcoin"] });
            for (const r of runs) if (!r.ok || r.created > 0) console.log(`[worker] wallet #${r.connectionId}: ${r.ok ? "ok" : "fout"} (${r.message})`);
          } catch (e) {
            console.error("[worker] wallet-sync mislukt", e);
          } finally {
            w.walletBusy = false;
          }
        },
        { timezone: s.timezone }
      )
    : undefined;
}
