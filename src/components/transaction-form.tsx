"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api, useApi, useApp } from "./app-state";
import { Field, Modal } from "./ui";
import { AssetSearch, type SelectedAsset } from "./asset-search";
import { TX_TYPE_LABELS } from "@/lib/format";

const TYPES = ["buy", "sell", "dividend", "interest", "staking", "fee", "deposit", "withdrawal", "transfer_in", "transfer_out"] as const;
type TxType = (typeof TYPES)[number];

/** Waarde van de optie "+ Nieuwe wallet toevoegen…" in de platformkeuze. */
const NEW_WALLET = "new-wallet";

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

export function TransactionForm({ open, onClose, onSaved, initial, initialAsset }: { open: boolean; onClose: () => void; onSaved: () => void; initial?: Partial<TxDraft> | null; initialAsset?: SelectedAsset | null }) {
  const { portfolioId, portfolios, toast } = useApp();
  const { data: platforms, reload: reloadPlatforms } = useApi<{ id: number; name: string }[]>(open ? "/api/platforms" : null);
  const [asset, setAsset] = useState<SelectedAsset | null>(initialAsset ?? null);
  const [saving, setSaving] = useState(false);
  // Eigen wallet toevoegen (Ledger, Trezor, kluis, …): de naam kies je zelf; daarna staat hij als platform in de lijst.
  const [addingWallet, setAddingWallet] = useState(false);
  const [newWallet, setNewWallet] = useState("");
  const [addingBusy, setAddingBusy] = useState(false);
  const [createdWallet, setCreatedWallet] = useState<{ id: number; name: string } | null>(null);
  const [d, setD] = useState<TxDraft>({
    portfolioId: portfolioId ?? portfolios[0]?.id ?? "",
    assetId: initialAsset?.id ?? null,
    platformId: "",
    type: "buy",
    quantity: "",
    price: "",
    currency: initialAsset?.currency ?? "USD",
    fee: "0",
    executedAt: nowLocal(),
    note: "",
    ...initial,
  });

  useEffect(() => {
    if (!open) return;
    setAsset(initialAsset ?? null);
    setAddingWallet(false);
    setNewWallet("");
    setCreatedWallet(null);
    setD({
      portfolioId: portfolioId ?? portfolios[0]?.id ?? "",
      assetId: initialAsset?.id ?? null,
      platformId: "",
      type: "buy",
      quantity: "",
      price: "",
      currency: initialAsset?.currency ?? "USD",
      fee: "0",
      executedAt: nowLocal(),
      note: "",
      ...initial,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!platforms) return;
    if (platforms.length === 0) setAddingWallet(true); // nog geen enkel platform: meteen een wallet aanmaken
    else if (d.platformId === "") setD((x) => ({ ...x, platformId: platforms[0].id }));
  }, [platforms, d.platformId]);

  // De net aangemaakte wallet staat direct in de lijst, ook als /api/platforms nog niet opnieuw geladen is.
  const platformOptions = [...(platforms ?? []), ...(createdWallet && !platforms?.some((p) => p.id === createdWallet.id) ? [createdWallet] : [])];

  const needsAsset = ["buy", "sell", "dividend", "interest", "staking", "transfer_in", "transfer_out"].includes(d.type);
  const needsQty = ["buy", "sell", "transfer_in", "transfer_out"].includes(d.type) || (d.type === "staking" && asset?.category === "crypto");
  const isAmount = !["buy", "sell", "transfer_in", "transfer_out"].includes(d.type);
  const isRealEstate = asset?.category === "real_estate";

  const save = async () => {
    setSaving(true);
    try {
      if (addingWallet) throw new Error("Voeg de nieuwe wallet eerst toe, of kies een bestaand platform.");
      if (d.platformId === "") throw new Error("Kies een platform of voeg een wallet toe.");
      if (needsAsset && !asset) throw new Error("Kies eerst een asset.");
      const payload = {
        portfolioId: d.portfolioId,
        assetId: needsAsset ? asset?.id ?? null : null,
        platformId: d.platformId,
        type: d.type,
        quantity: needsQty ? (isRealEstate ? "1" : d.quantity) : "0",
        price: d.price || "0",
        currency: d.currency,
        fee: d.fee || "0",
        executedAt: new Date(d.executedAt).toISOString(),
        note: d.note || null,
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
  };

  return (
    <Modal open={open} onClose={onClose} title={d.id ? "Transactie bewerken" : "Transactie toevoegen"}>
      <div className="space-y-3">
        <div className="scroll-x flex gap-1">
          {TYPES.map((t) => (
            <button key={t} className="pill whitespace-nowrap" data-active={d.type === t} onClick={() => setD({ ...d, type: t })}>
              {TX_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Portfolio">
            <select className="input" value={d.portfolioId} onChange={(e) => setD({ ...d, portfolioId: Number(e.target.value) })}>
              {portfolios.filter((p) => !p.archived).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Platform">
            <select
              className="input"
              value={addingWallet ? NEW_WALLET : d.platformId}
              onChange={(e) => {
                if (e.target.value === NEW_WALLET) {
                  setAddingWallet(true);
                } else {
                  setAddingWallet(false);
                  setD({ ...d, platformId: Number(e.target.value) });
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
        </div>
        {addingWallet && (
          <div>
            <span className="label">Nieuwe wallet</span>
            <div className="flex gap-2">
              <input
                className="input"
                autoFocus
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
        {needsAsset && (
          <Field label="Asset">
            <AssetSearch
              initial={asset}
              onSelect={(a) => {
                setAsset(a);
                setD((x) => ({ ...x, assetId: a.id, currency: a.currency }));
              }}
            />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {needsQty && !isRealEstate && (
            <Field label="Aantal">
              <input className="input" inputMode="decimal" value={d.quantity} onChange={(e) => setD({ ...d, quantity: e.target.value })} placeholder="0,5" />
            </Field>
          )}
          <Field label={isRealEstate ? "Aankoopprijs" : isAmount ? "Bedrag" : "Prijs per stuk"}>
            <input className="input" inputMode="decimal" value={d.price} onChange={(e) => setD({ ...d, price: e.target.value })} placeholder="0,00" />
          </Field>
          <Field label="Valuta">
            <select className="input" value={d.currency} onChange={(e) => setD({ ...d, currency: e.target.value })}>
              {["EUR", "USD", "CHF", "GBP"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label={isRealEstate ? "Aankoopkosten" : "Kosten"}>
            <input className="input" inputMode="decimal" value={d.fee} onChange={(e) => setD({ ...d, fee: e.target.value })} placeholder="0" />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="Datum en tijd">
            <input className="input" type="datetime-local" value={d.executedAt} onChange={(e) => setD({ ...d, executedAt: e.target.value })} />
          </Field>
          <Field label="Notitie">
            <input className="input" value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} placeholder="optioneel" />
          </Field>
        </div>
        {d.type === "staking" && asset?.category === "crypto" && <p className="text-xs text-muted">Staking in de munt zelf: vul het aantal in en laat het bedrag op 0. Staking in cash: aantal 0 en het bedrag.</p>}
        {d.type === "transfer_in" && <p className="text-xs text-muted">Overboeking naar dit platform: prijs = je oorspronkelijke kostprijs per stuk (of de marktprijs als je die niet weet). Geen winst/verlies.</p>}
        {d.type === "transfer_out" && <p className="text-xs text-muted">Overboeking weg van dit platform: alleen het aantal; er wordt geen winst/verlies geboekt.</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn btn-ghost" onClick={onClose}>
            Annuleren
          </button>
          <button className="btn" disabled={saving} onClick={() => void save()}>
            {saving ? "Opslaan…" : "Opslaan"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
