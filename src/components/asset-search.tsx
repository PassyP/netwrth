"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { api, useApp } from "./app-state";
import { AssetLogo } from "./ui";
import { CATEGORY_LABELS, PRICE_SOURCE_LABELS } from "@/lib/format";

export interface Candidate {
  source: "local" | "etoro" | "yahoo" | "kraken";
  symbol: string;
  name: string;
  currency: string;
  sourceId: string | null;
  exchange: string | null;
  type: string | null;
  logoUrl: string | null;
  categoryGuess: string;
  assetId?: number;
  /** Gezet op een crypto-kandidaat (Kraken, eToro, Yahoo) als er al een crypto-asset met dit symbool bestaat: bevestigen zet dat asset op deze koersbron in plaats van een nieuw asset aan te maken. */
  existingAssetId?: number;
  /** Het bestaande asset volgt deze bron al: kiezen selecteert gewoon dat asset. */
  current?: boolean;
}

/** Bronlabel in de zoekresultaten: lokaal asset, anders de naam van de koersbron. */
function sourceLabel(source: Candidate["source"]): string {
  return source === "local" ? "al in je lijst" : PRICE_SOURCE_LABELS[source];
}

/** Bij Kraken en Yahoo-crypto is de valuta die van het paar (de koers), niet die van het asset: crypto-assets staan in USD genoteerd. */
function currencyLabel(c: Candidate): string {
  return c.source === "kraken" || (c.source === "yahoo" && c.categoryGuess === "crypto") ? `koers in ${c.currency}` : c.currency;
}

/** Badge bij een crypto-kandidaat die naar een bestaand asset wijst: bron wisselen, of de bron die het asset al volgt. */
function existingBadge(c: Candidate): string {
  return c.current ? "bestaand asset · huidige koersbron" : `bestaand asset · koers via ${sourceLabel(c.source)} volgen`;
}

export interface SelectedAsset {
  id: number;
  symbol: string;
  name: string;
  currency: string;
  category: string;
  logoUrl: string | null;
}

const CATEGORIES = ["crypto", "stock", "etf", "commodity", "real_estate"] as const;

/** Zoekt lokaal, via eToro, Kraken en Yahoo; maakt zo nodig het asset aan (of zet een bestaand crypto-asset op Kraken) en geeft het gekozen asset terug. */
export function AssetSearch({ onSelect, initial }: { onSelect: (a: SelectedAsset) => void; initial?: SelectedAsset | null }) {
  const { toast } = useApp();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false); // POST /api/assets loopt: knoppen uit tegen dubbel indienen
  const [results, setResults] = useState<Candidate[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<SelectedAsset | null>(initial ?? null);
  const [pending, setPending] = useState<Candidate | null>(null);
  const [category, setCategory] = useState<string>("stock");
  const [mode, setMode] = useState<"search" | "manual">("search");
  const [manual, setManual] = useState({ symbol: "", name: "", currency: "EUR", category: "real_estate" as string });

  useEffect(() => {
    if (!q.trim() || q.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await api<{ candidates: Candidate[]; errors: string[] }>(`/api/assets/search?q=${encodeURIComponent(q.trim())}`);
        setResults(r.candidates);
        setErrors(r.errors);
      } catch (e) {
        setErrors([e instanceof Error ? e.message : String(e)]);
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const choose = async (c: Candidate) => {
    // de bron die het bestaande asset al volgt: niets in te stellen, gewoon dat asset kiezen (de lokale rij staat altijd in de lijst)
    const local = c.source === "local" ? c : c.current ? results.find((r) => r.source === "local" && r.assetId === c.existingAssetId) : undefined;
    if (local?.assetId) {
      const a = { id: local.assetId, symbol: local.symbol, name: local.name, currency: local.currency, category: local.categoryGuess, logoUrl: local.logoUrl };
      setSelected(a);
      onSelect(a);
      return;
    }
    setPending(c);
    setCategory(c.categoryGuess);
  };

  /** Serverafwijzingen (bestaand crypto-asset zonder feed, onbekend Kraken-paar, categorieconflict …) als toast; het paneel blijft open zodat de gebruiker kan corrigeren. */
  const reportError = (e: unknown) => toast(e instanceof Error ? e.message : String(e), "error");

  const confirmPending = async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      // existingAssetId gaat mee zodat de server het bestaande crypto-asset opwaardeert en nooit een tweede asset aanmaakt
      const created = await api<SelectedAsset>("/api/assets", {
        method: "POST",
        json: { symbol: pending.symbol, name: pending.name, category, currency: pending.currency, priceSource: pending.source, sourceId: pending.sourceId, exchange: pending.exchange, logoUrl: pending.logoUrl, existingAssetId: pending.existingAssetId },
      });
      setSelected(created);
      setPending(null);
      onSelect(created);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const createManual = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const created = await api<SelectedAsset>("/api/assets", {
        method: "POST",
        json: { symbol: manual.symbol || manual.name.slice(0, 10).toUpperCase().replace(/\s+/g, ""), name: manual.name, category: manual.category, currency: manual.currency, priceSource: "manual" },
      });
      setSelected(created);
      onSelect(created);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  if (selected) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-elev px-3 py-2">
        <AssetLogo symbol={selected.symbol} logoUrl={selected.logoUrl} category={selected.category} size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{selected.name}</div>
          <div className="text-xs text-muted">
            {selected.symbol} · {CATEGORY_LABELS[selected.category] ?? selected.category} · {selected.currency}
          </div>
        </div>
        <button className="text-xs font-semibold text-accent" onClick={() => setSelected(null)}>
          Wijzigen
        </button>
      </div>
    );
  }

  if (pending) {
    return (
      <div className="space-y-3 rounded-xl border border-border bg-bg-elev p-3">
        <div className="flex items-center gap-3">
          <AssetLogo symbol={pending.symbol} logoUrl={pending.logoUrl} category={category} size={32} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{pending.name}</div>
            <div className="text-xs text-muted">
              {pending.symbol} · bron {sourceLabel(pending.source)} · {currencyLabel(pending)}
            </div>
            {pending.existingAssetId != null && <div className="mt-1 text-xs font-semibold text-accent">{existingBadge(pending)}</div>}
          </div>
        </div>
        {pending.existingAssetId != null ? (
          <div className="text-xs text-muted">Het bestaande asset houdt zijn naam, categorie en valuta; alleen de koersbron verandert.</div>
        ) : (
          <label className="block">
            <span className="label">Categorie</span>
            <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.filter((c) => c !== "real_estate").map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex gap-2">
          <button className="btn" disabled={busy} onClick={() => void confirmPending()}>
            {busy ? "Bezig…" : pending.existingAssetId != null ? "Koersbron instellen" : "Asset toevoegen"}
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => setPending(null)}>
            Terug
          </button>
        </div>
      </div>
    );
  }

  if (mode === "manual") {
    return (
      <div className="space-y-3 rounded-xl border border-border bg-bg-elev p-3">
        <div className="text-sm font-semibold">Nieuw asset zonder koersfeed (bijv. fysiek vastgoed)</div>
        <label className="block">
          <span className="label">Naam</span>
          <input className="input" value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} placeholder="Woning Hoofdstraat 1" />
        </label>
        <div className="grid grid-cols-3 gap-2">
          <label className="block">
            <span className="label">Symbool</span>
            <input className="input" value={manual.symbol} onChange={(e) => setManual({ ...manual, symbol: e.target.value.toUpperCase() })} placeholder="HUIS" />
          </label>
          <label className="block">
            <span className="label">Categorie</span>
            <select className="input" value={manual.category} onChange={(e) => setManual({ ...manual, category: e.target.value })}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Valuta</span>
            <select className="input" value={manual.currency} onChange={(e) => setManual({ ...manual, currency: e.target.value })}>
              {["EUR", "USD", "CHF", "GBP"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex gap-2">
          <button className="btn" disabled={!manual.name || busy} onClick={() => void createManual()}>
            {busy ? "Bezig…" : "Aanmaken"}
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => setMode("search")}>
            Terug naar zoeken
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search size={16} className="absolute left-3 top-3 text-muted" />
        <input className="input !pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Zoek op ticker, naam of ISIN (BTC, ASML, VWRL…)" autoFocus />
      </div>
      {loading && <div className="text-xs text-muted">Zoeken…</div>}
      {results.length > 0 && (
        <ul className="max-h-64 overflow-y-auto rounded-xl border border-border bg-bg-elev">
          {results.map((c, i) => (
            <li key={`${c.source}-${c.symbol}-${i}`}>
              <button className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-card-hover" onClick={() => void choose(c)}>
                <AssetLogo symbol={c.symbol} logoUrl={c.logoUrl} category={c.categoryGuess} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{c.name}</div>
                  <div className="text-xs text-muted">
                    {c.symbol} · {sourceLabel(c.source)}
                    {c.source !== "local" ? ` · ${currencyLabel(c)}` : ""}
                    {c.exchange && c.exchange !== sourceLabel(c.source) ? ` · ${c.exchange}` : "" /* Kraken-kandidaten: beurs = bron, niet dubbel tonen */}
                    {c.existingAssetId != null && <span className="ml-1 rounded-md bg-accent-soft px-1.5 py-0.5 font-semibold text-accent">{existingBadge(c)}</span>}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {errors.length > 0 && <div className="text-xs text-warn">{errors.join(" · ")}</div>}
      <button className="text-xs font-semibold text-accent" onClick={() => setMode("manual")}>
        Niet gevonden? Asset handmatig aanmaken (bijv. vastgoed)
      </button>
    </div>
  );
}
