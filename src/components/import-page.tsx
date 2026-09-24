"use client";

import { useState } from "react";
import { Upload, CheckCircle2, AlertTriangle } from "lucide-react";
import { api, useApi, useApp } from "./app-state";
import { Card, Field, useFormat } from "./ui";
import { CATEGORY_LABELS, TX_TYPE_LABELS, formatDate } from "@/lib/format";

interface Draft {
  rowIndex: number;
  type: string;
  symbol: string;
  isin: string | null;
  quantity: string;
  price: string;
  currency: string;
  fee: string;
  executedAt: string;
  category: string;
  existingAssetId: number | null;
  warning: string | null;
}

interface Preview {
  filename: string;
  profile: "swissquote-positions" | "generic";
  headers: string[];
  sample: Record<string, string>[];
  rowCount: number;
  mapping: Record<string, string | undefined>;
  drafts: Draft[];
}

const FIELDS: { key: string; label: string }[] = [
  { key: "date", label: "Datum" },
  { key: "type", label: "Type" },
  { key: "symbol", label: "Symbool" },
  { key: "isin", label: "ISIN" },
  { key: "name", label: "Naam" },
  { key: "quantity", label: "Aantal" },
  { key: "price", label: "Prijs" },
  { key: "currency", label: "Valuta" },
  { key: "fee", label: "Kosten" },
  { key: "note", label: "Notitie" },
];

/** Bij kasregels (dividend, rente, kosten, storting, opname) is `price` het bedrag zelf, geen prijs per stuk. */
function isPerUnit(d: Draft): boolean {
  return ["buy", "sell", "transfer_in", "transfer_out"].includes(d.type) || (d.type === "staking" && Number(d.quantity) > 0);
}

export function ImportPage() {
  const { portfolios, portfolioId, bump, toast } = useApp();
  const fmt = useFormat();
  const { data: platforms } = useApi<{ id: number; name: string }[]>("/api/platforms");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | undefined>>({});
  const [target, setTarget] = useState({ portfolioId: portfolioId ?? portfolios[0]?.id ?? 0, platformId: 0, yahooSuffix: ".L", priceSource: "yahoo" as "yahoo" | "etoro" | "manual" });
  const [categories, setCategories] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<{ created: number; duplicates: number; skipped: number; errors: { row: number; error: string }[]; newAssets: string[] } | null>(null);

  const upload = async (f: File, m?: Record<string, string | undefined>) => {
    setBusy(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      if (m) fd.append("mapping", JSON.stringify(m));
      const r = await fetch("/api/import/preview", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setPreview(j);
      setMapping(j.mapping);
      if (j.profile === "swissquote-positions") {
        const sq = platforms?.find((p) => p.name.toLowerCase() === "swissquote");
        if (sq) setTarget((t) => ({ ...t, platformId: sq.id }));
      } else if (platforms?.[0] && !target.platformId) setTarget((t) => ({ ...t, platformId: platforms[0].id }));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const drafts = preview.drafts.map((d) => ({ ...d, category: categories[d.symbol] ?? d.category }));
      const r = await api<NonNullable<typeof result>>("/api/import/commit", { method: "POST", json: { drafts, ...target, categoryOverrides: categories } });
      setResult(r);
      toast(`${r.created} transacties geïmporteerd`);
      bump();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const pick = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    void upload(f);
  };

  const valid = preview?.drafts.filter((d) => !d.warning) ?? [];
  const newSymbols = [...new Set(valid.filter((d) => !d.existingAssetId && d.symbol).map((d) => d.symbol))];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-extrabold">Importeren</h1>
      <Card>
        <label
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-10 text-center text-sm hover:border-accent ${dragging ? "border-accent bg-accent-soft" : "border-border"}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            pick(e.dataTransfer.files?.[0]);
          }}
        >
          <Upload size={24} className="text-muted" />
          <span className="font-semibold">{busy && !preview ? "Bestand wordt gelezen…" : file ? file.name : "Sleep een bestand hierheen of klik om te kiezen"}</span>
          <span className="text-xs text-muted">{file ? "Klik of sleep om een ander bestand te kiezen" : ".xlsx, .xls, .csv of .tsv"}</span>
          <input type="file" accept=".xlsx,.xls,.csv,.tsv" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
        </label>
        <ul className="mt-3 space-y-1 text-xs text-muted">
          <li>
            <span className="font-semibold text-text">Swissquote-positie-export</span> (Positions_….xlsx) wordt automatisch herkend.
          </li>
          <li>
            <span className="font-semibold text-text">Andere CSV/XLSX</span> (eToro-exports, eigen lijsten): je kiest per kolom wat erin staat.
          </li>
          <li>Hetzelfde bestand twee keer importeren voegt niets dubbel toe.</li>
        </ul>
      </Card>

      {result && (
        <Card title="Resultaat">
          <ul className="space-y-1 text-sm">
            <li className="text-up">✓ {result.created} transacties toegevoegd</li>
            {result.duplicates > 0 && <li className="text-muted">{result.duplicates} dubbele regels overgeslagen</li>}
            {result.skipped > 0 && <li className="text-muted">{result.skipped} ongeldige rijen overgeslagen</li>}
            {result.newAssets.length > 0 && <li>Nieuwe assets: {result.newAssets.join(", ")} — koersen worden op de achtergrond opgehaald</li>}
            {result.errors.map((e) => (
              <li key={e.row} className="text-down">
                Rij {e.row}: {e.error}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {preview && (
        <>
          <Card title={preview.profile === "swissquote-positions" ? "Herkend: Swissquote-positie-export" : "Kolommapping"}>
            <p className="mb-3 text-xs text-muted">
              {preview.rowCount} rijen · werkblad {preview.headers.length} kolommen
              {preview.profile === "swissquote-positions" && " · elke positie wordt één aankooptransactie (aantal × gemiddelde kostprijs) op de datum uit de bestandsnaam"}
            </p>
            {preview.profile === "generic" && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {FIELDS.map((f) => (
                  <Field key={f.key} label={f.label}>
                    <select className="input" value={mapping[f.key] ?? ""} onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value || undefined })}>
                      <option value="">—</option>
                      {preview.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </Field>
                ))}
                <Field label="Standaardtype">
                  <select className="input" value={mapping.defaultType ?? "buy"} onChange={(e) => setMapping({ ...mapping, defaultType: e.target.value })}>
                    {Object.entries(TX_TYPE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Standaardvaluta">
                  <select className="input" value={mapping.defaultCurrency ?? "USD"} onChange={(e) => setMapping({ ...mapping, defaultCurrency: e.target.value })}>
                    {["EUR", "USD", "CHF", "GBP"].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Standaardcategorie">
                  <select className="input" value={mapping.defaultCategory ?? "stock"} onChange={(e) => setMapping({ ...mapping, defaultCategory: e.target.value })}>
                    {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="flex items-end sm:col-span-2">
                  <button className="btn btn-ghost" disabled={busy || !file} onClick={() => file && void upload(file, mapping)}>
                    Voorbeeld vernieuwen
                  </button>
                </div>
              </div>
            )}
          </Card>

          <Card title="Voorbeeld" action={preview.drafts.length > 200 ? <span className="text-xs text-muted">eerste 200 van {preview.drafts.length} rijen</span> : undefined} flush>
            <div className="scroll-x">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted">
                  <tr className="border-b border-border">
                    <th className="px-4 py-2">Rij</th>
                    <th className="px-2 py-2">Type</th>
                    <th className="px-2 py-2">Symbool</th>
                    <th className="px-2 py-2 text-right">Aantal</th>
                    <th className="px-2 py-2 text-right">Prijs</th>
                    <th className="px-2 py-2">Datum</th>
                    <th className="px-2 py-2">Categorie</th>
                    <th className="px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.drafts.slice(0, 200).map((d) => (
                    <tr key={d.rowIndex} className="border-b border-border last:border-0">
                      <td className="px-4 py-1.5 text-muted">{d.rowIndex + 2}</td>
                      <td className="px-2 py-1.5">{TX_TYPE_LABELS[d.type] ?? d.type}</td>
                      <td className="px-2 py-1.5 font-semibold">
                        {d.symbol}
                        {d.isin && <span className="ml-1 text-xs font-normal text-muted">{d.isin}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-right tnum">{d.quantity ? fmt.qty(d.quantity) : "—"}</td>
                      <td className="px-2 py-1.5 text-right tnum">{isPerUnit(d) ? fmt.price(d.price || "0", d.currency, { category: d.category }) : fmt.money(d.price || "0", d.currency)}</td>
                      <td className="px-2 py-1.5 tnum">{formatDate(d.executedAt, true)}</td>
                      <td className="px-2 py-1.5">
                        {d.existingAssetId ? (
                          <span className="text-muted">bestaand</span>
                        ) : (
                          <select className="input !w-auto !py-0.5 text-xs" value={categories[d.symbol] ?? d.category} onChange={(e) => setCategories({ ...categories, [d.symbol]: e.target.value })}>
                            {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                              <option key={k} value={k}>
                                {v}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="px-4 py-1.5">{d.warning ? <span className="flex items-center gap-1 text-warn"><AlertTriangle size={12} /> {d.warning}</span> : <span className="flex items-center gap-1 text-up"><CheckCircle2 size={12} /> Klaar</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Importeren naar">
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Portfolio">
                <select className="input" value={target.portfolioId} onChange={(e) => setTarget({ ...target, portfolioId: Number(e.target.value) })}>
                  {portfolios.filter((p) => !p.archived).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Platform">
                <select className="input" value={target.platformId} onChange={(e) => setTarget({ ...target, platformId: Number(e.target.value) })}>
                  {(platforms ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              {newSymbols.length > 0 && (
                <>
                  <Field label="Koersbron nieuwe assets">
                    <select className="input" value={target.priceSource} onChange={(e) => setTarget({ ...target, priceSource: e.target.value as typeof target.priceSource })}>
                      <option value="yahoo">Yahoo Finance (gratis feed)</option>
                      <option value="manual">Handmatig</option>
                    </select>
                  </Field>
                  {target.priceSource === "yahoo" && (
                    <Field label="Yahoo-suffix" hint="London Stock Exchange = .L, Xetra = .DE, SIX = .SW">
                      <input className="input" value={target.yahooSuffix} onChange={(e) => setTarget({ ...target, yahooSuffix: e.target.value })} />
                    </Field>
                  )}
                </>
              )}
            </div>
            {newSymbols.length > 0 && (
              <p className="mt-2 text-xs text-muted">
                Nieuwe assets: {newSymbols.map((s) => `${s}${target.priceSource === "yahoo" ? target.yahooSuffix : ""}`).join(", ")}. De koersbron is later per asset aan te passen (bijv. naar eToro).
              </p>
            )}
            <div className="mt-4 flex items-center gap-3">
              <button className="btn" disabled={busy || valid.length === 0 || !target.platformId} onClick={() => void commit()}>
                {busy ? "Bezig…" : `${valid.length} transacties importeren`}
              </button>
              {preview.drafts.length - valid.length > 0 && <span className="text-xs text-warn">{preview.drafts.length - valid.length} rijen worden overgeslagen</span>}
            </div>
          </Card>
        </>
      )}


    </div>
  );
}
