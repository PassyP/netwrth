"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Calculator, CalendarDays, ChevronDown, ChevronUp, Coins, Landmark, Shapes, X, type LucideIcon } from "lucide-react";
import { api, useApi, useApp } from "./app-state";
import { Field, Modal, useFormat } from "./ui";
import { AssetSearch, type SelectedAsset } from "./asset-search";
import { TX_TYPE_LABELS } from "@/lib/format";
import { TX_FIELD_ORDER, TX_GROUPS, TX_TYPE_HINTS, isMainType, isNonZero, parseDecimal, txAmounts, txLayout, txTotal, txVisible, validateTx, type StakeIn, type TxField, type TxKeep, type TxType } from "@/lib/tx-form";

/** Waarde van de optie "+ Nieuwe wallet toevoegen…" in de platformkeuze. */
const NEW_WALLET = "new-wallet";

/** Kortere knoptekst binnen de groep Overboeking; de schermlezer hoort het volledige label. */
const SHORT_LABELS: Partial<Record<TxType, string>> = { transfer_in: "In", transfer_out: "Uit" };

export interface TxDraft {
  id?: number;
  portfolioId: number | "";
  assetId: number | null;
  platformId: number | "";
  type: TxType;
  quantity: string;
  price: string;
  currency: string;
  fee: string;
  executedAt: string; // datetime-local
  note: string;
}

function nowLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function isoToLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function makeDraft(portfolioId: number | "", initialAsset?: SelectedAsset | null, initial?: Partial<TxDraft> | null): TxDraft {
  return {
    portfolioId,
    assetId: initialAsset?.id ?? null,
    platformId: "",
    type: "buy",
    quantity: "",
    price: "",
    currency: initialAsset?.currency ?? "USD",
    fee: "",
    executedAt: nowLocal(),
    note: "",
    ...initial,
  };
}

const ARROW_STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** Pijltjestoetsen in een radiogroep: vorige/volgende (rondlopend), Home en End; opties achter "Meer" tellen dicht niet mee. */
function onRadioKeys(e: React.KeyboardEvent<HTMLElement>) {
  if (!(e.key in ARROW_STEP) && e.key !== "Home" && e.key !== "End") return;
  const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')].filter((el) => !el.closest("[hidden]"));
  const i = radios.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  const n = radios.length;
  const next = radios[e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (i + ARROW_STEP[e.key] + n) % n];
  next.focus();
  next.click();
}

/** Eén kaart in het formulier: velden die bij elkaar horen, onder een kop. */
function Section({ title, icon: Icon, children, hidden = false }: { title: string; icon: LucideIcon; children: React.ReactNode; hidden?: boolean }) {
  const id = useId();
  return (
    <section aria-labelledby={id} hidden={hidden} className="rounded-xl bg-card-hover p-3">
      <h3 id={id} className="mb-2.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted">
        <Icon size={13} aria-hidden />
        {title}
      </h3>
      {children}
    </section>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="mt-1 text-xs text-down">
      {message}
    </p>
  ) : null;
}

/** Soort transactie in groepen; Handel en Geld staan open, Inkomsten en Overboeking achter "Meer". */
function TypePicker({ value, onChange, showMore, onToggleMore }: { value: TxType; onChange: (t: TxType) => void; showMore: boolean; onToggleMore: () => void }) {
  const moreId = useId();
  const hintId = useId();
  const row = (g: (typeof TX_GROUPS)[number]) => (
    <div key={g.label} className="grid gap-1.5 sm:grid-cols-[6rem_1fr] sm:items-center sm:gap-2">
      <span className="text-xs text-muted">{g.label}</span>
      <div className="flex flex-wrap gap-1.5">
        {g.types.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={value === t}
            aria-label={SHORT_LABELS[t] ? TX_TYPE_LABELS[t] : undefined}
            tabIndex={value === t ? 0 : -1}
            className="chip whitespace-nowrap"
            data-active={value === t}
            onClick={() => onChange(t)}
          >
            {SHORT_LABELS[t] ?? TX_TYPE_LABELS[t]}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <>
      <div role="radiogroup" aria-label="Soort transactie" aria-describedby={hintId} className="flex flex-col gap-2" onKeyDown={onRadioKeys}>
        {TX_GROUPS.filter((g) => g.main).map(row)}
        <div id={moreId} hidden={!showMore} className="flex flex-col gap-2">
          {TX_GROUPS.filter((g) => !g.main).map(row)}
        </div>
      </div>
      {/* dichtklappen kan niet zolang de gekozen soort achter "Meer" zit: dan zou hij uit beeld verdwijnen */}
      {isMainType(value) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 sm:pl-[6.5rem]">
          <button type="button" className="chip inline-flex items-center gap-1 !border-dashed" aria-expanded={showMore} aria-controls={moreId} onClick={onToggleMore}>
            {showMore ? "Minder" : "Meer"}
            {showMore ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
          </button>
          {!showMore && <span className="text-xs text-muted">Dividend, rente, staking, overboeking</span>}
        </div>
      )}
      <p id={hintId} className="mt-2.5 text-xs text-muted">
        {TX_TYPE_HINTS[value]}
      </p>
    </>
  );
}

export function TransactionForm({ open, onClose, onSaved, initial, initialAsset }: { open: boolean; onClose: () => void; onSaved: () => void; initial?: Partial<TxDraft> | null; initialAsset?: SelectedAsset | null }) {
  const { portfolioId, portfolios, toast } = useApp();
  const fmt = useFormat();
  const { data: platforms, reload: reloadPlatforms } = useApi<{ id: number; name: string }[]>(open ? "/api/platforms" : null);
  const [asset, setAsset] = useState<SelectedAsset | null>(initialAsset ?? null);
  const [saving, setSaving] = useState(false);
  // Eigen wallet toevoegen (Ledger, Trezor, kluis, …): de naam kies je zelf; daarna staat hij als platform in de lijst.
  const [addingWallet, setAddingWallet] = useState(false);
  const [newWallet, setNewWallet] = useState("");
  const [addingBusy, setAddingBusy] = useState(false);
  const [createdWallet, setCreatedWallet] = useState<{ id: number; name: string } | null>(null);
  const [d, setD] = useState<TxDraft>(() => makeDraft(portfolioId ?? portfolios[0]?.id ?? "", initialAsset, initial));
  // Indeling: "Meer" open, kosten- en notitieveld uitgeklapt, staking ontvangen als munt of geld, en welke bestaande
  // bedragen zichtbaar blijven (zie TxKeep).
  const [showMore, setShowMore] = useState(false);
  const [feeOpened, setFeeOpened] = useState(false);
  const [noteOpened, setNoteOpened] = useState(false);
  const [stakeIn, setStakeIn] = useState<StakeIn>("coin");
  const [keep, setKeep] = useState<TxKeep>({ price: false, fee: false });
  const [errors, setErrors] = useState<Partial<Record<TxField, string>>>({});
  const uid = useId();
  const fid = (name: string) => `${uid}-${name}`;
  // veld dat na de volgende render de focus krijgt (net uitgeklapt, of de eerste fout)
  const pendingFocus = useRef<string | null>(null);

  // Bij het openen alles opnieuw vullen, al tijdens het renderen: met een effect zou de eerste render nog de vorige
  // transactie tonen, en de asset-zoeker leest `initial` (en zijn autofocus) alleen bij het mounten.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const draft = makeDraft(portfolioId ?? portfolios[0]?.id ?? "", initialAsset, initial);
      setAsset(initialAsset ?? null);
      setAddingWallet(false);
      setNewWallet("");
      setCreatedWallet(null);
      setD(draft);
      setShowMore(!isMainType(draft.type));
      setFeeOpened(isNonZero(draft.fee));
      setNoteOpened(!!draft.note);
      setStakeIn(isNonZero(draft.quantity) || !isNonZero(draft.price) ? "coin" : "cash");
      setKeep({ price: isNonZero(draft.price), fee: isNonZero(draft.fee) });
      setErrors({});
    }
  }

  useEffect(() => {
    if (!platforms) return;
    if (platforms.length === 0) setAddingWallet(true); // nog geen enkel platform: meteen een wallet aanmaken
    else if (d.platformId === "") setD((x) => ({ ...x, platformId: platforms[0].id }));
  }, [platforms, d.platformId]);

  // de portfolio's laden los van dit venster: wie het meteen na het laden van de pagina opent, krijgt het eerste zodra het er is
  useEffect(() => {
    const first = portfolios.find((p) => !p.archived);
    if (open && d.portfolioId === "" && first) setD((x) => ({ ...x, portfolioId: first.id }));
  }, [open, portfolios, d.portfolioId]);

  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    pendingFocus.current = null;
    const el = document.getElementById(id);
    (el?.matches("input, select, textarea, button") ? el : el?.querySelector<HTMLElement>("input, select, textarea, button"))?.focus();
  });

  // De net aangemaakte wallet staat direct in de lijst, ook als /api/platforms nog niet opnieuw geladen is.
  const platformOptions = [...(platforms ?? []), ...(createdWallet && !platforms?.some((p) => p.id === createdWallet.id) ? [createdWallet] : [])];
  // de actieve portfolio's plus dat van de transactie zelf (ook als het gearchiveerd is); met één keuze geen veld
  const portfolioOptions = portfolios.filter((p) => !p.archived || p.id === d.portfolioId);
  const showPortfolio = portfolioOptions.length > 1;
  const platformLabel = d.type === "transfer_in" ? "Naar platform" : d.type === "transfer_out" ? "Van platform" : "Platform";

  const layout = txLayout(d.type, asset?.category, stakeIn);
  const visible = txVisible(layout, keep, feeOpened);
  const total = txTotal(d.type, visible, d);
  const qty = parseDecimal(d.quantity);
  const price = parseDecimal(d.price);
  // bedrag in de samenvatting: het totaal, of het ingevulde bedrag van een soort zonder aantal (nooit een losse prijs per stuk)
  const amount = total ? total.value : layout.price && !visible.quantity && price?.gt(0) ? price : null;
  const summary = [
    TX_TYPE_LABELS[d.type],
    layout.asset && asset ? `${visible.quantity && qty?.gt(0) ? `${fmt.qty(qty)} ` : ""}${asset.symbol}` : null,
    amount ? fmt.money(amount, d.currency) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const clearError = (field: TxField) => {
    if (!errors[field]) return;
    setErrors((e) => {
      const next = { ...e };
      delete next[field];
      return next;
    });
  };
  const setAmount = (field: "quantity" | "price" | "fee" | "executedAt", value: string) => {
    setD((x) => ({ ...x, [field]: value }));
    clearError(field);
  };
  const errorProps = (field: TxField) => (errors[field] ? { "aria-invalid": true, "aria-describedby": fid(`${field}-error`) } : {});
  const inputClass = (field: TxField) => `input ${errors[field] ? "!border-down" : ""}`;
  const revealAndFocus = (name: string, reveal: () => void) => {
    reveal();
    pendingFocus.current = fid(name);
  };

  const chooseType = (type: TxType) => {
    setD((x) => ({ ...x, type }));
    setErrors({});
  };

  const save = async () => {
    const found = validateTx({ layout, visible, hasAsset: !!asset, hasPlatform: d.platformId !== "", addingWallet, quantity: d.quantity, price: d.price, fee: d.fee, executedAt: d.executedAt });
    setErrors(found);
    const first = TX_FIELD_ORDER.find((f) => found[f]);
    if (first) {
      pendingFocus.current = fid(first === "platform" && addingWallet ? "wallet" : first);
      return;
    }
    setSaving(true);
    try {
      const payload = {
        portfolioId: d.portfolioId,
        assetId: layout.asset ? asset?.id ?? null : null,
        platformId: d.platformId,
        type: d.type,
        ...txAmounts(layout, visible, d),
        currency: d.currency,
        executedAt: new Date(d.executedAt).toISOString(),
        note: d.note.trim() || null,
      };
      if (d.id) await api(`/api/transactions/${d.id}`, { method: "PATCH", json: payload });
      else await api("/api/transactions", { method: "POST", json: payload });
      toast(d.id ? "Transactie bijgewerkt" : "Transactie opgeslagen");
      onSaved();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const addWallet = async () => {
    const name = newWallet.trim();
    if (!name || addingBusy) return;
    setAddingBusy(true);
    try {
      const p = await api<{ id: number; name: string }>("/api/platforms", { method: "POST", json: { name, type: "wallet" } });
      setCreatedWallet(p);
      setNewWallet("");
      setAddingWallet(false);
      setD((x) => ({ ...x, platformId: p.id }));
      clearError("platform");
      pendingFocus.current = fid("platform"); // het walletveld verdwijnt: focus naar de keuzelijst waarin hij nu staat
      reloadPlatforms();
      toast(`Wallet "${p.name}" toegevoegd`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setAddingBusy(false);
    }
  };

  const cancelWallet = () => {
    setAddingWallet(false);
    setNewWallet("");
    clearError("platform");
    pendingFocus.current = fid("platform");
  };

  const footer = (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p className="min-w-0 truncate text-xs text-muted">{summary}</p>
      <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex">
        <button className="btn btn-ghost" onClick={onClose}>
          Annuleren
        </button>
        <button className="btn" disabled={saving} onClick={() => void save()}>
          {saving ? "Opslaan…" : "Opslaan"}
        </button>
      </div>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title={d.id ? "Transactie bewerken" : "Transactie toevoegen"} footer={footer}>
      <div className="space-y-2.5">
        <Section title="Soort" icon={Shapes}>
          <TypePicker value={d.type} onChange={chooseType} showMore={showMore} onToggleMore={() => setShowMore((v) => !v)} />
        </Section>

        {/* verborgen in plaats van weg: anders pakt de autofocus van de zoeker de focus bij elke wissel naar een soort met asset */}
        <Section title="Wat" icon={Coins} hidden={!layout.asset}>
          <div id={fid("asset")}>
            <AssetSearch
              initial={asset}
              onSelect={(a) => {
                setAsset(a);
                setD((x) => ({ ...x, assetId: a.id, currency: a.currency }));
                clearError("asset");
              }}
            />
          </div>
          <FieldError id={fid("asset-error")} message={errors.asset} />
        </Section>

        <Section title="Waar" icon={Landmark}>
          {(showPortfolio || platformOptions.length > 0) && (
            <div className={`grid gap-2 ${showPortfolio && platformOptions.length > 0 ? "grid-cols-2" : ""}`}>
              {showPortfolio && (
                <Field label="Portfolio">
                  <select className="input" value={d.portfolioId} onChange={(e) => setD({ ...d, portfolioId: Number(e.target.value) })}>
                    {portfolioOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.archived ? `${p.name} (gearchiveerd)` : p.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {platformOptions.length > 0 && (
                <Field label={platformLabel}>
                  <select
                    id={fid("platform")}
                    className={addingWallet ? "input" : inputClass("platform")}
                    {...(addingWallet ? {} : errorProps("platform"))}
                    value={addingWallet ? NEW_WALLET : d.platformId}
                    onChange={(e) => {
                      if (e.target.value === NEW_WALLET) {
                        revealAndFocus("wallet", () => setAddingWallet(true));
                      } else {
                        setAddingWallet(false);
                        setD({ ...d, platformId: Number(e.target.value) });
                        clearError("platform");
                      }
                    }}
                  >
                    {platformOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                    <option value={NEW_WALLET}>+ Nieuwe wallet toevoegen…</option>
                  </select>
                </Field>
              )}
            </div>
          )}
          {addingWallet && (
            <div className={showPortfolio || platformOptions.length > 0 ? "mt-3" : ""}>
              <label className="label" htmlFor={fid("wallet")}>
                Nieuwe wallet
              </label>
              <div className="flex gap-2">
                <input
                  id={fid("wallet")}
                  className={inputClass("platform")}
                  {...errorProps("platform")}
                  placeholder="Naam, bijv. Ledger, Trezor of Kluis"
                  value={newWallet}
                  onChange={(e) => setNewWallet(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addWallet();
                    }
                  }}
                />
                <button className="btn whitespace-nowrap" disabled={addingBusy || !newWallet.trim()} onClick={() => void addWallet()}>
                  {addingBusy ? "Toevoegen…" : "Toevoegen"}
                </button>
                {platformOptions.length > 0 && (
                  <button className="btn btn-ghost" aria-label="Geen wallet toevoegen" title="Geen wallet toevoegen" onClick={cancelWallet}>
                    <X size={16} />
                  </button>
                )}
              </div>
              <span className="mt-1 block text-xs text-muted">Een eigen plek voor je bezit, bijv. een hardware wallet, kluis of bankrekening. Staat daarna bij elke transactie in de platformlijst.</span>
            </div>
          )}
          <FieldError id={fid("platform-error")} message={errors.platform} />
        </Section>

        {(visible.quantity || visible.price || visible.fee || layout.stakeChoice) && (
          <Section title="Bedrag" icon={Calculator}>
            {layout.stakeChoice && asset && (
              <div role="radiogroup" aria-labelledby={fid("stake-label")} className="mb-3 flex flex-wrap items-center gap-1.5" onKeyDown={onRadioKeys}>
                <span id={fid("stake-label")} className="mr-1 text-xs text-muted">
                  Ontvangen als
                </span>
                {(["coin", "cash"] as const).map((s) => (
                  <button key={s} type="button" role="radio" aria-checked={stakeIn === s} tabIndex={stakeIn === s ? 0 : -1} className="chip" data-active={stakeIn === s} onClick={() => setStakeIn(s)}>
                    {s === "coin" ? asset.symbol : "Geld"}
                  </button>
                ))}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {visible.quantity && (
                <div>
                  <Field label={`Aantal${asset ? ` ${asset.symbol}` : ""}`}>
                    <input id={fid("quantity")} className={inputClass("quantity")} {...errorProps("quantity")} inputMode="decimal" value={d.quantity} onChange={(e) => setAmount("quantity", e.target.value)} placeholder="0,5" />
                  </Field>
                  <FieldError id={fid("quantity-error")} message={errors.quantity} />
                </div>
              )}
              {visible.price && (
                <div>
                  <Field label={layout.priceLabel} hint={layout.priceHint ?? undefined}>
                    <span className="flex gap-2">
                      <input id={fid("price")} className={`${inputClass("price")} min-w-0 flex-1`} {...errorProps("price")} inputMode="decimal" value={d.price} onChange={(e) => setAmount("price", e.target.value)} placeholder="0,00" />
                      <select className="input !w-24 shrink-0" aria-label="Valuta" value={d.currency} onChange={(e) => setD({ ...d, currency: e.target.value })}>
                        {["EUR", "USD", "CHF", "GBP"].map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </span>
                  </Field>
                  <FieldError id={fid("price-error")} message={errors.price} />
                </div>
              )}
              {visible.fee && (
                <div>
                  <Field label={`${layout.feeLabel} (${d.currency})`}>
                    <input id={fid("fee")} className={inputClass("fee")} {...errorProps("fee")} inputMode="decimal" value={d.fee} onChange={(e) => setAmount("fee", e.target.value)} placeholder="0" />
                  </Field>
                  <FieldError id={fid("fee-error")} message={errors.fee} />
                </div>
              )}
            </div>
            {layout.fee === "link" && !feeOpened && (
              <button type="button" className="mt-2 text-xs font-semibold text-accent" onClick={() => revealAndFocus("fee", () => setFeeOpened(true))}>
                + Kosten toevoegen
              </button>
            )}
            {total && (
              <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-border pt-2 text-sm">
                <span className="text-muted">{total.label}</span>
                <span className="tnum font-semibold">{total.value ? fmt.money(total.value, d.currency) : "–"}</span>
              </div>
            )}
          </Section>
        )}

        <Section title="Wanneer" icon={CalendarDays}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Field label="Datum en tijd">
                <input id={fid("executedAt")} className={inputClass("executedAt")} {...errorProps("executedAt")} type="datetime-local" value={d.executedAt} onChange={(e) => setAmount("executedAt", e.target.value)} />
              </Field>
              <FieldError id={fid("executedAt-error")} message={errors.executedAt} />
            </div>
            {noteOpened && (
              <Field label="Notitie">
                <input id={fid("note")} className="input" maxLength={1000} value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} placeholder="optioneel" />
              </Field>
            )}
          </div>
          {!noteOpened && (
            <button type="button" className="mt-2 text-xs font-semibold text-accent" onClick={() => revealAndFocus("note", () => setNoteOpened(true))}>
              + Notitie toevoegen
            </button>
          )}
        </Section>
      </div>
    </Modal>
  );
}
