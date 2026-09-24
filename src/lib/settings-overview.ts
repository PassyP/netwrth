/**
 * Statuslaag van Instellingen: de aandachtspunten bovenaan /settings, de samenvatting per categorie in de index en het
 * samengevoegde activiteitenlog (koersrondes, snapshots en syncs van koppelingen). Alles komt uit bestaande data: een
 * punt waarvoor geen data is, wordt niet getoond. Kritieke punten (geen wachtwoord, geen herstelcode, een koppeling in
 * fout) zijn niet weg te klikken en geven een stip op Instellingen in de navigatie; "let op" en "info" wel, tot er iets
 * verandert (fingerprint).
 */
import { createHash } from "node:crypto";
import { desc, eq, inArray, like } from "drizzle-orm";
import { dataDir, getDb, schema } from "./db";
import { isPasswordSet, isRecoveryCodeSet } from "./auth";
import { bitcoinApiUrlSource, getMeta, getSettings, setMeta, deleteMeta } from "./settings";
import { listConnections, parseWarnings } from "./connections/sync";
import { resolveEtoroKeys } from "./prices/etoro";
import { describeInterval, isValidTimeZone } from "./schedule";
import type { SettingsCategoryId } from "./settings-nav";

export type AttentionSeverity = "critical" | "warn" | "info";

export interface AttentionItem {
  key: string;
  severity: AttentionSeverity;
  /** vetgedrukt begin, bijv. "Niet beveiligd:" */
  title: string;
  body: string;
  action: { label: string; href: string; download?: boolean };
  /** verandert als de situatie verandert; een weggeklikt punt komt dan terug */
  fingerprint: string;
  dismissible: boolean;
}

const SEVERITY_ORDER: Record<AttentionSeverity, number> = { critical: 0, warn: 1, info: 2 };
const BACKUP_MAX_AGE_DAYS = 30;
const REFRESH_WINDOW = 10;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** Eerste regel van een foutmelding, zonder afsluitende punt (die zetten we zelf). */
const firstLine = (s: string | null | undefined) => (s ?? "").split("\n")[0].trim().replace(/\.+$/, "");
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
/** "AAA, BBB en CCC" of "AAA, BBB, CCC en 2 meer". */
function names(list: string[], max = 3): string {
  const u = [...new Set(list)];
  if (u.length <= max) return u.length <= 1 ? u.join("") : `${u.slice(0, -1).join(", ")} en ${u[u.length - 1]}`;
  return `${u.slice(0, max).join(", ")} en ${u.length - max} meer`;
}

/**
 * Aantal waarschuwingen van een run: het getal in de melding (de bewaarde lijst is afgekapt op SYNC_WARNINGS_KEEP), of
 * de lengte van de lijst als de melding geen getal noemt.
 */
export function warningCount(run: { warnings: string[] | string | null; message: string | null } | null): number {
  if (!run) return 0;
  const list = Array.isArray(run.warnings) ? run.warnings : parseWarnings(run.warnings);
  const m = (run.message ?? "").match(/(\d+) waarschuwing/);
  return Math.max(list.length, m ? Number(m[1]) : 0);
}

/** Vaste lengte, want de bron kan honderden waarschuwingen zijn; hij gaat mee in elke overzichtsrespons en in de meta. */
const fingerprintOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

type Conn = ReturnType<typeof listConnections>[number];

interface RefreshJob {
  ok: boolean | null;
  message: string | null;
  details: string | null;
  startedAt: string;
}

function recentRefreshJobs(n = REFRESH_WINDOW): RefreshJob[] {
  return getDb()
    .select({ ok: schema.jobRuns.ok, message: schema.jobRuns.message, details: schema.jobRuns.details, startedAt: schema.jobRuns.startedAt })
    .from(schema.jobRuns)
    .where(like(schema.jobRuns.job, "refresh:%"))
    .orderBy(desc(schema.jobRuns.id))
    .limit(n)
    .all();
}

/** Namen van de mislukte koersen van een ronde: uit de details, anders uit de melding ("…, 2 mislukt: AAA, BBB"). */
function failedNames(job: RefreshJob): string[] {
  try {
    const d = job.details ? (JSON.parse(job.details) as { failed?: { asset: string }[] }) : null;
    if (d?.failed?.length) return d.failed.map((f) => f.asset);
  } catch {
    /* val terug op de melding */
  }
  const m = (job.message ?? "").match(/mislukt: (.+)$/);
  return m ? m[1].replace(/ en \d+ meer$/, "").split(", ").filter(Boolean) : [];
}

function dismissedMap(): Record<string, string> {
  try {
    const raw = getMeta("attentionDismissed");
    const v = raw ? (JSON.parse(raw) as unknown) : {};
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** "Negeren tot er iets verandert": het punt blijft weg zolang de fingerprint gelijk blijft. Kritiek kan niet. */
export function dismissAttention(key: string, fingerprint: string) {
  const map = dismissedMap();
  map[key] = fingerprint;
  setMeta("attentionDismissed", JSON.stringify(map));
}

export function resetDismissedAttention() {
  deleteMeta("attentionDismissed");
}

interface Context {
  settings: ReturnType<typeof getSettings>;
  connections: Conn[];
  passwordSet: boolean;
  recoveryCodeSet: boolean;
  pushSubs: number;
  now: Date;
}

function context(now: Date): Context {
  const db = getDb();
  return {
    settings: getSettings(),
    connections: listConnections(),
    passwordSet: isPasswordSet(),
    recoveryCodeSet: isRecoveryCodeSet(),
    pushSubs: db.select({ id: schema.pushSubscriptions.id }).from(schema.pushSubscriptions).all().length,
    now,
  };
}

function allAttention(ctx: Context): AttentionItem[] {
  const db = getDb();
  const { settings, connections } = ctx;
  const items: AttentionItem[] = [];
  const add = (i: Omit<AttentionItem, "dismissible">) => items.push({ ...i, fingerprint: fingerprintOf(i.fingerprint), dismissible: i.severity !== "critical" });
  const detail = (c: Conn) => `/settings/platforms/${c.platformId}`;

  // toegang
  if (!ctx.passwordSet) {
    add({ key: "security:password", severity: "critical", title: "Niet beveiligd:", body: "iedereen op je netwerk kan de app openen en je saldi en wallets zien.", action: { label: "Wachtwoord instellen", href: "/settings/beveiliging#toegang" }, fingerprint: "no-password" });
  } else if (!ctx.recoveryCodeSet) {
    add({ key: "security:recovery", severity: "critical", title: "Geen herstelcode:", body: "ben je je wachtwoord vergeten, dan kom je niet meer in de app.", action: { label: "Herstelcode maken", href: "/settings/beveiliging#toegang" }, fingerprint: "no-recovery" });
  }

  // koppelingen
  for (const c of connections) {
    if (c.status === "error") {
      add({ key: `conn:${c.id}:error`, severity: "critical", title: `${c.label}:`, body: `sync mislukt (${firstLine(c.lastError) || "onbekende fout"}).`, action: { label: "Bekijken", href: detail(c) }, fingerprint: firstLine(c.lastError) });
      continue;
    }
    const recon = (c.reconciliation as { symbol: string; diff: string }[] | null) ?? [];
    if (recon.length) {
      add({ key: `conn:${c.id}:recon`, severity: "warn", title: `${c.label}:`, body: `${plural(recon.length, "afstemmingsverschil", "afstemmingsverschillen")} (${names(recon.map((d) => d.symbol))}).`, action: { label: "Bekijken", href: detail(c) }, fingerprint: JSON.stringify(recon.map((d) => [d.symbol, d.diff])) });
    }
    const w = warningCount(c.lastRun);
    if (c.lastRun?.ok && w > 0) {
      add({ key: `conn:${c.id}:warnings`, severity: "warn", title: `${c.label}:`, body: `${plural(w, "waarschuwing", "waarschuwingen")} bij de laatste sync.`, action: { label: "Bekijken", href: detail(c) }, fingerprint: c.lastRun.warnings.length ? c.lastRun.warnings.join("\n") : (c.lastRun.message ?? "") });
    }
  }

  // Bitcoin-node
  const wallets = connections.filter((c) => c.provider === "bitcoin");
  if (wallets.length) {
    const ownUrl = settings.bitcoinApiUrl.trim();
    const viaPublic = wallets.filter((c) => c.nodeSource === "fallback");
    if (viaPublic.length || (!ownUrl && settings.bitcoinFallbackEnabled)) {
      const who = viaPublic.length ? viaPublic : wallets;
      const host = hostOf(settings.bitcoinFallbackUrl);
      add({ key: "node:fallback", severity: "warn", title: "Publieke node in gebruik:", body: `${names(who.map((c) => c.label))} ${who.length === 1 ? "synchroniseert" : "synchroniseren"} via ${host}; die node ziet je wallet-adressen.`, action: { label: "Node instellen", href: "/settings/platforms#bitcoin-node" }, fingerprint: `${who.map((c) => c.id).join(",")}|${host}` });
    } else if (!ownUrl && !settings.bitcoinFallbackEnabled && !wallets.some((c) => c.status === "error")) {
      add({ key: "node:missing", severity: "warn", title: "Geen Bitcoin-node:", body: `${names(wallets.map((c) => c.label))} ${wallets.length === 1 ? "kan" : "kunnen"} niet synchroniseren.`, action: { label: "Node instellen", href: "/settings/platforms#bitcoin-node" }, fingerprint: "no-node" });
    }
  }

  // koersen
  const jobs = recentRefreshJobs();
  if (jobs.length && jobs[0].ok === false) {
    const failedRuns = jobs.filter((j) => j.ok === false).length;
    const latest = failedNames(jobs[0]);
    const what = latest.length ? `${names(latest)} ${latest.length === 1 ? "mislukte" : "mislukten"}` : "Koersen mislukten";
    add({ key: "prices:failed", severity: "warn", title: "Koersen:", body: `${what} in ${failedRuns} van de laatste ${plural(jobs.length, "ronde", "rondes")}.`, action: { label: "Bekijken", href: "/settings/koersen#taken" }, fingerprint: [...new Set(latest)].sort().join(",") || (jobs[0].message ?? "") });
  }
  const etoroAssets = db.select({ id: schema.assets.id }).from(schema.assets).where(eq(schema.assets.priceSource, "etoro")).all().length;
  if (etoroAssets > 0 && !resolveEtoroKeys()) {
    add({ key: "prices:etoro-keys", severity: "warn", title: "eToro-koersen:", body: `${plural(etoroAssets, "asset volgt", "assets volgen")} eToro, maar er zijn geen eToro-keys.`, action: { label: "Keys invullen", href: "/settings/koersen#koersbronnen" }, fingerprint: "no-etoro-keys" });
  }

  // meldingen
  if (settings.notifyChannel === "push" && ctx.pushSubs === 0) {
    add({ key: "notify:push-none", severity: "warn", title: "Push staat aan,", body: "maar geen enkel apparaat is aangemeld: meldingen komen alleen in de app.", action: { label: "Oplossen", href: "/settings/meldingen" }, fingerprint: "push-none" });
  }
  if (settings.notifyChannel === "ntfy" && !settings.ntfyTopicUrl.trim()) {
    add({ key: "notify:ntfy-missing", severity: "warn", title: "ntfy staat aan,", body: "maar er is geen topic-URL ingevuld.", action: { label: "Oplossen", href: "/settings/meldingen" }, fingerprint: "ntfy-missing" });
  }

  // portfolios
  const archived = db.select().from(schema.portfolios).where(eq(schema.portfolios.archived, true)).all();
  for (const p of archived) {
    const n = connections.filter((c) => c.portfolioId === p.id).length;
    if (n) add({ key: `portfolio:${p.id}:archived`, severity: "info", title: `${p.name} is gearchiveerd,`, body: `maar ${n === 1 ? "1 koppeling boekt" : `${n} koppelingen boeken`} er nog in.`, action: { label: "Bekijken", href: "/settings/portfolios" }, fingerprint: String(n) });
  }

  // back-up
  const last = getMeta("lastBackupAt");
  const month = ctx.now.toISOString().slice(0, 7);
  if (!last) {
    add({ key: "backup:none", severity: "info", title: "Nog geen back-up:", body: "download er een en bewaar secret.key erbij.", action: { label: "Back-up downloaden", href: "/api/backup", download: true }, fingerprint: month });
  } else {
    const days = Math.floor((ctx.now.getTime() - Date.parse(last)) / 86_400_000);
    if (days > BACKUP_MAX_AGE_DAYS) add({ key: "backup:old", severity: "info", title: "Laatste back-up", body: `is ${days} dagen oud.`, action: { label: "Back-up downloaden", href: "/api/backup", download: true }, fingerprint: `${last}|${month}` });
  }

  return items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Aandachtspunten voor /settings, zonder de weggeklikte (tenzij er iets veranderde). */
export function computeAttention(now = new Date()): { items: AttentionItem[]; dismissed: number } {
  const ctx = context(now);
  const all = allAttention(ctx);
  const map = dismissedMap();
  // Is een punt opgelost, dan vervalt het negeren: komt het later terug (met dezelfde vaste fingerprint), dan zie je het
  // weer. Een koppeling die nu synct heeft tijdelijk geen afgeronde run; haar punten blijven genegeerd.
  const present = new Set(all.map((i) => i.key));
  const syncing = ctx.connections.filter((c) => c.status === "syncing").map((c) => `conn:${c.id}:`);
  const kept = Object.fromEntries(Object.entries(map).filter(([k]) => present.has(k) || syncing.some((p) => k.startsWith(p))));
  if (Object.keys(kept).length !== Object.keys(map).length) setMeta("attentionDismissed", JSON.stringify(kept));
  const items = all.filter((i) => !i.dismissible || kept[i.key] !== i.fingerprint);
  return { items, dismissed: all.length - items.length };
}

/** Aantal kritieke punten, goedkoop genoeg voor de stip in de navigatie (elke paginaweergave). */
export function criticalCount(): number {
  let n = 0;
  if (!isPasswordSet()) n++;
  else if (!isRecoveryCodeSet()) n++;
  n += getDb().select({ id: schema.connections.id }).from(schema.connections).where(eq(schema.connections.status, "error")).all().length;
  return n;
}

export interface CategorySummary {
  text: string;
  level: "critical" | "warn" | null;
}

/** Eén regel per categorie voor de index: de huidige stand, zodat je vaak niet hoeft door te klikken. */
export function settingsSummaries(now = new Date()): Record<SettingsCategoryId, CategorySummary> {
  const ctx = context(now);
  const db = getDb();
  const { settings: s, connections } = ctx;
  const attention = allAttention(ctx);
  const levelFor = (prefixes: string[]): CategorySummary["level"] => {
    const hits = attention.filter((i) => prefixes.some((p) => i.key.startsWith(p)));
    if (hits.some((i) => i.severity === "critical")) return "critical";
    return hits.some((i) => i.severity === "warn") ? "warn" : null;
  };

  const portfolios = db.select().from(schema.portfolios).all();
  const archived = portfolios.filter((p) => p.archived).length;
  const platforms = db.select({ id: schema.platforms.id }).from(schema.platforms).all().length;
  const problems = connections.filter((c) => c.status === "error").length;
  const wallets = connections.filter((c) => c.provider === "bitcoin");
  const node = !wallets.length ? null : s.bitcoinApiUrl.trim() ? (wallets.some((c) => c.nodeSource === "fallback") ? "publieke node" : "eigen node") : s.bitcoinFallbackEnabled ? "publieke node" : "geen node";
  const jobs = recentRefreshJobs(1);
  const failed = jobs[0] && jobs[0].ok === false ? failedNames(jobs[0]).length || 1 : 0;
  const interval = describeInterval(s.priceRefreshMinutes);
  const channel = { app: "Alleen in de app", push: "Push", ntfy: "ntfy" }[s.notifyChannel];
  const last = getMeta("lastBackupAt");
  const timeZone = isValidTimeZone(s.timezone) ? s.timezone : "Europe/Amsterdam";

  return {
    weergave: { text: `${s.displayCurrency} · ${s.costMethod === "fifo" ? "FIFO" : "gemiddelde kostprijs"} · valuta-effect ${s.ignoreFx ? "genegeerd" : "mee"} · stof ${s.hideDust ? "verborgen" : "zichtbaar"}`, level: null },
    portfolios: { text: `${portfolios.length - archived} actief${archived ? ` · ${archived} gearchiveerd` : ""}`, level: null },
    platforms: {
      text: [plural(platforms, "platform", "platforms"), plural(connections.length, "koppeling", "koppelingen"), problems ? `${problems} in fout` : null, node].filter(Boolean).join(" · "),
      level: levelFor(["conn:", "node:"]),
    },
    koersen: {
      text: [`Koersen ${s.priceRefreshMinutes > 0 ? interval.label.toLowerCase().replace(/^aangepast: /, "") : "alleen dagelijks"}`, `ronde ${s.refreshTime}`, failed ? `${failed} mislukt` : null].filter(Boolean).join(" · "),
      level: levelFor(["prices:"]),
    },
    meldingen: { text: s.notifyChannel === "push" ? `${channel} · ${plural(ctx.pushSubs, "apparaat", "apparaten")}` : channel, level: levelFor(["notify:"]) },
    beveiliging: {
      text: [!ctx.passwordSet ? "Niet beveiligd" : ctx.recoveryCodeSet ? "Beveiligd" : "Beveiligd, geen herstelcode", last ? `back-up ${new Date(last).toLocaleDateString("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric", timeZone })}` : "nog geen back-up"].join(" · "),
      level: levelFor(["security:"]),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Activiteit: koersrondes, snapshots en syncs van koppelingen in één lijst

const JOB_LABELS: Record<string, string> = {
  "refresh:manual": "Koersen verversen (handmatig)",
  "refresh:scheduled": "Koersen verversen (dagelijkse ronde)",
  "refresh:interval": "Koersen verversen (automatisch)",
  snapshot: "Dagsnapshot",
};
const TRIGGER_LABELS: Record<string, string> = { manual: "handmatig", scheduled: "dagelijkse ronde", interval: "automatisch", initial: "eerste sync" };

export interface ActivityRun {
  kind: "job" | "sync";
  id: number;
  /** groepeersleutel: gelijke taak + zelfde uitkomst wordt één regel */
  key: string;
  label: string;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  message: string | null;
  failed: { asset: string; assetId?: number; error: string }[];
  warnings: string[];
  platformId: number | null;
}

export function recentActivity(limit = 50): ActivityRun[] {
  const db = getDb();
  const n = Math.max(1, Math.min(500, Math.floor(limit)));
  const jobs: ActivityRun[] = db
    .select()
    .from(schema.jobRuns)
    .orderBy(desc(schema.jobRuns.id))
    .limit(n)
    .all()
    .map((j) => {
      let failed: ActivityRun["failed"] = [];
      try {
        failed = j.details ? ((JSON.parse(j.details) as { failed?: ActivityRun["failed"] }).failed ?? []) : [];
      } catch {
        failed = [];
      }
      return { kind: "job", id: j.id, key: j.job, label: JOB_LABELS[j.job] ?? j.job, startedAt: j.startedAt, finishedAt: j.finishedAt, ok: j.ok, message: j.message, failed, warnings: [], platformId: null };
    });
  const runs = db.select().from(schema.syncRuns).orderBy(desc(schema.syncRuns.id)).limit(n).all();
  const conns = runs.length ? db.select().from(schema.connections).where(inArray(schema.connections.id, [...new Set(runs.map((r) => r.connectionId))])).all() : [];
  const byId = new Map(conns.map((c) => [c.id, c]));
  const syncs: ActivityRun[] = runs.map((r) => {
    const c = byId.get(r.connectionId);
    const name = c?.label ?? `Koppeling ${r.connectionId}`;
    return {
      kind: "sync",
      id: r.id,
      key: `sync:${r.connectionId}:${r.trigger}`,
      label: `${c?.provider === "bitcoin" ? "Wallet-sync" : "Sync"} ${name} (${TRIGGER_LABELS[r.trigger] ?? r.trigger})`,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      ok: r.ok,
      message: r.message,
      failed: [],
      warnings: parseWarnings(r.warnings),
      platformId: c?.platformId ?? null,
    };
  });
  return [...jobs, ...syncs].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0)).slice(0, n);
}

/** Feiten voor "Over deze installatie" en de back-upkaart (alleen voor ingelogde gebruikers: bevat het pad van de datamap). */
export function installInfo() {
  const db = getDb();
  const fx = db.select({ date: schema.fxRates.date }).from(schema.fxRates).orderBy(desc(schema.fxRates.date)).limit(1).get();
  return {
    version: process.env.APP_VERSION ?? "dev",
    fxDate: fx?.date ?? null,
    timezone: getSettings().timezone,
    lastBackupAt: getMeta("lastBackupAt"),
    secretSource: process.env.APP_SECRET ? ("env" as const) : ("file" as const),
    dataDir: dataDir(),
    bitcoinApiUrlSource: bitcoinApiUrlSource(),
  };
}
