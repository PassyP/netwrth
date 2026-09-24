"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { api, useApi, useApp } from "./app-state";
import { Field, Modal, useFormat } from "./ui";
import { useSettings } from "./settings/context";
import { NodeForm } from "./settings/node-form";
import { BackupHint, Callout, Disclosure, Segmented, StatusBadge, Switch, type SegmentOption } from "./settings/ui";
import { formatDate } from "@/lib/format";
import type { Provider, ScriptType } from "@/lib/db/schema";
import type { DiscoverCandidate } from "@/lib/bitcoin/discover";

interface ProviderInfo {
  id: Provider;
  label: string;
  credentials: "keys" | "none";
  keyLabels: { apiKey: string; apiSecret: string };
  helpUrl: string;
}

export interface WalletAccountRow {
  id: number;
  label: string;
  scriptType: ScriptType;
  enabled: boolean;
  receiveUsed: number;
  changeUsed: number;
  txCount: number;
  balanceConfirmed: string;
  balanceUnconfirmed: string;
  lastScanAt: string | null;
}

export interface ConnectionRow {
  id: number;
  provider: Provider;
  providerLabel: string;
  label: string;
  platformId: number;
  platformName: string;
  portfolioId: number;
  portfolioName: string;
  accountType: string;
  mode: string;
  receiptCost: string; // wallet: market | none
  status: string;
  lastSyncAt: string | null;
  lastError: string | null;
  txCount: number;
  /** API-transacties op dit platform in dit portfolio: wat "verwijderen met transacties" zou wissen */
  apiTxCount: number;
  /** andere koppelingen op hetzelfde platform én portfolio (eToro real + demo): hun API-transacties gaan dan mee */
  siblingIds: number[];
  /** wallet: welke node de laatste sync gebruikte */
  nodeSource: "own" | "fallback" | null;
  createdAt: string;
  balances: { currency: string; amount: string; hold?: string }[];
  lastRun: { id: number; startedAt: string; finishedAt: string | null; ok: boolean | null; created: number; skipped: number; message: string | null; warnings: string[] } | null;
  reconciliation: { symbol: string; assetId: number | null; computed: string; reported: string; diff: string }[] | null;
  keys: { shared: boolean; present: boolean; last4: string | null };
  accounts: WalletAccountRow[];
}

interface SyncReport {
  ok: boolean;
  created: number;
  skipped: number;
  warnings: string[];
  message: string;
  reconciliation: ConnectionRow["reconciliation"];
}

type NodeSource = "own" | "fallback";

interface DiscoverResponse {
  candidates: DiscoverCandidate[];
  warnings: string[];
  source: NodeSource;
}

/** Wizard stap 4: op welk platform de koppeling komt en hoeveel transacties "Vervangen" daar zou wissen. */
interface PreviewResponse {
  platformId: number | null;
  name: string;
  type: string;
  exists: boolean;
  replaceable: number;
}

type AccountType = "real" | "demo";
type KeySource = "shared" | "own";
type Mode = "replace" | "alongside";
type ReceiptCost = "market" | "none";

export const SCRIPT_LABELS: Record<ScriptType, string> = { p2pkh: "Legacy (1…)", "p2sh-p2wpkh": "SegWit (3…)", p2wpkh: "Native SegWit (bc1q…)", p2tr: "Taproot (bc1p…)" };
const PROVIDER_BLURB: Record<Provider, string> = {
  kraken: "Volledige historie: trades, stortingen, staking",
  etoro: "Open posities en kas; verkopen via momentopname",
  bitcoin: "Watch-only via xpub: saldo en on-chain transacties van je eigen node",
};
const ENV_OPTIONS: SegmentOption<AccountType>[] = [
  { value: "real", label: "Real" },
  { value: "demo", label: "Demo" },
];
const RECEIPT_COST_OPTIONS: SegmentOption<ReceiptCost>[] = [
  { value: "market", label: "Dagkoers" },
  { value: "none", label: "Geen kostprijs" },
];
const RECEIPT_COST_HINT: Record<ReceiptCost, string> = {
  market: "De BTC-koers van de dag van ontvangst, alsof je de coins toen kocht; telt als inleg.",
  none: "Kostprijs 0 en geen nieuwe inleg: de coins kwamen van je eigen geld elders.",
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "0,0123 BTC", of "•••• BTC" als "Bedragen verbergen" aan staat. */
function useBtcAmount() {
  const { qty } = useFormat();
  return (v: string) => `${qty(v)} BTC`;
}
const nonZero = (v?: string | null) => !!v && Number(v) !== 0;
const candKey = (c: DiscoverCandidate) => `${c.keyIndex}:${c.scriptType}`;
const splitKeys = (text: string) => text.split(/\r?\n/);

/** Zoekt accounts bij de ingevoerde keys; vinkt actieve accounts voor (zonder activiteit: het type dat het prefix impliceert). */
async function discoverKeys(text: string, allTypes: boolean): Promise<{ result: DiscoverResponse; preselected: Set<string> }> {
  const result = await api<DiscoverResponse>("/api/connections/bitcoin/discover", { method: "POST", json: { keys: splitKeys(text), allTypes } });
  const byKey = new Map<number, DiscoverCandidate[]>();
  for (const c of result.candidates) {
    if (!byKey.has(c.keyIndex)) byKey.set(c.keyIndex, []);
    byKey.get(c.keyIndex)!.push(c);
  }
  const preselected = new Set<string>();
  for (const list of byKey.values()) {
    const active = list.filter((c) => c.active);
    for (const c of active.length ? active : list.filter((c) => c.defaultType)) preselected.add(candKey(c));
  }
  return { result, preselected };
}

/** Uit de kandidaten en de ingevoerde regels de accounts voor de API (de xpub komt uit de invoer, niet uit het antwoord). */
function selectedAccounts(text: string, candidates: DiscoverCandidate[], selected: Set<string>) {
  const lines = splitKeys(text);
  return candidates.filter((c) => selected.has(candKey(c))).map((c) => ({ xpub: lines[c.keyIndex].trim(), scriptType: c.scriptType, label: c.label, enabled: true }));
}

function CandidateList({ candidates, selected, onChange }: { candidates: DiscoverCandidate[]; selected: Set<string>; onChange: (next: Set<string>) => void }) {
  const btcAmount = useBtcAmount();
  if (candidates.length === 0) return <p className="text-sm text-muted">Geen bruikbare keys gevonden.</p>;
  return (
    <ul className="max-h-72 space-y-1 overflow-y-auto">
      {candidates.map((c) => {
        const k = candKey(c);
        return (
          <li key={k} className={`flex items-start gap-2 rounded-lg bg-bg-elev p-2 ${c.active ? "" : "opacity-70"}`}>
            <input
              type="checkbox"
              className="mt-1"
              checked={selected.has(k)}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(k);
                else next.delete(k);
                onChange(next);
              }}
            />
            <div className="min-w-0 flex-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{c.label}</span>
                <span className="text-xs text-muted">
                  {SCRIPT_LABELS[c.scriptType]} · key {c.keyIndex + 1} ({c.prefix}, {c.fingerprint})
                </span>
                <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase ${c.active ? "bg-up-soft text-up" : "bg-card text-muted"}`}>{c.active ? "actief" : "geen activiteit"}</span>
              </div>
              <div className="break-words text-xs text-muted tnum">
                {btcAmount(c.balanceConfirmed)}
                {nonZero(c.balanceUnconfirmed) ? ` (${Number(c.balanceUnconfirmed) > 0 ? "+" : ""}${btcAmount(c.balanceUnconfirmed)} onbevestigd)` : ""} · ±{c.txCount} tx · eerste adres <span className="font-mono">{c.firstAddress}</span>
                {c.depth !== 3 ? " · geen account-key" : ""}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function KeysInput({ text, allTypes, onChange, helpUrl }: { text: string; allTypes: boolean; onChange: (text: string, allTypes: boolean) => void; helpUrl?: string }) {
  return (
    <>
      <p className="text-sm text-muted">
        Plak per regel één xpub, ypub of zpub. Ledger Live: account → moersleutel → <i>Advanced</i> → xpub; één key is één account. Nooit een xprv (private key).{" "}
        {helpUrl && (
          <a href={helpUrl} target="_blank" rel="noreferrer" className="text-accent">
            Uitleg bij Ledger
          </a>
        )}
      </p>
      <Field label="Extended public keys" hint="Eén per regel. De keys worden versleuteld opgeslagen en komen niet in logs of meldingen.">
        <textarea className="input font-mono text-xs" rows={4} spellCheck={false} autoComplete="off" value={text} onChange={(e) => onChange(e.target.value, allTypes)} placeholder="zpub6…" />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={allTypes} onChange={(e) => onChange(text, e.target.checked)} /> Alle adrestypes scannen (ook bij ypub/zpub)
      </label>
    </>
  );
}

/** Welke node de accountzoektocht beantwoordde: een publieke node heeft de adressen van de wallet gezien. */
function SourceNote({ source }: { source: NodeSource | null }) {
  if (!source) return null;
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
      {source === "own" ? (
        <StatusBadge tone="ok">via eigen node</StatusBadge>
      ) : (
        <>
          <StatusBadge tone="warn">via publieke node</StatusBadge> die node heeft je adressen gezien
        </>
      )}
    </p>
  );
}

/** Keuze die uitleg nodig heeft, in de stijl van de providertegels: de gekozen kaart krijgt de accentrand. */
function ChoiceCard({ selected, onSelect, title, children }: { selected: boolean; onSelect: () => void; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <button type="button" className={`card p-3 text-left hover:bg-card-hover ${selected ? "!border-accent" : ""}`} aria-pressed={selected} onClick={onSelect}>
      <div className="text-sm font-semibold">{title}</div>
      {children && <div className="mt-0.5 text-xs text-muted">{children}</div>}
    </button>
  );
}

/** Kostprijs van wallet-ontvangsten: korte keuze, één regel bij de gekozen optie, de lange uitleg op verzoek. */
function ReceiptCostField({ value, onChange }: { value: ReceiptCost; onChange: (v: ReceiptCost) => void }) {
  return (
    <div className="space-y-1.5">
      <span className="label">Kostprijs van ontvangsten zonder herkende tegenpartij</span>
      <Segmented value={value} options={RECEIPT_COST_OPTIONS} onChange={onChange} label="Kostprijs van ontvangsten zonder herkende tegenpartij" />
      <p className="text-xs text-muted">{RECEIPT_COST_HINT[value]}</p>
      <Disclosure summary="Meer uitleg">
        <p>Een ontvangst die bij een opname op een ander platform in de app hoort (bijvoorbeeld een Kraken-opname naar deze wallet), krijgt altijd de kostprijs van die zender mee. Deze keuze geldt alleen voor de overige ontvangsten.</p>
        <p>
          <b>Dagkoers</b>: alsof je de coins op de dag van ontvangst kocht; ze tellen als nieuwe inleg. <b>Geen kostprijs</b>: de coins kwamen van je eigen geld elders (een andere wallet, een oude aankoop), dus kostprijs 0 en geen nieuwe inleg.
        </p>
        <p>De keuze geldt direct voor alle ontvangsten van deze wallet, ook eerdere; er wordt niets opnieuw geboekt.</p>
      </Disclosure>
    </div>
  );
}

/** Knoppen onder een stap of formulier: rechts uitgelijnd, de primaire knop als laatste (rechts). */
function Actions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 pt-1">{children}</div>;
}

const EMPTY_FORM = { label: "", apiKey: "", apiSecret: "", accountType: "real" as AccountType, receiptCost: "market" as ReceiptCost, keySource: "shared" as KeySource };

/** Voorinvulling als de wizard vanuit een platform wordt geopend (koppeling op dát platform). */
export interface WizardInitial {
  provider?: Provider;
  platformId?: number;
  label?: string;
}

export function ConnectionWizard({ open, onClose, onDone, initial }: { open: boolean; onClose: () => void; onDone: (r?: { platformId: number | null }) => void; initial?: WizardInitial }) {
  const { portfolios, portfolioId, reloadPortfolios } = useApp();
  const { data: settingsData, reloadOverview } = useSettings();
  const fmt = useFormat();
  const router = useRouter();
  const pathname = usePathname();
  const { data: providers } = useApi<ProviderInfo[]>(open ? "/api/connections/providers" : null);
  const activePortfolios = portfolios.filter((x) => !x.archived);
  const defaultPortfolio = (portfolioId != null && activePortfolios.some((x) => x.id === portfolioId) ? portfolioId : activePortfolios[0]?.id) ?? 0;

  const [step, setStep] = useState(1);
  const [provider, setProvider] = useState<Provider>("kraken");
  const [fixedPlatformId, setFixedPlatformId] = useState<number | null>(null);
  const [lockProvider, setLockProvider] = useState(false);
  const [f, setF] = useState({ ...EMPTY_FORM, portfolioId: 0 });
  const [newPortfolio, setNewPortfolio] = useState<{ name: string; busy: boolean; error: string | null } | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ report: SyncReport; platformId: number } | null>(null);
  const [preview, setPreview] = useState<{ key: string; data: PreviewResponse | null; error: string | null } | null>(null);
  const [modeChoice, setModeChoice] = useState<{ key: string; mode: Mode } | null>(null);
  // wallet: keys → kandidaat-accounts → selectie
  const [keysText, setKeysText] = useState("");
  const [allTypes, setAllTypes] = useState(false);
  const [candidates, setCandidates] = useState<DiscoverCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [discoverWarnings, setDiscoverWarnings] = useState<string[]>([]);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [source, setSource] = useState<NodeSource | null>(null);
  // het node-formulier blijft staan nadat het de node heeft ingesteld, zodat je hem nog kunt testen
  const [nodeFormKept, setNodeFormKept] = useState(false);

  // De wizard blijft gemount: bij elke keer openen opnieuw beginnen, met de voorinvulling van dát moment.
  const [openSeen, setOpenSeen] = useState(false);
  if (open !== openSeen) {
    setOpenSeen(open);
    if (open) {
      setStep(1);
      setProvider(initial?.provider ?? "kraken");
      setFixedPlatformId(initial?.platformId ?? null);
      setLockProvider(initial?.platformId != null && initial.provider != null);
      setF({ ...EMPTY_FORM, label: initial?.label ?? "", portfolioId: defaultPortfolio });
      setNewPortfolio(null);
      setTest(null);
      setBusy(false);
      setError(null);
      setResult(null);
      setPreview(null);
      setModeChoice(null);
      setKeysText("");
      setAllTypes(false);
      setCandidates(null);
      setSelected(new Set());
      setDiscoverWarnings([]);
      setDiscoverError(null);
      setSource(null);
      setNodeFormKept(false);
    }
  }
  // portfolios kunnen later binnenkomen dan het openen
  useEffect(() => {
    if (open && !f.portfolioId && defaultPortfolio) setF((x) => ({ ...x, portfolioId: defaultPortfolio }));
  }, [open, f.portfolioId, defaultPortfolio]);

  const { data: platformList } = useApi<{ id: number; name: string }[]>(open && fixedPlatformId != null ? "/api/platforms" : null);
  const fixedPlatformName = platformList?.find((x) => x.id === fixedPlatformId)?.name ?? null;

  const p = providers?.find((x) => x.id === provider);
  const isWallet = provider === "bitcoin";
  const s = settingsData?.settings;
  const nodeConfigured = !!s?.bitcoinApiUrl || !!s?.bitcoinFallbackEnabled;
  const needsNode = !!settingsData && !nodeConfigured;
  const sharedKey = settingsData?.secrets.etoroApiKey;
  const sharedPresent = !!sharedKey?.present && !!settingsData?.secrets.etoroUserKey.present;
  const usingShared = provider === "etoro" && sharedPresent && f.keySource === "shared";
  const keyCount = splitKeys(keysText).filter((l) => l.trim()).length;
  const label = f.label.trim() || p?.label || provider;
  const portfolioName = portfolios.find((x) => x.id === f.portfolioId)?.name ?? "dit portfolio";

  // stap 4: platform en aantal te vervangen transacties, opnieuw bij een ander portfolio, naam of provider
  const previewKey = step === 4 && f.portfolioId ? JSON.stringify([provider, label, f.portfolioId, fixedPlatformId]) : null;
  useEffect(() => {
    if (!previewKey) return;
    let cancelled = false;
    api<PreviewResponse>("/api/connections/preview", { method: "POST", json: { provider, label, portfolioId: f.portfolioId, platformId: fixedPlatformId ?? undefined } })
      .then((data) => {
        if (!cancelled) setPreview({ key: previewKey, data, error: null });
      })
      .catch((e) => {
        if (!cancelled) setPreview({ key: previewKey, data: null, error: errMsg(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [previewKey, provider, label, f.portfolioId, fixedPlatformId]);
  const pv = preview && preview.key === previewKey ? preview : null;
  // Staan er transacties die "Vervangen" zou wissen (of weten we het niet), dan geen voorselectie maar een verplichte keuze.
  const needsChoice = !!pv && (pv.error != null || (pv.data?.replaceable ?? 0) > 0);
  const mode: Mode | null = !pv ? null : needsChoice ? (modeChoice && modeChoice.key === previewKey ? modeChoice.mode : null) : "replace";
  const replaceable = pv?.data?.replaceable ?? 0;
  const platformName = pv?.data?.name ?? "dit platform";

  const createPortfolio = async () => {
    if (!newPortfolio || newPortfolio.busy) return;
    const name = newPortfolio.name.trim();
    if (!name) return setNewPortfolio({ ...newPortfolio, error: "Geef het portfolio een naam." });
    setNewPortfolio({ ...newPortfolio, busy: true, error: null });
    try {
      const row = await api<{ id: number }>("/api/portfolios", { method: "POST", json: { name } });
      await reloadPortfolios();
      setF((x) => ({ ...x, portfolioId: row.id }));
      setNewPortfolio(null);
    } catch (e) {
      setNewPortfolio((x) => x && { ...x, busy: false, error: errMsg(e) });
    }
  };

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      const r = await api<{ ok: boolean; message: string }>("/api/connections/test", {
        method: "POST",
        json: { provider, accountType: f.accountType, apiKey: usingShared ? undefined : f.apiKey, apiSecret: usingShared ? undefined : f.apiSecret, reuseEtoroKeys: usingShared },
      });
      setTest(r);
      if (r.ok) setStep(4);
    } catch (e) {
      setTest({ ok: false, message: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const discover = async () => {
    setBusy(true);
    setDiscoverError(null);
    setCandidates(null);
    setSource(null);
    try {
      const { result: r, preselected } = await discoverKeys(keysText, allTypes);
      setCandidates(r.candidates);
      setDiscoverWarnings(r.warnings);
      setSelected(preselected);
      setSource(r.source);
    } catch (e) {
      setDiscoverError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!mode) return;
    setBusy(true);
    setError(null);
    try {
      const accounts = isWallet && candidates ? selectedAccounts(keysText, candidates, selected) : undefined;
      const r = await api<{ connection: { platformId: number }; report: SyncReport }>("/api/connections?sync=1", {
        method: "POST",
        json: {
          provider,
          label,
          portfolioId: f.portfolioId,
          platformId: fixedPlatformId ?? undefined,
          accountType: f.accountType,
          mode,
          receiptCost: isWallet ? f.receiptCost : undefined,
          apiKey: isWallet || usingShared ? undefined : f.apiKey,
          apiSecret: isWallet || usingShared ? undefined : f.apiSecret,
          reuseEtoroKeys: usingShared,
          accounts,
        },
      });
      setResult({ report: r.report, platformId: r.connection.platformId });
      setStep(5);
      onDone({ platformId: r.connection.platformId });
      reloadOverview();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const platformHref = result ? `/settings/platforms/${result.platformId}` : null;
  // vanaf het platform zelf geopend: "Naar platform" zou nergens heen gaan
  const showGoToPlatform = !!platformHref && pathname !== platformHref;

  return (
    <Modal open={open} onClose={onClose} title={`Koppeling toevoegen (${step}/5)`}>
      {step === 1 && (
        <div className="space-y-3">
          <p className="text-sm text-muted">Kies het platform. Een API-key mag alleen lezen; een Bitcoin-wallet koppel je met de xpub (nooit een private key). De app plaatst nooit orders.</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {(providers ?? []).map((pr) => (
              <button
                key={pr.id}
                type="button"
                aria-pressed={provider === pr.id}
                disabled={lockProvider && pr.id !== provider}
                className={`card p-4 text-left hover:bg-card-hover disabled:cursor-not-allowed disabled:opacity-40 ${provider === pr.id ? "!border-accent" : ""}`}
                onClick={() => setProvider(pr.id)}
              >
                <div className="font-bold">{pr.label}</div>
                <div className="text-xs text-muted">{PROVIDER_BLURB[pr.id] ?? ""}</div>
              </button>
            ))}
          </div>
          {fixedPlatformId != null && (
            <p className="text-sm text-muted">
              Platform: <span className="font-semibold text-text">{fixedPlatformName ?? "…"}</span> (bestaand)
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Naam" hint={isWallet && fixedPlatformId == null ? "Wordt ook de naam van het platform (type wallet)." : "Staat in meldingen en correctienotities."}>
              <input className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder={isWallet ? "Koude wallet" : (p?.label ?? "Mijn koppeling")} />
            </Field>
            <div className="min-w-0">
              <label className="label" htmlFor="wizard-portfolio">
                Portfolio
              </label>
              <div className="flex min-w-0 gap-2">
                <select id="wizard-portfolio" className="input min-w-0 flex-1" value={f.portfolioId} onChange={(e) => setF({ ...f, portfolioId: Number(e.target.value) })}>
                  {activePortfolios.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-ghost flex shrink-0 items-center gap-1 !py-1.5 text-xs" aria-expanded={!!newPortfolio} onClick={() => setNewPortfolio(newPortfolio ? null : { name: "", busy: false, error: null })}>
                  <Plus size={13} /> Nieuw
                </button>
              </div>
              {newPortfolio && (
                <div className="mt-2 space-y-1">
                  <div className="flex min-w-0 gap-2">
                    <input
                      className={`input min-w-0 flex-1 ${newPortfolio.error ? "!border-down" : ""}`}
                      aria-label="Naam van het nieuwe portfolio"
                      aria-invalid={!!newPortfolio.error}
                      placeholder="Naam van het portfolio"
                      autoFocus
                      value={newPortfolio.name}
                      disabled={newPortfolio.busy}
                      onChange={(e) => setNewPortfolio({ ...newPortfolio, name: e.target.value, error: null })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void createPortfolio();
                        }
                        if (e.key === "Escape") {
                          // niet de hele wizard sluiten (Modal luistert op window)
                          e.stopPropagation();
                          setNewPortfolio(null);
                        }
                      }}
                    />
                    <button type="button" className="btn btn-ghost shrink-0 !py-1.5 text-xs" disabled={newPortfolio.busy} onClick={() => void createPortfolio()}>
                      {newPortfolio.busy ? "Bezig…" : "Toevoegen"}
                    </button>
                  </div>
                  {newPortfolio.error && <p className="text-xs text-down">{newPortfolio.error}</p>}
                </div>
              )}
            </div>
          </div>
          {provider === "etoro" && (
            <div>
              <span className="label">Omgeving</span>
              <Segmented value={f.accountType} options={ENV_OPTIONS} onChange={(v) => setF({ ...f, accountType: v })} label="Omgeving" />
            </div>
          )}
          <Actions>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Annuleren
            </button>
            <button type="button" className="btn" disabled={!providers || !f.portfolioId} onClick={() => setStep(2)}>
              Volgende
            </button>
          </Actions>
        </div>
      )}
      {step === 2 && isWallet && (
        <div className="space-y-3">
          {(needsNode || nodeFormKept) && <NodeForm variant="wizard" onConfigured={() => setNodeFormKept(true)} />}
          {nodeFormKept && !needsNode && <Callout tone="ok">Node ingesteld. Test hem eventueel hierboven en ga dan verder.</Callout>}
          <KeysInput
            text={keysText}
            allTypes={allTypes}
            helpUrl={p?.helpUrl}
            onChange={(t, a) => {
              setKeysText(t);
              setAllTypes(a);
              setCandidates(null);
              setSource(null);
            }}
          />
          <Actions>
            <button type="button" className="btn btn-ghost" onClick={() => setStep(1)}>
              Terug
            </button>
            <button type="button" className="btn" disabled={keyCount === 0 || needsNode} onClick={() => setStep(3)}>
              Volgende
            </button>
          </Actions>
        </div>
      )}
      {step === 2 && !isWallet && (
        <div className="space-y-3">
          <div className="space-y-2 text-sm text-muted">
            {/* precies de rechten van de drie endpoints die de koppeling aanroept: Balance, TradesHistory en Ledgers */}
            {provider === "kraken" && (
              <>
                <p>Maak in Kraken Pro (Instellingen → API) een API-key en vink bij de rechten alleen deze drie aan:</p>
                <ul className="list-disc space-y-0.5 pl-4">
                  <li>
                    <b>Query Funds</b> voor de saldi
                  </li>
                  <li>
                    <b>Query Closed Orders &amp; Trades</b> voor je trades
                  </li>
                  <li>
                    <b>Query Ledger Entries</b> voor stortingen, opnames, staking en overige mutaties
                  </li>
                </ul>
              </>
            )}
            <p>
              {provider === "kraken" ? (
                <>Andere rechten zijn niet nodig: de app leest alleen. Laat de overige instellingen op standaard; met een start- of einddatum mist de app een deel van je historie.</>
              ) : (
                <>Gebruik eToro-keys met alleen leesrechten (Read).</>
              )}{" "}
              <a href={p?.helpUrl} target="_blank" rel="noreferrer" className="text-accent">
                Open {p?.label}
              </a>
            </p>
          </div>
          {provider === "etoro" && sharedPresent && (
            <div className="grid gap-2 sm:grid-cols-2">
              <ChoiceCard selected={f.keySource === "shared"} onSelect={() => setF({ ...f, keySource: "shared" })} title="Gedeelde koers-keys gebruiken">
                ••••{sharedKey?.last4} uit Koersen en planning · aanbevolen
              </ChoiceCard>
              <ChoiceCard selected={f.keySource === "own"} onSelect={() => setF({ ...f, keySource: "own" })} title="Eigen keys voor deze koppeling">
                Een aparte set keys, alleen voor deze koppeling.
              </ChoiceCard>
            </div>
          )}
          {!usingShared && (
            <>
              <Field label={p?.keyLabels.apiKey || "API Key"}>
                <input className="input" type="password" autoComplete="off" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} />
              </Field>
              <Field label={p?.keyLabels.apiSecret || "Secret"}>
                <input className="input" type="password" autoComplete="off" value={f.apiSecret} onChange={(e) => setF({ ...f, apiSecret: e.target.value })} />
              </Field>
            </>
          )}
          <Actions>
            <button type="button" className="btn btn-ghost" onClick={() => setStep(1)}>
              Terug
            </button>
            <button type="button" className="btn" disabled={!usingShared && (!f.apiKey.trim() || !f.apiSecret.trim())} onClick={() => setStep(3)}>
              Volgende
            </button>
          </Actions>
        </div>
      )}
      {step === 3 && isWallet && (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            De app leidt per key de ontvangst- en wisseladressen af (gap limit 20) en vraagt saldo en activiteit op bij je node; er wordt nog niets opgeslagen. Vink aan welke accounts in het portfolio komen.
          </p>
          {discoverError && <Callout tone="down">{discoverError}</Callout>}
          <SourceNote source={source} />
          {candidates && <CandidateList candidates={candidates} selected={selected} onChange={setSelected} />}
          {discoverWarnings.length > 0 && (
            <ul className="list-disc pl-4 text-xs text-warn">
              {discoverWarnings.map((w, i) => (
                <li key={i}>{fmt.text(w)}</li>
              ))}
            </ul>
          )}
          <Actions>
            <button type="button" className="btn btn-ghost" onClick={() => setStep(2)}>
              Terug
            </button>
            {candidates ? (
              <>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void discover()}>
                  {busy ? "Scannen…" : "Opnieuw zoeken"}
                </button>
                <button type="button" className="btn" disabled={busy || selected.size === 0} onClick={() => setStep(4)}>
                  Volgende
                </button>
              </>
            ) : (
              <button type="button" className="btn" disabled={busy} onClick={() => void discover()}>
                {busy ? "Scannen…" : "Accounts zoeken"}
              </button>
            )}
          </Actions>
        </div>
      )}
      {step === 3 && !isWallet && (
        <div className="space-y-3">
          <p className="text-sm text-muted">De app doet een leescall om de keys en rechten te controleren; er wordt nog niets opgeslagen.</p>
          {test && <Callout tone={test.ok ? "ok" : "down"}>{fmt.text(test.message)}</Callout>}
          <Actions>
            <button type="button" className="btn btn-ghost" onClick={() => setStep(2)}>
              Terug
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void runTest()}>
              {busy ? "Testen…" : "Testen"}
            </button>
          </Actions>
        </div>
      )}
      {step === 4 && (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Platform:{" "}
            {pv?.data ? (
              <>
                <span className="font-semibold text-text">{pv.data.name}</span> ({fixedPlatformId != null ? "bestaand" : pv.data.exists ? "bestaat al" : "wordt aangemaakt"})
              </>
            ) : pv?.error ? (
              "niet te bepalen"
            ) : (
              "bepalen…"
            )}
          </p>
          {isWallet ? (
            <p className="text-sm text-muted">
              {plural(selected.size, "account", "accounts")} geselecteerd. Ontvangsten en verzendingen (inclusief minerfee) worden geboekt vanaf 6 bevestigingen.
            </p>
          ) : (
            test?.ok && <Callout tone="ok">{fmt.text(test.message)}</Callout>
          )}
          {pv?.error && <Callout tone="warn">Kon niet nagaan wat er op het platform staat: {pv.error}</Callout>}
          {needsChoice ? (
            <div className="space-y-2">
              <span className="label">Bestaande transacties op {platformName}</span>
              <div className="grid gap-2 sm:grid-cols-2">
                <ChoiceCard selected={mode === "replace"} onSelect={() => previewKey && setModeChoice({ key: previewKey, mode: "replace" })} title="Vervangen door de API-versie">
                  {pv?.data
                    ? `Verwijdert ${plural(replaceable, "handmatige of geïmporteerde transactie", "handmatige of geïmporteerde transacties")} van ${platformName} in ${portfolioName}.`
                    : `Verwijdert de handmatige en geïmporteerde transacties van dit platform in ${portfolioName}.`}
                </ChoiceCard>
                <ChoiceCard selected={mode === "alongside"} onSelect={() => previewKey && setModeChoice({ key: previewKey, mode: "alongside" })} title="Naast elkaar houden">
                  Alles blijft staan; handig om te vergelijken.
                </ChoiceCard>
              </div>
              <BackupHint />
            </div>
          ) : (
            pv?.data && <p className="text-xs text-muted">Er staan geen handmatige transacties op {platformName} in dit portfolio; er wordt niets vervangen.</p>
          )}
          {isWallet && <ReceiptCostField value={f.receiptCost} onChange={(v) => setF({ ...f, receiptCost: v })} />}
          {error && <Callout tone="down">{error}</Callout>}
          <Actions>
            <button type="button" className="btn btn-ghost" onClick={() => setStep(3)}>
              Terug
            </button>
            <button type="button" className="btn" disabled={busy || !mode} onClick={() => void create()}>
              {busy ? "Eerste sync…" : "Koppelen en synchroniseren"}
            </button>
          </Actions>
        </div>
      )}
      {step === 5 && result && (
        <div className="space-y-3 text-sm">
          <Callout tone={result.report.ok ? "ok" : "down"}>{result.report.ok ? `Klaar: ${fmt.text(result.report.message)}` : `Sync mislukt: ${fmt.text(result.report.message)}`}</Callout>
          {result.report.reconciliation && result.report.reconciliation.length > 0 && (
            <p className="text-warn">{plural(result.report.reconciliation.length, "afstemmingsverschil", "afstemmingsverschillen")}; op het platform kun je een correctie boeken.</p>
          )}
          {result.report.warnings.length > 0 && (
            <Disclosure summary={plural(result.report.warnings.length, "waarschuwing", "waarschuwingen")}>
              <ul className="list-disc pl-4">
                {result.report.warnings.slice(0, 30).map((w, i) => (
                  <li key={i}>{fmt.text(w)}</li>
                ))}
              </ul>
            </Disclosure>
          )}
          <Actions>
            <button type="button" className={`btn ${showGoToPlatform ? "btn-ghost" : ""}`} onClick={onClose}>
              Sluiten
            </button>
            {showGoToPlatform && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  router.push(platformHref!);
                  onClose();
                }}
              >
                Naar platform
              </button>
            )}
          </Actions>
        </div>
      )}
    </Modal>
  );
}

type AccountDraft = { id: number; label: string; enabled: boolean; remove: boolean };

export function EditConnectionModal({ conn, onClose, onDone }: { conn: ConnectionRow; onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const { data: settingsData, reloadOverview } = useSettings();
  const fmt = useFormat();
  const btcAmount = useBtcAmount();
  const isWallet = conn.provider === "bitcoin";
  const isEtoro = conn.provider === "etoro";
  const [f, setF] = useState({
    label: conn.label,
    accountType: (conn.accountType === "demo" ? "demo" : "real") as AccountType,
    receiptCost: (conn.receiptCost === "none" ? "none" : "market") as ReceiptCost,
    keySource: (conn.keys.shared ? "shared" : "own") as KeySource,
    apiKey: "",
    apiSecret: "",
  });
  const [accounts, setAccounts] = useState<AccountDraft[]>(conn.accounts.map((a) => ({ id: a.id, label: a.label, enabled: a.enabled, remove: false })));
  const [addText, setAddText] = useState("");
  const [addAll, setAddAll] = useState(false);
  const [addCandidates, setAddCandidates] = useState<DiscoverCandidate[] | null>(null);
  const [addSelected, setAddSelected] = useState<Set<string>>(new Set());
  const [addWarnings, setAddWarnings] = useState<string[]>([]);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSource, setAddSource] = useState<NodeSource | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  // Stappen die al gelukt zijn: na een fout halverwege slaat een nieuwe poging die over, en er volgt één herboeking.
  const done = useRef(new Set<string>());
  const rebookPending = useRef(false);
  const addCount = splitKeys(addText).filter((l) => l.trim()).length;

  const sharedKey = settingsData?.secrets.etoroApiKey;
  const sharedPresent = !!sharedKey?.present && !!settingsData?.secrets.etoroUserKey.present;
  const hasOwnKeys = !conn.keys.shared;

  // wat er verandert ten opzichte van de opgeslagen koppeling
  const label = f.label.trim();
  const connPatch: Record<string, string | true> = {};
  if (label && label !== conn.label) connPatch.label = label;
  if (isEtoro && f.accountType !== conn.accountType) connPatch.accountType = f.accountType;
  if (isWallet && f.receiptCost !== conn.receiptCost) connPatch.receiptCost = f.receiptCost;
  if (isEtoro && f.keySource === "shared") {
    if (hasOwnKeys) connPatch.useSharedKeys = true;
  } else if (!isWallet) {
    if (f.apiKey.trim()) connPatch.apiKey = f.apiKey.trim();
    if (f.apiSecret.trim()) connPatch.apiSecret = f.apiSecret.trim();
  }
  const rows = accounts.flatMap((a) => {
    const orig = conn.accounts.find((x) => x.id === a.id);
    return orig ? [{ a, orig }] : [];
  });
  const toggled = rows.filter(({ a, orig }) => !a.remove && a.enabled !== orig.enabled);
  const renamed = rows.filter(({ a, orig }) => !a.remove && a.label.trim() !== orig.label);
  const removed = rows.filter(({ a }) => a.remove);
  const toAdd = addCandidates && addSelected.size ? selectedAccounts(addText, addCandidates, addSelected) : [];
  // aan/uit, verwijderen en toevoegen bouwen de boekingen van de wallet opnieuw op: eerst bevestigen
  const affectsBookings = toggled.length > 0 || removed.length > 0 || toAdd.length > 0;
  const dirty = label !== conn.label || Object.keys(connPatch).length > 0 || renamed.length > 0 || affectsBookings;
  const rebookParts = [
    ...toggled.map(({ a, orig }) => `${a.label.trim() || orig.label} ${a.enabled ? "aan" : "uit"}`),
    ...removed.filter(({ orig }) => orig.enabled).map(({ orig }) => `${orig.label} verwijderd`),
    ...(toAdd.length ? [`${plural(toAdd.length, "account", "accounts")} toegevoegd`] : []),
  ];

  useEffect(() => {
    if (confirming) confirmRef.current?.scrollIntoView({ block: "nearest" });
  }, [confirming]);

  const updateAccount = (id: number, patch: Partial<AccountDraft>) => setAccounts((list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const validate = (): string | null => {
    if (!label) return "Geef de koppeling een naam.";
    if (accounts.some((a) => !a.remove && !a.label.trim())) return "Elk account heeft een naam nodig.";
    if (isEtoro && f.keySource === "own" && !hasOwnKeys && (!f.apiKey.trim() || !f.apiSecret.trim())) return "Vul beide eigen keys in (API Key en User Key).";
    // de eigen keys wissen zonder gedeelde set zou de koppeling (en de eToro-koersen) zonder keys laten
    if (isEtoro && f.keySource === "shared" && hasOwnKeys && !sharedPresent) return "Vul eerst de gedeelde keys in bij Koersen en planning, of houd de eigen keys.";
    return null;
  };

  const once = async (key: string, fn: () => Promise<void>) => {
    if (done.current.has(key)) return;
    await fn();
    done.current.add(key);
  };

  const resync = async () => {
    const s = await api<SyncReport>(`/api/connections/${conn.id}/sync`, { method: "POST" });
    rebookPending.current = false;
    toast(s.ok ? `Opnieuw geboekt: ${fmt.text(s.message)}` : `Sync mislukt: ${fmt.text(s.message)}`, s.ok ? "ok" : "error");
  };

  const save = async (confirmed: boolean) => {
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      setConfirming(false);
      return;
    }
    setError(null);
    if (affectsBookings && !confirmed) {
      setConfirming(true);
      return;
    }
    const base = `/api/connections/${conn.id}`;
    setBusy(true);
    try {
      if (Object.keys(connPatch).length) {
        await once(`conn:${JSON.stringify(connPatch)}`, async () => {
          await api(base, { method: "PATCH", json: connPatch });
        });
      }
      for (const { a, orig } of rows) {
        const nextLabel = a.label.trim();
        if (a.remove || (nextLabel === orig.label && a.enabled === orig.enabled)) continue;
        await once(`acc:${a.id}:${nextLabel}:${a.enabled}`, async () => {
          await api(`${base}/accounts/${a.id}`, { method: "PATCH", json: { label: nextLabel, enabled: a.enabled } });
          if (a.enabled !== orig.enabled) rebookPending.current = true;
        });
      }
      for (const { a, orig } of removed) {
        await once(`del:${a.id}`, async () => {
          const r = await api<{ rebooked: number }>(`${base}/accounts/${a.id}`, { method: "DELETE" });
          if (r.rebooked || orig.enabled) rebookPending.current = true;
        });
      }
      if (toAdd.length) {
        await once(`add:${JSON.stringify(toAdd)}`, async () => {
          const r = await api<{ added: number; skipped: number }>(`${base}/accounts`, { method: "POST", json: { accounts: toAdd } });
          if (r.skipped) toast(`${plural(r.skipped, "account was", "accounts waren")} al gekoppeld`);
          if (r.added) rebookPending.current = true;
        });
      }
      if (rebookPending.current) await resync();
      onDone();
      reloadOverview();
      onClose();
    } catch (e) {
      setError(errMsg(e));
      setConfirming(false);
      // deels opgeslagen: de lijst erachter alvast bijwerken
      if (done.current.size) onDone();
    } finally {
      setBusy(false);
    }
  };

  const discoverAdd = async () => {
    setDiscovering(true);
    setAddCandidates(null);
    setAddError(null);
    setAddSource(null);
    try {
      const { result, preselected } = await discoverKeys(addText, addAll);
      setAddCandidates(result.candidates);
      setAddWarnings(result.warnings);
      setAddSelected(preselected);
      setAddSource(result.source);
    } catch (e) {
      setAddError(errMsg(e));
    } finally {
      setDiscovering(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Koppeling bewerken">
      <div className="space-y-4">
        <Field label="Naam in meldingen" hint="Staat in meldingen en correctienotities.">
          <input className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
        </Field>

        {isEtoro && (
          <>
            <div>
              <span className="label">Omgeving</span>
              <Segmented value={f.accountType} options={ENV_OPTIONS} onChange={(v) => setF({ ...f, accountType: v })} label="Omgeving" />
            </div>
            <div className="space-y-2">
              <span className="label">Keys</span>
              <div className="grid gap-2 sm:grid-cols-2">
                <ChoiceCard selected={f.keySource === "shared"} onSelect={() => setF({ ...f, keySource: "shared" })} title="Gedeelde koers-keys (aanbevolen)">
                  {sharedPresent ? `••••${sharedKey?.last4} uit Koersen en planning` : "ontbreken — vul ze in bij Koersen en planning"}
                </ChoiceCard>
                <ChoiceCard selected={f.keySource === "own"} onSelect={() => setF({ ...f, keySource: "own" })} title="Eigen keys voor deze koppeling">
                  {hasOwnKeys && conn.keys.present ? `Nu ••••${conn.keys.last4}` : "Een aparte set keys, alleen voor deze koppeling."}
                </ChoiceCard>
              </div>
              {f.keySource === "shared" && !sharedPresent && (
                <Link href="/settings/koersen#koersbronnen" className="inline-block text-xs text-accent">
                  Naar Koersen en planning
                </Link>
              )}
              {f.keySource === "shared" && hasOwnKeys && <p className="text-xs text-muted">Bij Opslaan vervallen de eigen keys van deze koppeling.</p>}
              {f.keySource === "own" && (
                <>
                  <Field label="API Key" hint={hasOwnKeys ? "Leeg laten = ongewijzigd." : "Verplicht, net als de User Key."}>
                    <input className="input" type="password" autoComplete="off" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} />
                  </Field>
                  <Field label="User Key" hint={hasOwnKeys ? "Leeg laten = ongewijzigd." : "Verplicht, net als de API Key."}>
                    <input className="input" type="password" autoComplete="off" value={f.apiSecret} onChange={(e) => setF({ ...f, apiSecret: e.target.value })} />
                  </Field>
                </>
              )}
            </div>
          </>
        )}

        {conn.provider === "kraken" && (
          <div className="space-y-1">
            <span className="label">Keys</span>
            <p className="text-sm">{conn.keys.present ? <span className="font-mono">API Key ••••{conn.keys.last4}</span> : <span className="text-down">Geen key opgeslagen</span>}</p>
            <Disclosure summary="Keys vervangen" defaultOpen={!conn.keys.present}>
              <Field label="API Key" hint="Leeg laten = ongewijzigd.">
                <input className="input" type="password" autoComplete="off" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} />
              </Field>
              <Field label="Private Key" hint="Leeg laten = ongewijzigd.">
                <input className="input" type="password" autoComplete="off" value={f.apiSecret} onChange={(e) => setF({ ...f, apiSecret: e.target.value })} />
              </Field>
            </Disclosure>
          </div>
        )}

        {isWallet && (
          <>
            <div className="space-y-1.5">
              <span className="label">Accounts</span>
              <p className="text-xs text-muted">Uit = niet in het portfolio. Aan/uit, verwijderen en toevoegen bouwen de boekingen van deze wallet opnieuw op; dat gebeurt één keer, bij Opslaan.</p>
              <ul className="space-y-1.5">
                {accounts.map((a) => {
                  const row = conn.accounts.find((x) => x.id === a.id);
                  return (
                    <li key={a.id} className="rounded-lg bg-bg-elev p-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <Switch checked={a.enabled} onChange={(v) => updateAccount(a.id, { enabled: v })} label={`${a.label || "Account"} in het portfolio`} disabled={a.remove || busy} />
                        <input
                          className={`input min-w-0 flex-1 !py-1.5 ${a.remove ? "line-through opacity-60" : ""}`}
                          aria-label="Naam van het account"
                          value={a.label}
                          disabled={a.remove || busy}
                          onChange={(e) => updateAccount(a.id, { label: e.target.value })}
                        />
                        {a.remove ? (
                          <button type="button" className="tap shrink-0 rounded-lg px-1 text-xs font-semibold text-accent" disabled={busy} onClick={() => updateAccount(a.id, { remove: false })}>
                            Ongedaan maken
                          </button>
                        ) : (
                          <button type="button" className="tap shrink-0 rounded-lg px-1 text-xs text-muted hover:text-text" disabled={busy} onClick={() => updateAccount(a.id, { remove: true })}>
                            Verwijderen
                          </button>
                        )}
                      </div>
                      {row && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
                          {a.remove && <StatusBadge tone="warn">wordt verwijderd</StatusBadge>}
                          <span className={`min-w-0 break-words tnum ${a.remove ? "line-through" : ""}`}>
                            {SCRIPT_LABELS[row.scriptType]} · {btcAmount(row.balanceConfirmed)}
                            {nonZero(row.balanceUnconfirmed) ? ` (${Number(row.balanceUnconfirmed) > 0 ? "+" : ""}${btcAmount(row.balanceUnconfirmed)} onbevestigd)` : ""} · {row.txCount} tx · {row.receiveUsed} ontvangst- en {row.changeUsed} wisseladressen gebruikt
                            {row.lastScanAt ? ` · gescand ${formatDate(row.lastScanAt, true)}` : ""}
                          </span>
                        </div>
                      )}
                    </li>
                  );
                })}
                {accounts.length === 0 && <li className="text-xs text-muted">Geen accounts meer; voeg hieronder een key toe.</li>}
              </ul>
            </div>
            <Disclosure summary="Keys toevoegen">
              <div className="space-y-3 text-text">
                <KeysInput
                  text={addText}
                  allTypes={addAll}
                  onChange={(t, a) => {
                    setAddText(t);
                    setAddAll(a);
                    setAddCandidates(null);
                    setAddSource(null);
                  }}
                />
                <button type="button" className="btn btn-ghost !py-1.5 text-xs" disabled={discovering || busy || addCount === 0} onClick={() => void discoverAdd()}>
                  {discovering ? "Scannen…" : addCandidates ? "Opnieuw zoeken" : "Accounts zoeken"}
                </button>
                {addError && <Callout tone="down">{addError}</Callout>}
                <SourceNote source={addSource} />
                {addCandidates && <CandidateList candidates={addCandidates} selected={addSelected} onChange={setAddSelected} />}
                {addWarnings.length > 0 && (
                  <ul className="list-disc pl-4 text-xs text-warn">
                    {addWarnings.map((w, i) => (
                      <li key={i}>{fmt.text(w)}</li>
                    ))}
                  </ul>
                )}
                {addCandidates && addSelected.size > 0 && <p className="text-xs text-muted">{addSelected.size} geselecteerd; wordt toegevoegd bij Opslaan.</p>}
              </div>
            </Disclosure>
            <ReceiptCostField value={f.receiptCost} onChange={(v) => setF({ ...f, receiptCost: v })} />
          </>
        )}

        {error && <Callout tone="down">{error}</Callout>}

        {confirming && affectsBookings ? (
          <div ref={confirmRef} className="space-y-3">
            <Callout tone="warn">
              {rebookParts.length > 0 && (
                <p>
                  <b>Wordt opnieuw geboekt:</b> {rebookParts.join(" · ")}. De boekingen van deze wallet worden opnieuw opgebouwd en daarna één keer gesynct.
                </p>
              )}
              {removed.map(({ orig }) => (
                <p key={orig.id}>
                  De xpub van account <b>{orig.label}</b> wordt gewist.
                </p>
              ))}
            </Callout>
            <Actions>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>
                Terug
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void save(true)}>
                {busy ? "Bezig…" : "Bevestigen en opslaan"}
              </button>
            </Actions>
          </div>
        ) : (
          <Actions>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Annuleren
            </button>
            <button type="button" className="btn" disabled={busy || !dirty} onClick={() => void save(false)}>
              {busy ? "Bezig…" : "Opslaan"}
            </button>
          </Actions>
        )}
      </div>
    </Modal>
  );
}
