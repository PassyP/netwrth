"use client";

/**
 * Koersen en planning: waar koersen vandaan komen (met de eToro-keys en wat ervan afhangt), wanneer de app bijwerkt, en
 * hoe dat ging. Planning en uitkomst staan bewust op één pagina: een mislukte ronde lees je direct onder het interval
 * dat hem startte, en de oplossing (meestal een eToro-key) staat bovenaan dezelfde pagina.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState } from "react";
import { ChevronRight, CircleCheck, CircleX, Clock, TriangleAlert } from "lucide-react";
import { api, useApi, useApp } from "../app-state";
import { Card, Skeleton, useFormat } from "../ui";
import type { ConnectionRow } from "../connections";
import { CommitInput, ConfirmDialog, Disclosure, InlineResult, IntervalSelect, SaveState, Segmented, SettingRow, SettingRows, StatusBadge, type TestResult } from "./ui";
import { SettingsPageHeader, SettingsStack, useScrollToHash, useSettings, type MaskedSecret, type SettingsData } from "./context";
import { formatDate, getDisplayTimeZone, setDisplayTimeZone } from "@/lib/format";
import { dailyCron, formatNextRun, isValidTimeZone, nextRun } from "@/lib/schedule";
import type { ActivityRun } from "@/lib/settings-overview";

interface AssetLite {
  id: number;
  priceSource: string;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const assetsLabel = (n: number) => `${n} asset${n === 1 ? "" : "s"}`;
const newestFirst = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

export function PriceSettings() {
  const { data } = useSettings();
  const conns = useApi<ConnectionRow[]>("/api/connections");
  const assets = useApi<AssetLite[]>("/api/assets");
  // pas scrollen als ook de koppelingen en assets er zijn: die bepalen de hoogte van de rij eToro
  const settled = (r: { data: unknown; error: string | null }) => r.data !== null || r.error !== null;
  useScrollToHash(!!data && settled(conns) && settled(assets));

  return (
    <div className="space-y-4">
      <SettingsPageHeader category="koersen" />
      {data ? (
        <SettingsStack>
          <SourcesCard data={data} connections={conns.data} assets={assets.data} reloadConnections={conns.reload} />
          <PlanningCard data={data} />
          <TasksCard />
        </SettingsStack>
      ) : (
        <SettingsStack>
          <Skeleton className="h-64" />
          <Skeleton className="h-80" />
          <Skeleton className="h-48" />
        </SettingsStack>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Koersbronnen

/** Eén bron als rij: naam en status links met de metaregels eronder, acties rechts (op mobiel eronder). */
function SourceRow({ name, badge, meta, actions, children }: { name: string; badge: React.ReactNode; meta?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="py-3 first:pt-1 last:pb-1">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-semibold">
            {name}
            {badge}
          </div>
          {meta && <div className="mt-0.5 space-y-0.5 break-words text-xs text-muted">{meta}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

function SourcesCard({ data, connections, assets, reloadConnections }: { data: SettingsData; connections: ConnectionRow[] | null; assets: AssetLite[] | null; reloadConnections: () => void }) {
  const count = (source: string) => (assets ? assets.filter((a) => a.priceSource === source).length : null);
  const etoroConns = (connections ?? []).filter((c) => c.provider === "etoro");
  const publicMeta = (n: number | null) => `Publieke marktdata, geen key nodig${n === null ? "" : ` · ${assetsLabel(n)}`}`;
  const fxDate = data.install.fxDate;

  return (
    <Card title="Koersbronnen" id="koersbronnen" description="Waar koersen vandaan komen. Alleen eToro heeft een key nodig.">
      <SettingRows>
        <EtoroRow data={data} etoroConns={etoroConns} etoroAssets={count("etoro")} reloadConnections={reloadConnections} />
        <SourceRow name="Kraken" badge={<StatusBadge tone="neutral">Publiek</StatusBadge>} meta={publicMeta(count("kraken"))} />
        <SourceRow name="Yahoo Finance" badge={<StatusBadge tone="neutral">Publiek</StatusBadge>} meta={publicMeta(count("yahoo"))} />
        <SourceRow name="Wisselkoersen" badge={<StatusBadge tone="neutral">ECB</StatusBadge>} meta={fxDate ? `Bijgewerkt ${formatDate(dayIso(fxDate))}` : "Nog niet opgehaald"} />
      </SettingRows>
    </Card>
  );
}

/** Een kale datum ("2026-09-23") op het middaguur UTC, zodat hij in elke tijdzone op dezelfde dag valt. */
function dayIso(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00Z` : date;
}

function keyText(k: MaskedSecret, name: string): string {
  return k.present ? `${name} ••••${k.last4 ?? ""}` : `${name} ontbreekt`;
}

/**
 * De eToro-koers-keys. Koersen gebruiken eerst deze keys en anders de eigen keys van een eToro-koppeling; koppelingen
 * met "gedeelde keys" hebben alleen deze. Daarom noemen status en verwijderdialoog precies wie ervan afhangt.
 */
function EtoroRow({ data, etoroConns, etoroAssets, reloadConnections }: { data: SettingsData; etoroConns: ConnectionRow[]; etoroAssets: number | null; reloadConnections: () => void }) {
  const fmt = useFormat();
  const { toast } = useApp();
  const { reload, reloadOverview } = useSettings();
  const [editing, setEditing] = useState(false);
  const [test, setTest] = useState<TestResult>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { etoroApiKey: apiKey, etoroUserKey: userKey } = data.secrets;
  const anyKey = apiKey.present || userKey.present;
  const globalKeys = apiKey.present && userKey.present;
  const shared = etoroConns.filter((c) => c.keys.shared);
  const own = etoroConns.filter((c) => !c.keys.shared && c.keys.present);
  const testing = !!test && "busy" in test;
  const changedAt = [apiKey.updatedAt, userKey.updatedAt].reduce<string | null>((max, d) => (d && (!max || d > max) ? d : max), null);

  const badge = globalKeys ? (
    <StatusBadge tone="ok">Ingesteld</StatusBadge>
  ) : own[0] ? (
    <StatusBadge tone="neutral" className="max-w-full">
      <span className="truncate">Via koppeling {own[0].label}</span>
    </StatusBadge>
  ) : etoroAssets ? (
    <StatusBadge tone="warn">Ontbreekt</StatusBadge>
  ) : (
    <StatusBadge tone="neutral">Niet ingesteld</StatusBadge>
  );

  const changed = () => {
    reload();
    reloadOverview();
    reloadConnections();
  };

  const runTest = async () => {
    setTest({ busy: true, message: "Verbinding met eToro testen…" });
    try {
      setTest(await api<{ ok: boolean; message: string }>("/api/settings/etoro-test", { method: "POST" }));
    } catch (e) {
      setTest({ ok: false, message: errMsg(e) });
    }
  };

  const remove = async () => {
    try {
      await api("/api/settings/secrets", { method: "DELETE" });
      setConfirmOpen(false);
      setEditing(false);
      setTest(null);
      toast("eToro-keys verwijderd");
      changed();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  // gevolgen van verwijderen: alleen wat er voor deze installatie echt verandert
  const consequences: string[] = [];
  if (!own.length && etoroAssets) consequences.push(`eToro-koersen stoppen (${etoroAssets === 1 ? "1 asset volgt" : `${etoroAssets} assets volgen`} eToro).`);
  for (const c of shared) consequences.push(`Koppeling ${c.label} gebruikt deze keys en kan dan niet meer synchroniseren.`);
  if (own[0]) consequences.push(`Koersen lopen dan via de eigen keys van koppeling ${own[0].label}.`);

  return (
    <SourceRow
      name="eToro"
      badge={badge}
      meta={
        <>
          {anyKey && (
            <p>
              {keyText(apiKey, "Public API Key")} · {keyText(userKey, "User Key")}
              {changedAt ? ` · gewijzigd ${formatDate(changedAt)}` : ""}
            </p>
          )}
          <p>
            Gebruikt door: eToro-koersen{etoroAssets === null ? "" : ` (${assetsLabel(etoroAssets)})`}
            {shared.map((c) => (
              <Fragment key={c.id}>
                {" · koppeling "}
                <Link href={`/settings/platforms/${c.platformId}`} className="text-accent hover:underline">
                  {c.label}
                </Link>
              </Fragment>
            ))}
          </p>
        </>
      }
      actions={
        <>
          {!editing && (
            <button type="button" className="btn btn-ghost !py-1.5 text-xs" onClick={() => setEditing(true)}>
              {anyKey ? "Wijzigen" : "Invullen"}
            </button>
          )}
          {(globalKeys || own.length > 0) && (
            <button type="button" className="btn btn-ghost !py-1.5 text-xs" disabled={testing} onClick={() => void runTest()}>
              Testen
            </button>
          )}
          {anyKey && (
            <button type="button" className="tap text-xs text-muted hover:text-down" onClick={() => setConfirmOpen(true)}>
              Keys verwijderen
            </button>
          )}
        </>
      }
    >
      {test && (
        <div className="mt-2">
          <InlineResult result={"busy" in test ? test : { ok: test.ok, message: fmt.text(test.message) }} />
        </div>
      )}
      {editing && (
        <EtoroKeyForm
          apiKey={apiKey}
          userKey={userKey}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setTest(null);
            changed();
          }}
        />
      )}
      <Disclosure summary="Waar maak ik eToro-keys aan?" className="mt-1.5">
        <p>
          In het{" "}
          <a href="https://api-portal.etoro.com/" target="_blank" rel="noreferrer" className="text-accent">
            eToro API-portal
          </a>{" "}
          (geverifieerd account, rechten Read). Ze worden versleuteld opgeslagen; alleen de laatste vier tekens blijven zichtbaar.
        </p>
      </Disclosure>
      <ConfirmDialog open={confirmOpen} title="eToro-keys verwijderen?" confirmLabel="Keys verwijderen" tone="danger" onConfirm={remove} onClose={() => setConfirmOpen(false)}>
        {consequences.length ? (
          <ul className="list-disc space-y-1 pl-5">
            {consequences.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">Op dit moment gebruikt niets deze keys.</p>
        )}
      </ConfirmDialog>
    </SourceRow>
  );
}

/** Invoerveld als Field, maar met de headernaam in monospace en "leeg laten = ongewijzigd" als er al een key is. */
function KeyField({ label, header, present, value, onChange, autoFocus, invalid }: { label: string; header: string; present: boolean; value: string; onChange: (v: string) => void; autoFocus?: boolean; invalid: boolean }) {
  return (
    <label className="block min-w-0">
      <span className="label">{label}</span>
      <input
        className={`input ${invalid ? "!border-down" : ""}`}
        type="password"
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        aria-invalid={invalid}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="mt-1 block text-xs text-muted">
        <span className="font-mono">{header}</span>
        {present ? " · leeg laten = ongewijzigd" : ""}
      </span>
    </label>
  );
}

/** Keys vervangen: een aanwezige key mag leeg blijven (dan blijft hij staan), een ontbrekende is verplicht. */
function EtoroKeyForm({ apiKey, userKey, onCancel, onSaved }: { apiKey: MaskedSecret; userKey: MaskedSecret; onCancel: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [a, setA] = useState("");
  const [u, setU] = useState("");
  const [error, setError] = useState<{ field: "api" | "user" | null; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const newApi = a.trim();
    const newUser = u.trim();
    if (!newApi && !apiKey.present) return setError({ field: "api", message: "Vul de Public API Key in." });
    if (!newUser && !userKey.present) return setError({ field: "user", message: "Vul de User Key in." });
    if (!newApi && !newUser) return setError({ field: null, message: "Vul minstens één key in, of kies Annuleren." });
    if (newApi && newApi.length < 8) return setError({ field: "api", message: "Een key is minstens 8 tekens." });
    if (newUser && newUser.length < 8) return setError({ field: "user", message: "Een key is minstens 8 tekens." });
    setError(null);
    setBusy(true);
    try {
      await api("/api/settings/secrets", { method: "POST", json: { etoroApiKey: newApi || undefined, etoroUserKey: newUser || undefined } });
      toast("eToro-keys opgeslagen");
      onSaved();
    } catch (err) {
      setError({ field: null, message: errMsg(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-3 space-y-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <KeyField
          label="Public API Key"
          header="x-api-key"
          present={apiKey.present}
          value={a}
          autoFocus
          invalid={error?.field === "api"}
          onChange={(v) => {
            setA(v);
            if (error) setError(null);
          }}
        />
        <KeyField
          label="User Key"
          header="x-user-key"
          present={userKey.present}
          value={u}
          invalid={error?.field === "user"}
          onChange={(v) => {
            setU(v);
            if (error) setError(null);
          }}
        />
      </div>
      {error && (
        <p className="text-xs text-down" aria-live="polite">
          {error.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Opslaan…" : "Opslaan"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          Annuleren
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Planning

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const validTime = (v: string) => (TIME_RE.test(v) ? null : "Gebruik een tijd als 23:45");

function PlanningCard({ data }: { data: SettingsData }) {
  const { save, status } = useSettings();
  const router = useRouter();
  const s = data.settings;
  // een zone die deze browser niet kent, zou de berekening van "Volgende" laten crashen
  const tz = isValidTimeZone(s.timezone) ? s.timezone : getDisplayTimeZone();
  const now = new Date();
  const nextDaily = (hhmm: string) => {
    const next = nextRun(dailyCron(hhmm), now, tz);
    return next ? <span className="text-xs text-muted">Volgende: {formatNextRun(next, now, tz)}</span> : null;
  };

  const zones = useMemo(() => {
    const list = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["Europe/Amsterdam", "UTC"];
    return list.includes(s.timezone) ? list : [s.timezone, ...list];
  }, [s.timezone]);

  const changeZone = async (zone: string) => {
    const err = await save({ timezone: zone }, "timezone");
    if (err) return;
    setDisplayTimeZone(zone);
    router.refresh(); // de layout geeft de nieuwe zone dan ook zelf door
  };

  return (
    <Card title="Planning" id="planning" description={`Wanneer de app automatisch bijwerkt. Tijden in ${tz}.`}>
      <SettingRows>
        <SettingRow label="Koersen" description="eToro, Kraken, Yahoo en wisselkoersen; ook het moment waarop koersalerts worden gecontroleerd.">
          <IntervalSelect value={s.priceRefreshMinutes} onChange={(m) => save({ priceRefreshMinutes: m }, "priceRefreshMinutes")} label="Koersen verversen" timeZone={tz} />
        </SettingRow>
        <SettingRow label="Bitcoin-wallets" description="Saldo en transacties van wallet-koppelingen. Kraken en eToro synchroniseren in de dagelijkse ronde.">
          <IntervalSelect value={s.walletSyncMinutes} onChange={(m) => save({ walletSyncMinutes: m }, "walletSyncMinutes")} label="Wallets synchroniseren" timeZone={tz} />
        </SettingRow>
        <SettingRow label="Dagelijkse ronde" description="Synchroniseert alle koppelingen (ook wallets), ververst koersen en vult de koershistorie aan.">
          <CommitInput type="time" label="Tijd van de dagelijkse ronde" value={s.refreshTime} validate={validTime} onCommit={(v) => save({ refreshTime: v }, "refreshTime")} />
          {nextDaily(s.refreshTime)}
        </SettingRow>
        <SettingRow label="Dagsnapshot" description="Legt elke dag de waarde per portfolio vast voor de grafieken.">
          <CommitInput type="time" label="Tijd van de dagsnapshot" value={s.snapshotTime} validate={validTime} onCommit={(v) => save({ snapshotTime: v }, "snapshotTime")} />
          {nextDaily(s.snapshotTime)}
        </SettingRow>
      </SettingRows>
      <div className="mt-1 border-t border-border pt-2">
        <Disclosure summary="Geavanceerd">
          {/* de Disclosure dempt zijn tekst; de rij zelf hoort er gewoon uit te zien */}
          <div className="text-text">
            <SettingRow label="Tijdzone" description="Voor de planning en voor alle getoonde tijden in de app.">
              <select className="input" aria-label="Tijdzone" value={s.timezone} onChange={(e) => void changeZone(e.target.value)}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
              <SaveState status={status.timezone ?? null} />
            </SettingRow>
          </div>
          <p>
            <b>Hoe wordt afgerond?</b> De vaste keuzes lopen gelijk met de klok: elk uur draait op :00, elke 15 min op :00, :15, :30 en :45. Kies je bij Aangepast… een andere waarde, dan
            zie je vooraf wat de planning ervan maakt (90 minuten wordt bijvoorbeeld elke 2 uur).
          </p>
        </Disclosure>
      </div>
      <p className="mt-2 text-xs text-muted">Handmatig verversen doe je met de verversknop in de zijbalk (mobiel: bovenbalk).</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Recente taken

interface RunGroup {
  id: string;
  runs: ActivityRun[];
  newest: ActivityRun;
  oldest: ActivityRun;
  problem: boolean;
  failed: ActivityRun["failed"];
  warnings: string[];
}

const isProblem = (r: ActivityRun) => r.ok === false || r.failed.length > 0 || r.warnings.length > 0;
const expandable = (g: RunGroup) => g.failed.length > 0 || g.warnings.length > 0 || g.runs.length > 1;

/**
 * Dezelfde taak met dezelfde uitkomst wordt één regel ("9× sinds …"), ook als er andere taken tussen zaten: tien keer
 * "2 mislukt" onder elkaar kweekt alarmmoeheid. Mislukte assets en waarschuwingen van de hele groep komen in het detail.
 */
function groupRuns(runs: ActivityRun[]): RunGroup[] {
  const byId = new Map<string, ActivityRun[]>();
  for (const r of runs) {
    const id = JSON.stringify([r.key, r.ok, r.message]);
    const list = byId.get(id);
    if (list) list.push(r);
    else byId.set(id, [r]);
  }
  return [...byId.entries()]
    .map(([id, list]) => {
      const sorted = [...list].sort((a, b) => newestFirst(a.startedAt, b.startedAt));
      // per asset de nieuwste fout; waarschuwingen ontdubbeld
      const failed = new Map<string, ActivityRun["failed"][number]>();
      const warnings = new Set<string>();
      for (const r of sorted) {
        for (const f of r.failed) if (!failed.has(f.asset)) failed.set(f.asset, f);
        for (const w of r.warnings) warnings.add(w);
      }
      return { id, runs: sorted, newest: sorted[0], oldest: sorted[sorted.length - 1], problem: sorted.some(isProblem), failed: [...failed.values()], warnings: [...warnings] };
    })
    .sort((a, b) => newestFirst(a.newest.startedAt, b.newest.startedAt));
}

function RunIcon({ group }: { group: RunGroup }) {
  const cls = "mt-0.5 shrink-0";
  const { ok, kind } = group.newest;
  if (ok === null) return <Clock size={14} className={`${cls} text-muted`} role="img" aria-label="Bezig" />;
  if (ok && !group.problem) return <CircleCheck size={14} className={`${cls} text-up`} role="img" aria-label="Gelukt" />;
  // gelukt met waarschuwingen, of een koersronde waarin een deel mislukte: let op, geen fout
  if (ok || kind === "job") return <TriangleAlert size={14} className={`${cls} text-warn`} role="img" aria-label="Let op" />;
  return <CircleX size={14} className={`${cls} text-down`} role="img" aria-label="Mislukt" />;
}

function TaskGroup({ group, defaultOpen }: { group: RunGroup; defaultOpen: boolean }) {
  const fmt = useFormat();
  const { newest, oldest, runs, failed, warnings } = group;
  const head = (
    <>
      <RunIcon group={group} />
      <span className="min-w-0 flex-1 sm:flex sm:items-start sm:justify-between sm:gap-3">
        <span className="block min-w-0 break-words">
          {newest.label}
          <span className="text-muted">
            {newest.message ? ` · ${fmt.text(newest.message)}` : ""}
            {runs.length > 1 ? ` · ${runs.length}× sinds ${formatDate(oldest.startedAt, true)}` : ""}
          </span>
        </span>
        <time dateTime={newest.startedAt} className="block whitespace-nowrap text-xs text-muted sm:mt-0.5 sm:shrink-0">
          {formatDate(newest.startedAt, true)}
        </time>
      </span>
    </>
  );

  if (!expandable(group))
    return (
      <li className="flex items-start gap-2 py-2">
        {head}
        <span className="w-3.5 shrink-0" aria-hidden />
      </li>
    );

  return (
    <li>
      <details className="group/run" open={defaultOpen || undefined}>
        <summary className="flex cursor-pointer list-none items-start gap-2 py-2 [&::-webkit-details-marker]:hidden">
          {head}
          <ChevronRight size={14} className="mt-0.5 shrink-0 text-muted transition-transform group-open/run:rotate-90 motion-reduce:transition-none" aria-hidden />
        </summary>
        <div className="space-y-2 pb-2 pl-[22px] pr-[22px] text-xs">
          {failed.length > 0 && (
            <div>
              <p className="font-semibold text-muted">Mislukt</p>
              <ul className="mt-0.5 space-y-0.5">
                {failed.map((f) => (
                  <li key={f.asset} className="break-words">
                    {f.assetId ? (
                      <Link href={`/assets/${f.assetId}`} className="font-semibold text-accent hover:underline">
                        {f.asset}
                      </Link>
                    ) : (
                      <span className="font-semibold">{f.asset}</span>
                    )}
                    <span className="text-muted"> — {fmt.text(f.error)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {warnings.length > 0 && (
            <div>
              <p className="font-semibold text-muted">Waarschuwingen</p>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-muted">
                {warnings.slice(0, 10).map((w) => (
                  <li key={w} className="break-words">
                    {fmt.text(w)}
                  </li>
                ))}
              </ul>
              {warnings.length > 10 && <p className="mt-0.5 text-muted">en nog {warnings.length - 10}</p>}
            </div>
          )}
          {runs.length > 1 && (
            <div>
              <p className="font-semibold text-muted">Rondes</p>
              <ul className="mt-0.5 space-y-0.5 text-muted">
                {runs.map((r) => (
                  <li key={`${r.kind}:${r.id}`} className="break-words">
                    <span className="tnum whitespace-nowrap">{formatDate(r.startedAt, true)}</span>
                    {r.message ? ` · ${fmt.text(r.message)}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>
    </li>
  );
}

const PAGE = 50;
const MAX = 200;

function TasksCard() {
  const [filter, setFilter] = useState<"all" | "problems">("all");
  const [limit, setLimit] = useState(PAGE);
  const { data: runs, error, loading } = useApi<ActivityRun[]>(`/api/activity?limit=${limit}`);
  const groups = useMemo(() => (runs ? groupRuns(filter === "problems" ? runs.filter(isProblem) : runs) : []), [runs, filter]);
  const openId = groups.find((g) => g.problem && expandable(g))?.id;
  const canMore = !!runs && limit < MAX && runs.length >= limit;
  // na "Meer tonen" staan de eerste 50 er nog tot de rest binnen is
  const loadingMore = limit === MAX && loading && (runs?.length ?? 0) <= PAGE;

  return (
    <Card
      title="Recente taken"
      id="taken"
      action={
        <Segmented
          value={filter}
          onChange={setFilter}
          label="Welke taken"
          full={false}
          options={[
            { value: "all", label: "Alles" },
            { value: "problems", label: "Problemen" },
          ]}
        />
      }
    >
      {!runs ? (
        error ? <p className="text-sm text-down">{error}</p> : <Skeleton className="h-40" />
      ) : !groups.length ? (
        <p className="text-sm text-muted">{filter === "problems" && runs.length ? "Geen problemen in de laatste taken." : "Nog geen taken uitgevoerd."}</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {groups.map((g) => (
            <TaskGroup key={g.id} group={g} defaultOpen={g.id === openId} />
          ))}
        </ul>
      )}
      {(canMore || loadingMore) && (
        <button type="button" className="btn btn-ghost mt-3 !py-1.5 text-xs" disabled={loadingMore} onClick={() => setLimit(MAX)}>
          {loadingMore ? "Laden…" : "Meer tonen"}
        </button>
      )}
    </Card>
  );
}
