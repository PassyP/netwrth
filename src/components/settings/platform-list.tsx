"use client";

/**
 * Instellingen → Platforms en koppelingen: elk platform met één status (de slechtste koppeling telt), een Sync-knop per
 * platform en de Bitcoin-node waar de wallet-koppelingen hun saldo vandaan halen. Hernoemen, koppelingen beheren en
 * verwijderen gebeurt op de detailpagina van een platform (/settings/platforms/[id]).
 */
import Link from "next/link";
import { useRef, useState } from "react";
import Decimal from "decimal.js";
import { Plus, RefreshCw } from "lucide-react";
import { api, useApi, useApp } from "../app-state";
import { ConnectionWizard, type ConnectionRow } from "../connections";
import { Card, Field, Modal, Skeleton, timeAgo, useFormat } from "../ui";
import { formatDate, PLATFORM_TYPE_LABELS } from "@/lib/format";
import { describeInterval } from "@/lib/schedule";
import type { PlatformRow, PlatformType } from "@/lib/platforms";
import type { AppSettings } from "@/lib/settings";
import { SettingsPageHeader, SettingsStack, useScrollToHash, useSettings } from "./context";
import { NodeForm } from "./node-form";
import { Disclosure, ListRow, Segmented, StatusBadge, type Tone } from "./ui";

interface SyncReport {
  ok: boolean;
  created: number;
  message: string;
}

interface Status {
  tone: Tone;
  label: string;
}

const PLATFORMS_DESCRIPTION = "Brokers, exchanges en wallets. Een platform wordt bijgewerkt via een koppeling, of handmatig via import en transacties.";
const NODE_DESCRIPTION = "Hier halen je wallet-koppelingen saldo en transacties op. Standaard verlaten je adressen je netwerk niet.";
const TYPE_OPTIONS: { value: PlatformType; label: string }[] = (["wallet", "broker", "exchange", "other"] as const).map((t) => ({ value: t, label: PLATFORM_TYPE_LABELS[t] }));
const DOT: Record<Tone, string> = { ok: "bg-up", warn: "bg-warn", down: "bg-down", neutral: "bg-muted" };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const isWallet = (c: ConnectionRow) => c.provider === "bitcoin";
const hasWarning = (c: ConnectionRow) => (c.reconciliation?.length ?? 0) > 0 || (c.lastRun?.warnings?.length ?? 0) > 0 || c.nodeSource === "fallback";

/** De slechtste koppeling bepaalt de status; een lopende sync vanaf deze pagina gaat voor (die staat nog niet in de data). */
function platformStatus(conns: ConnectionRow[], busy: boolean): Status {
  if (!conns.length) return { tone: "neutral", label: "Handmatig" };
  if (busy) return { tone: "neutral", label: "Bezig" };
  if (conns.some((c) => c.status === "error")) return { tone: "down", label: "Fout" };
  if (conns.some((c) => c.status === "syncing")) return { tone: "neutral", label: "Bezig" };
  if (conns.some(hasWarning)) return { tone: "warn", label: "Let op" };
  if (conns.some((c) => c.status === "never")) return { tone: "neutral", label: "Nog niet gesynct" };
  return { tone: "ok", label: "In orde" };
}

function metaText(p: PlatformRow, conns: ConnectionRow[]): string {
  const tx = plural(p.txCount, "transactie", "transacties");
  if (!conns.length) return `Handmatig · ${tx}`;
  if (conns.length > 1) return `${conns.length} koppelingen · ${tx}`;
  const c = conns[0];
  return `${c.portfolioName} · ${tx} · ${c.lastSyncAt ? `gesynct ${timeAgo(c.lastSyncAt)}` : "nog niet gesynct"}`;
}

/** Eén regel over wat er mis is: de fout gaat voor, anders de waarschuwingen samen. */
function problemOf(conns: ConnectionRow[]): { tone: "down" | "warn"; text: string } | null {
  const failed = conns.find((c) => c.status === "error");
  if (failed) {
    const line = (failed.lastError ?? "").split("\n")[0].trim() || "De laatste sync is mislukt";
    return { tone: "down", text: conns.length > 1 ? `${failed.label}: ${line}` : line };
  }
  const diffs = conns.reduce((n, c) => n + (c.reconciliation?.length ?? 0), 0);
  const warnings = conns.reduce((n, c) => n + (c.lastRun?.warnings?.length ?? 0), 0);
  const parts: string[] = [];
  if (diffs) parts.push(plural(diffs, "afstemmingsverschil", "afstemmingsverschillen"));
  if (warnings) parts.push(`${plural(warnings, "waarschuwing", "waarschuwingen")} bij de laatste sync`);
  if (conns.some((c) => c.nodeSource === "fallback")) parts.push("via publieke node");
  return parts.length ? { tone: "warn", text: parts.join(" · ") } : null;
}

/** Bevestigd BTC-saldo en wat nog in afwachting is, opgeteld over de wallet-koppelingen; null als er nog niets gesynct is. */
function btcTotals(wallets: ConnectionRow[]): { amount: Decimal; hold: Decimal } | null {
  let found = false;
  let amount = new Decimal(0);
  let hold = new Decimal(0);
  for (const b of wallets.flatMap((w) => w.balances)) {
    if (b.currency !== "BTC") continue;
    found = true;
    amount = amount.plus(b.amount || 0);
    if (b.hold) hold = hold.plus(b.hold);
  }
  return found ? { amount, hold } : null;
}

function nodeStatus(wallets: ConnectionRow[], s: AppSettings): Status {
  if (!wallets.length) return { tone: "neutral", label: "Niet in gebruik" };
  if (wallets.some((w) => w.nodeSource === "fallback") || (!s.bitcoinApiUrl && s.bitcoinFallbackEnabled)) return { tone: "warn", label: "Publieke node in gebruik" };
  if (s.bitcoinApiUrl) return { tone: "ok", label: "Eigen node" };
  return { tone: "warn", label: "Niet ingesteld" };
}

/** "elke 10 min", passend na "Wallets synchroniseren". */
function walletIntervalText(minutes: number): string {
  if (minutes <= 0) return "alleen bij de dagelijkse ronde en handmatig";
  const label = describeInterval(minutes).label;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

// ---------------------------------------------------------------------------------------------------------------------

export function PlatformsSettings() {
  const { bump, toast } = useApp();
  const fmt = useFormat();
  const { data, reloadOverview } = useSettings();
  const { data: platforms, error: platformsError, reload: reloadPlatforms } = useApi<PlatformRow[]>("/api/platforms");
  const { data: connections, error: connectionsError, reload: reloadConnections } = useApi<ConnectionRow[]>("/api/connections");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [syncing, setSyncing] = useState<number | null>(null);
  const syncLock = useRef(false);
  useScrollToHash(!!platforms && !!connections && !!data);

  const refresh = () => {
    reloadPlatforms();
    reloadConnections();
    bump();
    reloadOverview();
  };

  const sync = async (p: PlatformRow, conns: ConnectionRow[]) => {
    // één sync tegelijk: een dubbele klik of een tweede platform zou dezelfde node of API dubbel belasten
    if (syncLock.current) return;
    syncLock.current = true;
    setSyncing(p.id);
    let created = 0;
    const failed: string[] = [];
    for (const c of conns) {
      const who = conns.length > 1 ? `${c.label}: ` : "";
      try {
        const r = await api<SyncReport>(`/api/connections/${c.id}/sync`, { method: "POST" });
        created += r.created;
        if (!r.ok) failed.push(who + r.message);
      } catch (e) {
        failed.push(who + (e instanceof Error ? e.message : String(e)));
      }
    }
    syncLock.current = false;
    setSyncing(null);
    if (failed.length) toast(`Sync mislukt: ${fmt.text(failed.join("; "))}`, "error");
    else toast(`${p.name}: ${created} nieuw`);
    refresh();
  };

  const addButtons = (
    <div className="flex flex-wrap gap-2">
      <button type="button" className="btn btn-ghost flex items-center gap-1 !py-1.5 text-xs" onClick={() => setAddOpen(true)}>
        <Plus size={14} /> Handmatig platform
      </button>
      <button type="button" className="btn flex items-center gap-1 !py-1.5 text-xs" onClick={() => setWizardOpen(true)}>
        <Plus size={14} /> Koppeling toevoegen
      </button>
    </div>
  );
  const loadError = platformsError ?? connectionsError;
  const empty = !!platforms && platforms.length === 0;

  return (
    <div className="space-y-4">
      <SettingsPageHeader category="platforms" />
      <SettingsStack>
        {/* in de lege staat staan de knoppen bij de uitleg in plaats van in de kop */}
        <Card title="Platforms" id="platforms" description={PLATFORMS_DESCRIPTION} action={empty ? undefined : addButtons}>
          {!platforms || !connections ? (
            loadError ? (
              <p className="text-sm text-down">{loadError}</p>
            ) : (
              <div className="space-y-1">
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
              </div>
            )
          ) : empty ? (
            <div className="space-y-3">
              <p className="text-sm text-muted">
                Nog geen platforms. Koppel eToro of Kraken met een API-key die alleen mag lezen, of een Bitcoin-wallet watch-only met de xpub; de app haalt dan zelf posities en transacties op. Keys maak je in het{" "}
                <a href="https://api-portal.etoro.com/" target="_blank" rel="noreferrer" className="text-accent">
                  eToro API-portal
                </a>{" "}
                (rechten Read) of bij Kraken onder{" "}
                <a href="https://www.kraken.com/u/security/api" target="_blank" rel="noreferrer" className="text-accent">
                  Security → API
                </a>{" "}
                (alleen de Query-rechten). Zonder koppeling kan ook: maak een handmatig platform en voeg transacties toe.
              </p>
              {addButtons}
            </div>
          ) : (
            <ul className="space-y-1">
              {platforms.map((p) => (
                <PlatformItem key={p.id} platform={p} conns={connections.filter((c) => c.platformId === p.id)} busy={syncing === p.id} locked={syncing !== null} onSync={(conns) => void sync(p, conns)} />
              ))}
            </ul>
          )}
        </Card>
        <NodeCard connections={connections} />
      </SettingsStack>
      <AddPlatformModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(name) => {
          setAddOpen(false);
          toast(`Platform "${name}" toegevoegd`);
          refresh();
        }}
      />
      <ConnectionWizard open={wizardOpen} onClose={() => setWizardOpen(false)} onDone={() => refresh()} />
    </div>
  );
}

function PlatformItem({ platform: p, conns, busy, locked, onSync }: { platform: PlatformRow; conns: ConnectionRow[]; busy: boolean; locked: boolean; onSync: (conns: ConnectionRow[]) => void }) {
  const fmt = useFormat();
  const status = platformStatus(conns, busy);
  const problem = problemOf(conns);
  const btc = btcTotals(conns.filter(isWallet));
  // eToro real + demo op één platform zijn twee badges; twee wallets met hetzelfde label één
  const providers = [...new Set(conns.map((c) => `${c.providerLabel}${c.accountType === "demo" ? " demo" : ""}`))];

  return (
    <ListRow
      href={`/settings/platforms/${p.id}`}
      title={p.name}
      leading={
        <>
          <span className={`block h-2.5 w-2.5 shrink-0 rounded-full sm:hidden ${DOT[status.tone]}`}>
            <span className="sr-only">{status.label}</span>
          </span>
          {/* vaste breedte, zodat de namen onder elkaar uitlijnen */}
          <span className="hidden w-[7.5rem] shrink-0 sm:block">
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          </span>
        </>
      }
      badges={
        <>
          <span className="hidden sm:inline-flex">
            <StatusBadge tone="neutral">{PLATFORM_TYPE_LABELS[p.type] ?? p.type}</StatusBadge>
          </span>
          {providers.map((label) => (
            <StatusBadge key={label} tone="neutral">
              {label}
            </StatusBadge>
          ))}
        </>
      }
      meta={metaText(p, conns)}
      extra={
        (problem || btc) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {problem && <span className={`min-w-0 break-words ${problem.tone === "down" ? "text-down" : "text-warn"}`}>{problem.tone === "down" ? fmt.text(problem.text) : problem.text}</span>}
            {btc && <span className="rounded-md bg-card px-1.5 py-0.5 font-semibold tnum">{fmt.qty(btc.amount)} BTC</span>}
            {btc && !btc.hold.isZero() && (
              <span className="rounded-md bg-warn/10 px-1.5 py-0.5 text-warn tnum">
                in afwachting {!fmt.hidden && btc.hold.gt(0) ? "+" : ""}
                {fmt.qty(btc.hold)} BTC
              </span>
            )}
          </div>
        )
      }
      trailing={
        conns.length > 0 ? (
          <button type="button" className="btn btn-ghost tap !p-1.5" disabled={locked} aria-busy={busy} aria-label={`${p.name} synchroniseren`} title={busy ? "Bezig met synchroniseren" : locked ? "Wacht tot de lopende sync klaar is" : "Nu synchroniseren"} onClick={() => onSync(conns)}>
            <RefreshCw size={14} aria-hidden className={busy ? "animate-spin motion-reduce:animate-none" : ""} />
          </button>
        ) : undefined
      }
    />
  );
}

function AddPlatformModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (name: string) => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<PlatformType>("wallet");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setType("wallet");
    setError(null);
  };
  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };
  const submit = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/platforms", { method: "POST", json: { name: n, type } });
      reset();
      onAdded(n);
    } catch (e) {
      // bijv. "Er bestaat al een platform met de naam …": bij het veld, de modal blijft open
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title="Handmatig platform">
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Naam">
          <input
            className={`input ${error ? "!border-down" : ""}`}
            autoFocus
            maxLength={60}
            placeholder="Bijv. Koude wallet"
            aria-invalid={!!error}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
          />
        </Field>
        {/* geen Field (label-element) om de knoppen: een klik op het label zou de eerste optie kiezen */}
        <div>
          <span className="label">Type</span>
          <Segmented label="Type" value={type} options={TYPE_OPTIONS} onChange={setType} />
        </div>
        {error && (
          <p className="text-xs text-down" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>
            Annuleren
          </button>
          <button type="submit" className="btn" disabled={busy || !name.trim()}>
            {busy ? "Bezig…" : "Toevoegen"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NodeCard({ connections }: { connections: ConnectionRow[] | null }) {
  const { data } = useSettings();
  if (!data || !connections) {
    return (
      <Card title="Bitcoin-node" id="bitcoin-node" description={NODE_DESCRIPTION}>
        <Skeleton className="h-24" />
      </Card>
    );
  }
  const s = data.settings;
  const wallets = connections.filter(isWallet);
  const status = nodeStatus(wallets, s);
  const walletPlatforms = [...new Map(wallets.map((w) => [w.platformId, w.platformName])).entries()];
  const lastSync = wallets.reduce<string | null>((max, w) => (w.lastSyncAt && (!max || Date.parse(w.lastSyncAt) > Date.parse(max)) ? w.lastSyncAt : max), null);

  return (
    <Card title="Bitcoin-node" id="bitcoin-node" description={NODE_DESCRIPTION} titleExtra={<StatusBadge tone={status.tone}>{status.label}</StatusBadge>}>
      {wallets.length > 0 ? (
        <>
          <p className="mb-3 text-xs text-muted">
            Gebruikt door{" "}
            {walletPlatforms.map(([id, name], i) => (
              <span key={id}>
                {i > 0 && ", "}
                <Link href={`/settings/platforms/${id}`} className="text-accent">
                  {name}
                </Link>
              </span>
            ))}
            {lastSync ? ` · laatste wallet-sync ${formatDate(lastSync, true)}` : " · nog niet gesynct"}
          </p>
          <NodeForm variant="card" />
        </>
      ) : (
        <>
          <p className="text-sm text-muted">Alleen nodig voor Bitcoin-wallet-koppelingen.</p>
          <Disclosure summary="Toch instellen" className="mt-2">
            {/* de Disclosure kleurt zijn inhoud gedempt; het formulier houdt de gewone tekstkleur */}
            <div className="text-text">
              <NodeForm variant="card" />
            </div>
          </Disclosure>
        </>
      )}
      <p className="mt-3 border-t border-border pt-3 text-xs text-muted">
        Wallets synchroniseren {walletIntervalText(s.walletSyncMinutes)} ·{" "}
        <Link href="/settings/koersen#planning" className="text-accent">
          wijzigen in Koersen en planning
        </Link>
      </p>
    </Card>
  );
}
