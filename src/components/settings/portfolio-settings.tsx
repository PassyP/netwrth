"use client";

/**
 * /settings/portfolios: dezelfde lijst als de portfoliokiezer in de navigatie. Toevoegen en hernoemen gebeuren inline in de
 * lijst; archiveren haalt een portfolio uit de kiezer maar laat de gegevens staan. Verwijderen kan alleen bij een
 * gearchiveerd portfolio zonder transacties en koppelingen (de server weigert het met transacties; een koppeling
 * verwijst ernaar).
 */
import { useState } from "react";
import { Archive, ArchiveRestore, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { api, useApi, useApp } from "../app-state";
import { Card, Skeleton } from "../ui";
import { SettingsPageHeader, SettingsStack, useScrollToHash, useSettings } from "./context";
import { Callout, ConfirmDialog, Disclosure, StatusBadge } from "./ui";

interface PortfolioRow {
  id: number;
  name: string;
  description: string | null;
  archived: boolean;
  createdAt: string;
  txCount: number;
  connectionCount: number;
}

const MAX_NAME = 100; // zelfde grens als de API

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** "12 transacties · 1 koppeling", of "Nog leeg". */
function usage(p: PortfolioRow): string {
  const parts = [p.txCount ? plural(p.txCount, "transactie", "transacties") : null, p.connectionCount ? plural(p.connectionCount, "koppeling", "koppelingen") : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nog leeg";
}

const TEXT_BUTTON = "tap flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted";

type Draft = { name: string; error: string | null };

export function PortfolioSettings() {
  const { toast, bump, reloadPortfolios, portfolioId, setPortfolioId } = useApp();
  const { reloadOverview } = useSettings();
  const { data, error, reload } = useApi<PortfolioRow[]>("/api/portfolios");
  const [adding, setAdding] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<(Draft & { id: number }) | null>(null);
  const [dialog, setDialog] = useState<{ kind: "archive" | "delete"; p: PortfolioRow } | null>(null);
  const [busy, setBusy] = useState(false);
  useScrollToHash(!!data);

  // de lijst hier, de portfoliokiezer, alle cijfers (bump) en de samenvatting op /settings
  const refresh = () => {
    reload();
    void reloadPortfolios();
    bump();
    reloadOverview();
  };

  const nameError = (name: string, exceptId?: number): string | null => {
    if (!name) return "Geef het portfolio een naam.";
    if (name.length > MAX_NAME) return `Hooguit ${MAX_NAME} tekens.`;
    if (data?.some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase())) return "Er is al een portfolio met deze naam.";
    return null;
  };

  const startAdding = () => {
    setEditing(null);
    setAdding({ name: "", error: null });
  };

  const startEditing = (p: PortfolioRow) => {
    setAdding(null);
    setEditing({ id: p.id, name: p.name, error: null });
  };

  const add = async () => {
    if (!adding || busy) return;
    const name = adding.name.trim();
    const err = nameError(name);
    if (err) {
      setAdding({ ...adding, error: err });
      return;
    }
    setBusy(true);
    try {
      await api("/api/portfolios", { method: "POST", json: { name } });
      setAdding(null);
      toast(`Portfolio “${name}” toegevoegd`);
      refresh();
    } catch (e) {
      setAdding((a) => a && { ...a, error: messageOf(e) });
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (!editing || busy) return;
    const current = data?.find((p) => p.id === editing.id);
    const name = editing.name.trim();
    if (!current || name === current.name) {
      setEditing(null);
      return;
    }
    const err = nameError(name, current.id);
    if (err) {
      setEditing({ ...editing, error: err });
      return;
    }
    setBusy(true);
    try {
      await api(`/api/portfolios/${current.id}`, { method: "PATCH", json: { name } });
      setEditing(null);
      toast(`“${current.name}” heet nu “${name}”`);
      refresh();
    } catch (e) {
      setEditing((ed) => ed && { ...ed, error: messageOf(e) });
    } finally {
      setBusy(false);
    }
  };

  const setArchived = async (p: PortfolioRow, archived: boolean) => {
    setBusy(true);
    try {
      await api(`/api/portfolios/${p.id}`, { method: "PATCH", json: { archived } });
      // de kiezer toont een gearchiveerd portfolio niet meer; blijft het geselecteerd, dan filtert de app op iets onzichtbaars
      if (archived && portfolioId === p.id) setPortfolioId(null);
      toast(archived ? `Portfolio “${p.name}” gearchiveerd` : `Portfolio “${p.name}” hersteld`);
      refresh();
    } catch (e) {
      toast(messageOf(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: PortfolioRow) => {
    setBusy(true);
    try {
      await api(`/api/portfolios/${p.id}`, { method: "DELETE" });
      if (portfolioId === p.id) setPortfolioId(null);
      toast(`Portfolio “${p.name}” verwijderd`);
      refresh();
    } catch (e) {
      toast(messageOf(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const archive = (p: PortfolioRow) => {
    if (p.connectionCount > 0) setDialog({ kind: "archive", p });
    else void setArchived(p, true);
  };

  if (!data) {
    return (
      <div className="space-y-4">
        <SettingsPageHeader category="portfolios" />
        {error ? <Callout tone="down">Portfolios laden mislukt: {error}</Callout> : <Skeleton className="h-56" />}
      </div>
    );
  }

  const active = data.filter((p) => !p.archived);
  const archived = data.filter((p) => p.archived);
  const lastActive = active.length <= 1;

  return (
    <div className="space-y-4">
      <SettingsPageHeader category="portfolios" />
      <SettingsStack>
        <Card
          title="Portfolios"
          id="portfolios"
          description="Kies ze in de portfoliokiezer in de navigatie. Een gearchiveerd portfolio verdwijnt daaruit; de gegevens blijven."
          action={
            <button type="button" className="btn btn-ghost flex items-center gap-1 !py-1.5 text-xs" disabled={!!adding} onClick={startAdding}>
              <Plus size={14} /> Nieuw portfolio
            </button>
          }
        >
          <ul className="space-y-1">
            {adding && (
              <li className="rounded-xl bg-bg-elev px-3 py-2.5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    className={`input min-w-0 !py-1.5 sm:flex-1 ${adding.error ? "!border-down" : ""}`}
                    autoFocus
                    maxLength={MAX_NAME}
                    placeholder="Naam, bijv. Pensioen of Speculatief"
                    aria-label="Naam van het nieuwe portfolio"
                    aria-invalid={!!adding.error}
                    value={adding.name}
                    onChange={(e) => setAdding({ name: e.target.value, error: null })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void add();
                      }
                      if (e.key === "Escape") setAdding(null);
                    }}
                  />
                  <div className="flex shrink-0 gap-2">
                    <button type="button" className="btn flex-1 !py-1.5 text-xs sm:flex-none" disabled={busy || !adding.name.trim()} onClick={() => void add()}>
                      Toevoegen
                    </button>
                    <button type="button" className="btn btn-ghost flex-1 !py-1.5 text-xs sm:flex-none" disabled={busy} onClick={() => setAdding(null)}>
                      Annuleren
                    </button>
                  </div>
                </div>
                {adding.error && <p className="mt-1.5 text-xs text-down">{adding.error}</p>}
              </li>
            )}
            {active.map((p) => {
              const isEditing = editing?.id === p.id;
              return (
                <li key={p.id} className="flex items-center justify-between gap-2 rounded-xl bg-bg-elev px-3 py-2.5 text-sm">
                  {isEditing ? (
                    <div className="min-w-0 flex-1">
                      <input
                        className={`input !py-1 ${editing.error ? "!border-down" : ""}`}
                        autoFocus
                        maxLength={MAX_NAME}
                        aria-label={`Nieuwe naam voor ${p.name}`}
                        aria-invalid={!!editing.error}
                        value={editing.name}
                        onChange={(e) => setEditing({ id: p.id, name: e.target.value, error: null })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void rename();
                          }
                          if (e.key === "Escape") setEditing(null);
                        }}
                      />
                      {editing.error && <p className="mt-1 text-xs text-down">{editing.error}</p>}
                    </div>
                  ) : (
                    <div className="min-w-0">
                      <div className="break-words font-medium">{p.name}</div>
                      <div className="text-xs text-muted">{usage(p)}</div>
                    </div>
                  )}
                  <div className="flex shrink-0 items-center gap-1">
                    {isEditing ? (
                      <>
                        <button type="button" className="btn !px-2 !py-1 text-xs" disabled={busy || !editing.name.trim()} onClick={() => void rename()} aria-label="Nieuwe naam opslaan" title="Opslaan">
                          <Check size={14} />
                        </button>
                        <button type="button" className="btn btn-ghost !px-2 !py-1 text-xs" onClick={() => setEditing(null)} aria-label="Hernoemen annuleren" title="Annuleren">
                          <X size={14} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className={TEXT_BUTTON} disabled={busy} onClick={() => startEditing(p)} aria-label={`${p.name} hernoemen`} title="Hernoemen">
                          <Pencil size={14} /> <span className="hidden sm:inline">Hernoemen</span>
                        </button>
                        <button
                          type="button"
                          className={TEXT_BUTTON}
                          disabled={busy || lastActive}
                          onClick={() => archive(p)}
                          aria-label={`${p.name} archiveren`}
                          title={lastActive ? "Er moet minstens één actief portfolio zijn" : "Archiveren"}
                        >
                          <Archive size={14} /> <span className="hidden sm:inline">Archiveren</span>
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
            {active.length === 0 && !adding && <li className="px-3 py-2 text-sm text-muted">Geen actieve portfolios. Herstel er een of maak een nieuw portfolio.</li>}
          </ul>

          {archived.length > 0 && (
            <Disclosure summary={`Gearchiveerd (${archived.length})`} className="mt-3">
              <ul className="space-y-1">
                {archived.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 rounded-xl bg-bg-elev px-3 py-2.5 text-sm text-text">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="break-words font-medium">{p.name}</span>
                        <StatusBadge tone="neutral">Gearchiveerd</StatusBadge>
                      </div>
                      <div className="text-xs text-muted">{usage(p)}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button type="button" className={TEXT_BUTTON} disabled={busy} onClick={() => void setArchived(p, false)} aria-label={`${p.name} herstellen`} title="Herstellen">
                        <ArchiveRestore size={14} /> <span className="hidden sm:inline">Herstellen</span>
                      </button>
                      {p.txCount === 0 && p.connectionCount === 0 && (
                        <button type="button" className={TEXT_BUTTON} disabled={busy} onClick={() => setDialog({ kind: "delete", p })} aria-label={`${p.name} verwijderen`} title="Verwijderen">
                          <Trash2 size={14} /> <span className="hidden sm:inline">Verwijderen</span>
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </Card>
      </SettingsStack>

      {dialog?.kind === "archive" && (
        <ConfirmDialog
          open
          title={`Portfolio “${dialog.p.name}” archiveren?`}
          confirmLabel="Archiveren"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await setArchived(dialog.p, true);
            setDialog(null);
          }}
        >
          <p>{plural(dialog.p.connectionCount, "koppeling blijft", "koppelingen blijven")} erin boeken; het portfolio verdwijnt uit de portfoliokiezer en de koppelingswizard.</p>
        </ConfirmDialog>
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          open
          tone="danger"
          title={`Portfolio “${dialog.p.name}” verwijderen?`}
          confirmLabel="Verwijderen"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await remove(dialog.p);
            setDialog(null);
          }}
        >
          <p>Het portfolio heeft geen transacties; verwijderen kan niet ongedaan worden.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
