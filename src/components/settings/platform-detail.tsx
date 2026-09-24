"use client";

/**
 * Instellingen → Platforms en koppelingen → één platform: hoe de gegevens binnenkomen (per koppeling de laatste sync,
 * een fout met de herstelactie erbij, waarschuwingen, afstemmingsverschillen en de geschiedenis), de gegevens van de
 * koppeling, het platform zelf en de gevarenzone. Zonder koppeling is het een handmatig bijgehouden platform.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Pencil, Plus, RefreshCw, Upload } from "lucide-react";
import { api, useApi, useApp } from "../app-state";
import { ConnectionWizard, EditConnectionModal, SCRIPT_LABELS, type ConnectionRow } from "../connections";
import { Card, Empty, Skeleton, timeAgo, useFormat } from "../ui";
import { formatDate, PLATFORM_TYPE_LABELS } from "@/lib/format";
import type { Provider } from "@/lib/db/schema";
import type { PlatformRow } from "@/lib/platforms";
import { SettingsPageHeader, SettingsStack, useScrollToHash, useSettings } from "./context";
import { Callout, CommitInput, ConfirmDialog, DangerZone, Disclosure, FactRow, SaveState, SettingRow, SettingRows, StatusBadge, type SaveStatus, type Tone } from "./ui";

interface SyncReport {
  ok: boolean;
  created: number;
  skipped: number;
  warnings: string[];
  message: string;
  reconciliation: ConnectionRow["reconciliation"];
}

interface SyncRun {
  id: number;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  message: string | null;
  warnings: string[];
}

type Diff = NonNullable<ConnectionRow["reconciliation"]>[number];
type WalletAccount = ConnectionRow["accounts"][number];
type WizardStart = { provider: Provider; platformId: number; label?: string };

const BACK = { href: "/settings/platforms", label: "Platforms en koppelingen" };
const NODE_HREF = "/settings/platforms#bitcoin-node";
const TRIGGER_LABELS: Record<string, string> = { manual: "handmatig", scheduled: "dagelijkse ronde", interval: "interval", initial: "eerste sync" };
const SMALL_GHOST = "btn btn-ghost inline-flex items-center gap-1 !py-1.5 text-xs";
const SMALL_DANGER = "btn btn-danger self-start !py-1.5 text-xs sm:self-end";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const nonZero = (v?: string | null) => !!v && Number(v) !== 0;
const isWallet = (c: ConnectionRow) => c.provider === "bitcoin";
/** eToro met de keys van de koersen: die blijven staan als de koppeling verdwijnt. */
const sharedKeys = (c: ConnectionRow) => c.provider === "etoro" && c.keys.shared;
const providerTag = (c: ConnectionRow) => `${c.providerLabel}${c.accountType === "demo" ? " demo" : ""}`;

/** Het aantal waarschuwingen in de melding van een run ("…, 3 waarschuwing(en)"), ook van runs zonder bewaarde lijst. */
function countInMessage(message: string | null): number {
  const m = (message ?? "").match(/(\d+) waarschuwing/);
  return m ? Number(m[1]) : 0;
}

const runWarningCount = (run: { warnings: string[]; message: string | null }) => Math.max(run.warnings.length, countInMessage(run.message));

/** Dezelfde regels als de platformlijst: de slechtste koppeling telt, een lopende sync vanaf deze pagina gaat voor. */
function platformStatus(conns: ConnectionRow[], busy: boolean): { tone: Tone; label: string } {
  if (!conns.length) return { tone: "neutral", label: "Handmatig" };
  if (busy) return { tone: "neutral", label: "Bezig" };
  if (conns.some((c) => c.status === "error")) return { tone: "down", label: "Fout" };
  if (conns.some((c) => c.status === "syncing")) return { tone: "neutral", label: "Bezig" };
  if (conns.some((c) => (c.reconciliation?.length ?? 0) > 0 || (c.lastRun?.warnings?.length ?? 0) > 0 || c.nodeSource === "fallback")) return { tone: "warn", label: "Let op" };
  if (conns.some((c) => c.status === "never")) return { tone: "neutral", label: "Nog niet gesynct" };
  return { tone: "ok", label: "In orde" };
}

/**
 * Waarschuwingen van de laatste sync: het (volledige) rapport van een sync op deze pagina zolang de laatste run die sync
 * is, anders de bewaarde lijst van de run. Het aantal komt desnoods uit de melding (runs van vóór de bewaarde lijst).
 */
function lastWarnings(c: ConnectionRow, report: SyncReport | undefined): { list: string[]; count: number } {
  const run = c.lastRun;
  if (report && (!run || run.message === report.message)) return { list: report.warnings, count: report.warnings.length };
  if (!run) return { list: [], count: 0 };
  return { list: run.warnings, count: runWarningCount(run) };
}

/** Koppelknop op een handmatig platform: Kraken en eToro alleen op het platform met precies die naam (daar boekt de koppeling). */
function wizardStartFor(p: PlatformRow): WizardStart | null {
  if (p.name === "Kraken") return { provider: "kraken", platformId: p.id };
  if (p.name === "eToro") return { provider: "etoro", platformId: p.id };
  if (p.type === "wallet" || p.type === "other") return { provider: "bitcoin", platformId: p.id, label: p.name };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------

export function PlatformDetail({ id }: { id: number }) {
  const router = useRouter();
  const { bump, toast } = useApp();
  const fmt = useFormat();
  const { reloadOverview } = useSettings();
  const { data: platforms, error: platformsError, reload: reloadPlatforms } = useApi<PlatformRow[]>("/api/platforms");
  const { data: connections, error: connectionsError, reload: reloadConnections } = useApi<ConnectionRow[]>("/api/connections");
  const [syncing, setSyncing] = useState<number[]>([]);
  const [reports, setReports] = useState<Record<number, SyncReport>>({});
  const [editing, setEditing] = useState<ConnectionRow | null>(null);
  const [wizard, setWizard] = useState<WizardStart | null>(null);
  const [correction, setCorrection] = useState<{ conn: ConnectionRow; diff: Diff } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const syncLock = useRef(false);

  const platform = platforms?.find((p) => p.id === id) ?? null;
  const conns = (connections ?? []).filter((c) => c.platformId === id);
  useScrollToHash(!!platform && !!connections);

  const refresh = () => {
    reloadPlatforms();
    reloadConnections();
    bump();
    reloadOverview();
  };

  const sync = async (list: ConnectionRow[]) => {
    // na elkaar en één ronde tegelijk: twee syncs van dezelfde koppeling zouden elkaars boekingen dubbel zien
    if (syncLock.current || !list.length) return;
    syncLock.current = true;
    setSyncing(list.map((c) => c.id));
    for (const c of list) {
      const who = conns.length > 1 ? ` (${c.label})` : "";
      try {
        const r = await api<SyncReport>(`/api/connections/${c.id}/sync`, { method: "POST" });
        setReports((m) => ({ ...m, [c.id]: r }));
        toast(`${r.ok ? "Sync klaar" : "Sync mislukt"}${who}: ${fmt.text(r.message)}`, r.ok ? "ok" : "error");
      } catch (e) {
        toast(`Sync mislukt${who}: ${fmt.text(errMsg(e))}`, "error");
      }
      setSyncing((s) => s.filter((x) => x !== c.id));
    }
    syncLock.current = false;
    refresh();
  };

  const bookCorrection = async () => {
    if (!correction) return;
    const { conn, diff } = correction;
    try {
      await api(`/api/connections/${conn.id}/correction`, { method: "POST", json: { symbol: diff.symbol } });
      toast(`Correctie voor ${diff.symbol} geboekt`);
      refresh();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setCorrection(null);
  };

  const loadError = platformsError ?? connectionsError;
  if (leaving || (!loadError && (!platforms || !connections))) return <DetailSkeleton />;
  if (!platforms || !connections || !platform)
    return (
      <div className="space-y-4">
        <SettingsPageHeader category="platforms" back={BACK} title="Platform" />
        <Empty title={platforms && connections ? "Platform niet gevonden" : "Laden mislukt"}>
          <p>{platforms && connections ? "Het is misschien verwijderd." : loadError}</p>
          <Link href={BACK.href} className="mt-2 inline-block font-semibold text-accent">
            Terug naar {BACK.label}
          </Link>
        </Empty>
      </div>
    );

  const multi = conns.length > 1;
  const busy = syncing.length > 0;
  const status = platformStatus(conns, busy);
  // eToro real + demo op één platform zijn twee badges; twee wallets één
  const tags = [...new Set(conns.map(providerTag))];
  const start = conns.length ? null : wizardStartFor(platform);

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        category="platforms"
        back={BACK}
        title={
          <>
            <span className="min-w-0 break-words">{platform.name}</span>
            <StatusBadge tone="neutral">{PLATFORM_TYPE_LABELS[platform.type] ?? platform.type}</StatusBadge>
            {tags.map((t) => (
              <StatusBadge key={t} tone="neutral">
                {t}
              </StatusBadge>
            ))}
            <StatusBadge tone={status.tone} dot>
              {status.label}
            </StatusBadge>
          </>
        }
        right={conns.length > 0 && <SyncButton busy={busy} spinning={busy} ariaLabel={multi ? "Alle koppelingen van dit platform synchroniseren" : undefined} onClick={() => void sync(conns)} />}
      />
      <SettingsStack>
        {conns.length ? (
          <Card title="Synchronisatie" id="synchronisatie">
            <div className="divide-y divide-border">
              {conns.map((c) => (
                <SyncBlock
                  key={c.id}
                  c={c}
                  multi={multi}
                  report={reports[c.id]}
                  busy={busy}
                  spinning={syncing.includes(c.id)}
                  onSync={() => void sync([c])}
                  onEditKeys={() => setEditing(c)}
                  onCorrect={(diff) => setCorrection({ conn: c, diff })}
                />
              ))}
            </div>
          </Card>
        ) : (
          <ManualCard platform={platform} onConnect={start ? () => setWizard(start) : null} />
        )}
        {conns.map((c) => (
          <ConnectionCard key={c.id} c={c} multi={multi} onEdit={() => setEditing(c)} />
        ))}
        <PlatformCard platform={platform} conns={conns} onChanged={refresh} />
        <PlatformDanger
          platform={platform}
          conns={conns}
          onChanged={refresh}
          onDeleted={() => {
            // eerst de skeleton: anders flitst "niet gevonden" voordat de lijst er is
            setLeaving(true);
            bump();
            reloadOverview();
            router.push(BACK.href);
          }}
        />
      </SettingsStack>

      <ConfirmDialog open={!!correction} title={correction ? `Correctie boeken voor ${correction.diff.symbol}?` : ""} confirmLabel="Correctie boeken" onConfirm={bookCorrection} onClose={() => setCorrection(null)}>
        {correction && <CorrectionEffects diff={correction.diff} />}
      </ConfirmDialog>
      {editing && <EditConnectionModal conn={editing} onClose={() => setEditing(null)} onDone={refresh} />}
      {/* buiten de kaarten: na de eerste sync is dit een gekoppeld platform, de wizard toont dan nog zijn rapport */}
      {wizard && <ConnectionWizard open initial={wizard} onClose={() => setWizard(null)} onDone={refresh} />}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <SettingsPageHeader
        category="platforms"
        back={BACK}
        title={
          <>
            <span className="skeleton inline-block h-7 w-40 max-w-full" aria-hidden />
            <span className="sr-only">Laden…</span>
          </>
        }
      />
      <SettingsStack>
        <Skeleton className="h-48" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </SettingsStack>
    </div>
  );
}

function SyncButton({ busy, spinning, onClick, ariaLabel }: { busy: boolean; spinning: boolean; onClick: () => void; ariaLabel?: string }) {
  return (
    <button type="button" className={SMALL_GHOST} disabled={busy} aria-busy={spinning} aria-label={ariaLabel} title={ariaLabel} onClick={onClick}>
      <RefreshCw size={13} aria-hidden className={spinning ? "animate-spin motion-reduce:animate-none" : ""} /> Sync nu
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Synchronisatie

function SyncBlock({
  c,
  multi,
  report,
  busy,
  spinning,
  onSync,
  onEditKeys,
  onCorrect,
}: {
  c: ConnectionRow;
  multi: boolean;
  report: SyncReport | undefined;
  busy: boolean;
  spinning: boolean;
  onSync: () => void;
  onEditKeys: () => void;
  onCorrect: (d: Diff) => void;
}) {
  const fmt = useFormat();
  const run = c.lastRun;
  const warnings = lastWarnings(c, report);
  const recon = c.reconciliation ?? [];
  const failed = c.status === "error";

  return (
    <div className="space-y-3 py-4 first:pt-0 last:pb-0">
      {multi && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="min-w-0 break-words text-sm font-semibold">
            {c.label} · {providerTag(c)}
          </h3>
          <SyncButton busy={busy} spinning={spinning} onClick={onSync} />
        </div>
      )}
      <SettingRows>
        <FactRow label="Laatste sync">{c.lastSyncAt ? `${formatDate(c.lastSyncAt, true)} (${timeAgo(c.lastSyncAt)})` : <span className="text-muted">Nog niet gesynct</span>}</FactRow>
        {run && (
          <FactRow label="Laatste run">
            {run.ok == null ? (
              <span className="text-muted">Loopt nog…</span>
            ) : !run.ok && failed ? (
              // de melding staat hieronder voluit in de foutmelding
              <span className="text-down">Mislukt</span>
            ) : (
              <span className={warnings.count ? "text-warn" : run.ok ? "" : "text-down"}>{fmt.text(run.message || (run.ok ? "Gelukt" : "Mislukt"))}</span>
            )}
          </FactRow>
        )}
        {isWallet(c) && <WalletBalance c={c} />}
      </SettingRows>
      {failed && (
        <Callout tone="down">
          <p className="whitespace-pre-line break-words">{fmt.text(c.lastError || "De laatste sync is mislukt.")}</p>
          <ErrorFix c={c} onEditKeys={onEditKeys} />
        </Callout>
      )}
      {warnings.count > 0 && <WarningsCallout list={warnings.list} count={warnings.count} />}
      {recon.length > 0 && <ReconciliationCallout diffs={recon} onCorrect={onCorrect} />}
      {isWallet(c) && c.accounts.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {c.accounts.map((a) => (
            <AccountTile key={a.id} a={a} />
          ))}
        </div>
      )}
      <SyncHistory connectionId={c.id} />
    </div>
  );
}

/** Wat de gebruiker aan een fout kan doen: de node instellen, of de keys (eToro met gedeelde keys: bij de koersen). */
function ErrorFix({ c, onEditKeys }: { c: ConnectionRow; onEditKeys: () => void }) {
  const err = c.lastError ?? "";
  const cls = "tap mt-1 inline-flex font-semibold text-accent";
  if (/bitcoin-node/i.test(err))
    return (
      <Link href={NODE_HREF} className={cls}>
        Bitcoin-node instellen
      </Link>
    );
  if (!/keys|api-key|\b40[13]\b/i.test(err)) return null;
  if (sharedKeys(c))
    return (
      <Link href="/settings/koersen#koersbronnen" className={cls}>
        eToro-keys invullen
      </Link>
    );
  return (
    <button type="button" className={cls} onClick={onEditKeys}>
      Keys bewerken
    </button>
  );
}

function WalletBalance({ c }: { c: ConnectionRow }) {
  const fmt = useFormat();
  const btc = c.balances.find((b) => b.currency === "BTC");
  const hold = btc?.hold;
  return (
    <FactRow label="Saldo">
      {btc ? (
        <span className="tnum">
          {fmt.qty(btc.amount)} BTC{nonZero(hold) ? " bevestigd" : ""}
          {nonZero(hold) && (
            <span className="text-warn">
              {" "}
              · in afwachting {!fmt.hidden && Number(hold) > 0 ? "+" : ""}
              {fmt.qty(hold!)} BTC
            </span>
          )}
        </span>
      ) : (
        <span className="text-muted">Nog geen saldo</span>
      )}
      {c.nodeSource === "fallback" && (
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <StatusBadge tone="warn">via publieke node</StatusBadge>
          <Link href={NODE_HREF} className="text-xs font-semibold text-accent">
            Eigen node instellen
          </Link>
        </span>
      )}
    </FactRow>
  );
}

function WarningsCallout({ list, count }: { list: string[]; count: number }) {
  const fmt = useFormat();
  const item = (w: string, i: number) => (
    <li key={i} className="break-words">
      {fmt.text(w)}
    </li>
  );
  return (
    <Callout tone="warn">
      <p className="font-semibold">{plural(count, "waarschuwing", "waarschuwingen")} bij de laatste sync</p>
      {list.length ? (
        <>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">{list.slice(0, 5).map(item)}</ul>
          {list.length > 5 && (
            <Disclosure summary={`Nog ${list.length - 5} tonen`}>
              <ul className="list-disc space-y-0.5 pl-4 text-text">{list.slice(5).map((w, i) => item(w, i + 5))}</ul>
            </Disclosure>
          )}
          {count > list.length && <p className="mt-1 text-muted">Alleen de eerste {list.length} zijn bewaard.</p>}
        </>
      ) : (
        <p className="mt-0.5">De details van deze waarschuwingen zijn niet bewaard (van vóór deze versie). Sync nu om ze opnieuw te zien.</p>
      )}
    </Callout>
  );
}

function ReconciliationCallout({ diffs, onCorrect }: { diffs: Diff[]; onCorrect: (d: Diff) => void }) {
  const fmt = useFormat();
  return (
    <Callout tone="warn">
      <p className="font-semibold">{diffs.length === 1 ? "Afstemmingsverschil" : `${diffs.length} afstemmingsverschillen`}</p>
      <ul className="mt-1 space-y-1.5">
        {diffs.map((d) => (
          <li key={d.symbol}>
            <div className="break-words tnum">
              <b>{d.symbol}</b>: app {fmt.qty(d.computed)} · platform {fmt.qty(d.reported)} · verschil {fmt.qty(d.diff)}
            </div>
            <div className="flex flex-wrap gap-x-4">
              {d.assetId != null && (
                <Link href={`/assets/${d.assetId}`} className="tap font-semibold text-accent">
                  Bekijk asset
                </Link>
              )}
              <button type="button" className="tap font-semibold text-accent" onClick={() => onCorrect(d)}>
                Correctie boeken…
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/** Wat een correctieboeking doet (zie bookCorrection in de sync): richting, datum, kostprijs en dat hij los te verwijderen is. */
function CorrectionEffects({ diff }: { diff: Diff }) {
  const fmt = useFormat();
  const qty = `${fmt.qty(diff.diff.replace(/^-/, ""))} ${diff.symbol}`;
  return (
    <ul className="list-disc space-y-1 pl-5">
      {Number(diff.diff) > 0 ? (
        <>
          <li>Er komt een overboeking in van {qty}, met de datum van vandaag.</li>
          <li>Kostprijs: de huidige koers (0 als er geen koers is).</li>
        </>
      ) : (
        <li>Er gaat een overboeking uit van {qty}, met de datum van vandaag, zonder winst of verlies.</li>
      )}
      <li>Het wordt een handmatige transactie met een notitie; je kunt hem later verwijderen bij Transacties.</li>
    </ul>
  );
}

function AccountTile({ a }: { a: WalletAccount }) {
  const fmt = useFormat();
  return (
    <div className="min-w-0 rounded-xl bg-bg-elev p-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 break-words font-semibold">{a.label}</span>
        {!a.enabled && <StatusBadge tone="neutral">uit</StatusBadge>}
      </div>
      <div className="text-xs text-muted">{SCRIPT_LABELS[a.scriptType]}</div>
      <div className="mt-1.5 tnum">
        {fmt.qty(a.balanceConfirmed)} BTC
        {nonZero(a.balanceUnconfirmed) && (
          <span className="text-warn">
            {" "}
            ({!fmt.hidden && Number(a.balanceUnconfirmed) > 0 ? "+" : ""}
            {fmt.qty(a.balanceUnconfirmed)} BTC onbevestigd)
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-muted">
        {plural(a.txCount, "transactie", "transacties")} · {a.receiveUsed} ontvangst- en {a.changeUsed} wisseladressen gebruikt
      </div>
      {a.lastScanAt && <div className="text-xs text-muted">gescand {formatDate(a.lastScanAt, true)}</div>}
    </div>
  );
}

function SyncHistory({ connectionId }: { connectionId: number }) {
  const fmt = useFormat();
  const { data: runs } = useApi<SyncRun[]>(`/api/connections/${connectionId}/runs`);
  if (!runs?.length) return null;
  return (
    <Disclosure summary={`Syncgeschiedenis (${runs.length})`} defaultOpen={runWarningCount(runs[0]) > 0}>
      <ul className="space-y-1">
        {runs.map((r) => {
          const w = runWarningCount(r);
          // het aantal waarschuwingen staat er apart (gekleurd) achter, dus niet ook nog in de melding
          const message = (r.message ?? "").replace(/,?\s*\d+ waarschuwing\(en\)/, "");
          return (
            <li key={r.id} className="break-words">
              <span className="tnum text-text">{formatDate(r.startedAt, true)}</span> · {TRIGGER_LABELS[r.trigger] ?? r.trigger} ·{" "}
              {r.ok == null ? "loopt" : <span className={r.ok ? "text-up" : "text-down"}>{r.ok ? "ok" : "fout"}</span>}
              {message && ` · ${fmt.text(message)}`}
              {w > 0 && <span className="text-warn"> · {plural(w, "waarschuwing", "waarschuwingen")}</span>}
            </li>
          );
        })}
      </ul>
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Koppeling, handmatig, platform

function ConnectionCard({ c, multi, onEdit }: { c: ConnectionRow; multi: boolean; onEdit: () => void }) {
  let keys: React.ReactNode;
  if (isWallet(c)) keys = plural(c.accounts.length, "account", "accounts");
  else if (sharedKeys(c))
    keys = c.keys.present ? (
      `Gedeelde koers-keys ••••${c.keys.last4}`
    ) : (
      <>
        Gedeelde koers-keys, nog niet ingevuld ·{" "}
        <Link href="/settings/koersen#koersbronnen" className="font-semibold text-accent">
          invullen
        </Link>
      </>
    );
  else if (!c.keys.present) keys = <span className="text-warn">Geen keys</span>;
  else keys = c.provider === "etoro" ? `Eigen keys ••••${c.keys.last4}` : `••••${c.keys.last4}`;

  return (
    <Card
      title={multi ? `Koppeling · ${c.label}` : "Koppeling"}
      action={
        <button type="button" className={SMALL_GHOST} onClick={onEdit}>
          <Pencil size={13} aria-hidden /> Bewerken
        </button>
      }
    >
      <SettingRows>
        <FactRow label="Naam in meldingen">{c.label}</FactRow>
        <FactRow label="Portfolio">{c.portfolioName}</FactRow>
        {c.provider === "etoro" && <FactRow label="Omgeving">{c.accountType === "demo" ? "Demo" : "Real"}</FactRow>}
        <FactRow label="Keys">{keys}</FactRow>
        {isWallet(c) && <FactRow label="Kostprijs van ontvangsten">{c.receiptCost === "none" ? "Geen (telt niet als inleg)" : "Dagkoers op het moment van ontvangst"}</FactRow>}
        <FactRow label="Aangemaakt">
          {formatDate(c.createdAt)} · bestaande transacties {c.mode === "replace" ? "vervangen" : "naast elkaar"}
        </FactRow>
      </SettingRows>
    </Card>
  );
}

function ManualCard({ platform, onConnect }: { platform: PlatformRow; onConnect: (() => void) | null }) {
  return (
    <Card title="Handmatig bijgehouden">
      <p className="text-sm text-muted">{plural(platform.txCount, "transactie", "transacties")}; je houdt ze zelf bij of importeert ze.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link href="/import" className="btn btn-ghost inline-flex items-center gap-1.5">
          <Upload size={14} aria-hidden /> Importeren
        </Link>
        {onConnect && (
          <button type="button" className="btn inline-flex items-center gap-1.5" onClick={onConnect}>
            <Plus size={14} aria-hidden /> Koppeling toevoegen
          </button>
        )}
      </div>
    </Card>
  );
}

function PlatformCard({ platform, conns, onChanged }: { platform: PlatformRow; conns: ConnectionRow[]; onChanged: () => void }) {
  // gekozen type tot de herladen lijst het bevestigt (anders springt de keuzelijst even terug)
  const [typeDraft, setTypeDraft] = useState<{ from: string; value: string } | null>(null);
  const [typeStatus, setTypeStatus] = useState<SaveStatus>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const typeValue = typeDraft && typeDraft.from === platform.type ? typeDraft.value : platform.type;

  const brand = platform.name === "Kraken" || conns.some((c) => c.provider === "kraken") ? "Kraken" : platform.name === "eToro" || conns.some((c) => c.provider === "etoro") ? "eToro" : null;
  const wallets = conns.filter(isWallet);
  // een wallet die zo heet als zijn platform, blijft zo heten (de naam staat in de meldingen)
  const follower = wallets.length === 1 && wallets[0].label === platform.name ? wallets[0] : null;
  const nameNote =
    [brand && `Nieuwe ${brand}-koppelingen komen op het platform met de naam ${brand}. Hernoem je dit platform, dan krijgt een volgende koppeling een nieuw platform.`, follower && "De naam van de koppeling verandert mee."].filter(Boolean).join(" ") ||
    undefined;

  const rename = async (name: string): Promise<string | null> => {
    try {
      await api(`/api/platforms/${platform.id}`, { method: "PATCH", json: { name } });
    } catch (e) {
      return errMsg(e);
    }
    let err: string | null = null;
    if (follower) {
      try {
        await api(`/api/connections/${follower.id}`, { method: "PATCH", json: { label: name } });
      } catch (e) {
        err = `Platform hernoemd, maar de koppeling niet: ${errMsg(e)}`;
      }
    }
    onChanged();
    return err;
  };

  const changeType = async (type: string) => {
    setTypeDraft({ from: platform.type, value: type });
    setTypeStatus({ kind: "saving" });
    if (timer.current) clearTimeout(timer.current);
    try {
      await api(`/api/platforms/${platform.id}`, { method: "PATCH", json: { type } });
      setTypeStatus({ kind: "saved" });
      timer.current = setTimeout(() => setTypeStatus(null), 2000);
      onChanged();
    } catch (e) {
      setTypeDraft(null);
      setTypeStatus({ kind: "error", message: errMsg(e) });
    }
  };

  return (
    <Card title="Platform">
      <SettingRows>
        <SettingRow label="Naam" description={nameNote}>
          <CommitInput label="Naam van het platform" value={platform.name} validate={(v) => (!v ? "Vul een naam in" : v.length > 60 ? "Hooguit 60 tekens" : null)} onCommit={rename} />
        </SettingRow>
        <SettingRow label="Type">
          <select className="input" aria-label="Type van het platform" value={typeValue} onChange={(e) => void changeType(e.target.value)}>
            {Object.entries(PLATFORM_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <SaveState status={typeStatus} />
        </SettingRow>
        <SettingRow label="Transacties">
          <span className="text-sm">
            {platform.txCount} ·{" "}
            <Link href={`/transactions?platform=${platform.id}`} className="font-semibold text-accent">
              Bekijken
            </Link>
          </span>
        </SettingRow>
      </SettingRows>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Gevarenzone

function Choice({ name, checked, onSelect, title, children }: { name: string; checked: boolean; onSelect: () => void; title: string; children: React.ReactNode }) {
  return (
    <label className={`card block cursor-pointer p-3 transition-colors hover:bg-card-hover has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${checked ? "!border-accent" : ""}`}>
      <input type="radio" name={name} className="sr-only" checked={checked} onChange={onSelect} />
      <span className="block font-semibold">{title}</span>
      <span className="mt-0.5 block text-xs text-muted">{children}</span>
    </label>
  );
}

function PlatformDanger({ platform, conns, onChanged, onDeleted }: { platform: PlatformRow; conns: ConnectionRow[]; onChanged: () => void; onDeleted: () => void }) {
  const { toast } = useApp();
  const [removing, setRemoving] = useState<ConnectionRow | null>(null);
  const [withTx, setWithTx] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState("");
  const multi = conns.length > 1;
  const tx = platform.txCount;
  const hasContent = tx > 0 || conns.length > 0;
  // wat er met de koppelingen verdwijnt; de gedeelde eToro-keys horen bij de koersen en blijven
  const wiped = conns.filter((c) => !sharedKeys(c));
  const secrets = !wiped.length ? null : wiped.every(isWallet) ? "xpubs" : wiped.some(isWallet) ? "keys en xpubs" : "keys";
  const txPart = tx === 1 ? "de transactie" : `alle ${tx} transacties`;
  const connPart = `${plural(conns.length, "koppeling", "koppelingen")}${secrets ? ` met de ${secrets}` : ""}`;
  const platformNote = hasContent ? `Wist ook ${[tx > 0 && txPart, conns.length > 0 && connPart].filter(Boolean).join(" en ")}.` : "Er hangen geen transacties of koppelingen aan.";

  const removeConnection = async () => {
    if (!removing) return;
    const c = removing;
    const deleteTx = withTx && c.apiTxCount > 0;
    try {
      await api(`/api/connections/${c.id}?transactions=${deleteTx ? 1 : 0}`, { method: "DELETE" });
      toast(deleteTx ? `Koppeling “${c.label}” en ${plural(c.apiTxCount, "API-transactie", "API-transacties")} verwijderd` : `Koppeling “${c.label}” verwijderd`);
      onChanged();
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setRemoving(null);
  };

  const removePlatform = async () => {
    try {
      const r = await api<{ transactions: number; connections: number }>(`/api/platforms/${platform.id}${hasContent ? "?everything=1" : ""}`, { method: "DELETE" });
      setDeleting(false);
      // de API-transacties die met hun koppeling meegaan telt de server niet mee in `transactions`; het platform wel
      const n = Math.max(r.transactions, tx);
      toast(hasContent ? `${plural(n, "transactie", "transacties")} en ${plural(r.connections, "koppeling", "koppelingen")} verwijderd` : `Platform “${platform.name}” verwijderd`);
      onDeleted();
    } catch (e) {
      toast(errMsg(e), "error");
      setDeleting(false);
    }
  };

  const n = removing?.apiTxCount ?? 0;
  const others = removing?.siblingIds.length ?? 0;

  return (
    <>
      <DangerZone>
        {conns.map((c) => (
          <SettingRow
            key={c.id}
            label={
              <>
                Koppeling verwijderen
                {multi && <span className="min-w-0 break-words font-normal text-muted">· {c.label}</span>}
              </>
            }
            description={sharedKeys(c) ? "Je kiest of de API-transacties blijven; de gedeelde koers-keys blijven staan." : `De ${isWallet(c) ? "xpubs" : "keys"} worden gewist; je kiest of de API-transacties blijven.`}
          >
            <button
              type="button"
              className={SMALL_DANGER}
              onClick={() => {
                setWithTx(false);
                setRemoving(c);
              }}
            >
              Koppeling verwijderen…
            </button>
          </SettingRow>
        ))}
        <SettingRow label="Platform verwijderen" description={platformNote}>
          <button
            type="button"
            className={SMALL_DANGER}
            onClick={() => {
              setTyped("");
              setDeleting(true);
            }}
          >
            Platform verwijderen…
          </button>
        </SettingRow>
      </DangerZone>

      <ConfirmDialog open={!!removing} title={removing ? `Koppeling “${removing.label}” verwijderen` : ""} confirmLabel="Koppeling verwijderen" tone="danger" backup onConfirm={removeConnection} onClose={() => setRemoving(null)}>
        {removing && (
          <>
            {n > 0 && (
              <div role="radiogroup" aria-label="De API-transacties" className="grid gap-2">
                <Choice name="api-transacties" checked={!withTx} onSelect={() => setWithTx(false)} title="Transacties bewaren (aanbevolen)">
                  {n === 1 ? "De API-transactie blijft staan en wordt handmatig bewerkbaar." : `De ${n} API-transacties blijven staan en worden handmatig bewerkbaar.`}
                </Choice>
                <Choice name="api-transacties" checked={withTx} onSelect={() => setWithTx(true)} title={n === 1 ? "Ook de API-transactie verwijderen" : `Ook de ${n} API-transacties verwijderen`}>
                  {others ? `Let op: dit zijn alle API-transacties van dit platform in ${removing.portfolioName}, ook die van ${others === 1 ? "de andere koppeling" : "de andere koppelingen"} hier.` : "Alleen die van deze koppeling."}
                </Choice>
              </div>
            )}
            <ul className="list-disc space-y-1 pl-5 text-muted">
              <li>{isWallet(removing) ? "Xpubs worden gewist." : sharedKeys(removing) ? "De gedeelde koers-keys blijven staan; de koersen gebruiken ze ook." : "Keys worden gewist."}</li>
              <li>Het platform {platform.name} blijft bestaan.</li>
            </ul>
          </>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting}
        title={`Platform “${platform.name}” verwijderen`}
        confirmLabel="Platform verwijderen"
        tone="danger"
        backup
        confirmDisabled={hasContent && typed.trim() !== platform.name}
        onConfirm={removePlatform}
        onClose={() => setDeleting(false)}
      >
        <ul className="list-disc space-y-1 pl-5 text-muted">
          {tx > 0 && <li>{tx === 1 ? "De transactie van dit platform wordt verwijderd" : `Alle ${tx} transacties van dit platform worden verwijderd`}, ook API-transacties en die in andere portfolios.</li>}
          {conns.length > 0 && (
            <li>
              {plural(conns.length, "koppeling", "koppelingen")} {conns.length === 1 ? "wordt" : "worden"} verwijderd{secrets ? `; de ${secrets} worden gewist` : ""}.
            </li>
          )}
          {!hasContent && <li>Er hangen geen transacties of koppelingen aan dit platform.</li>}
          <li>Dit kan niet ongedaan worden gemaakt.</li>
        </ul>
        {hasContent && (
          <label className="block">
            <span className="label">
              Typ <b className="text-text">{platform.name}</b> om te bevestigen
            </span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
        )}
      </ConfirmDialog>
    </>
  );
}
