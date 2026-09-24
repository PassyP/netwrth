"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDownToLine, ArrowUpFromLine, Coins, Pencil, Plus, Receipt, Search, Trash2, Upload, Download, Lock, X } from "lucide-react";
import { api, useApi, useApp } from "./app-state";
import { Card, Empty, Skeleton, AssetLogo, useFormat } from "./ui";
import { TransactionForm, isoToLocal, type TxDraft } from "./transaction-form";
import { TX_TYPE_LABELS, dustAmount, getDisplayTimeZone, isDust } from "@/lib/format";
import type { PortfolioView } from "@/lib/portfolio";

const SOURCE_LABELS: Record<string, string> = { api: "API", csv: "Import", manual: "Handmatig" };
// zoveel rijen per keer: 1.000+ transacties in één lijst maakt de pagina traag en onoverzichtelijk
const PAGE_SIZE = 100;

interface TxRow {
  id: number;
  portfolioId: number;
  portfolioName: string;
  platformId: number;
  platformName: string;
  assetId: number | null;
  asset: { id: number; symbol: string; name: string; category: string; logoUrl: string | null; currency: string } | null;
  type: string;
  quantity: string;
  price: string;
  currency: string;
  fee: string;
  executedAt: string;
  note: string | null;
  source: string;
}

const UP_TYPES = new Set(["buy", "transfer_in", "deposit", "dividend", "interest", "staking"]);
const DOWN_TYPES = new Set(["sell", "transfer_out", "withdrawal", "fee"]);

function badgeClass(type: string): string {
  if (type === "buy" || type === "transfer_in") return "bg-up-soft text-up";
  if (type === "sell" || type === "transfer_out") return "bg-down-soft text-down";
  return "bg-bg-elev text-muted";
}

function monthKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { year: "numeric", month: "2-digit", timeZone: getDisplayTimeZone() });
}

function monthLabel(iso: string): string {
  const s = new Date(iso).toLocaleDateString("nl-NL", { month: "long", year: "numeric", timeZone: getDisplayTimeZone() });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "short", timeZone: getDisplayTimeZone() });
  const time = d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: getDisplayTimeZone() });
  return `${day}, ${time}`;
}

/** Icoon voor transacties zonder asset (storting, opname, kosten, …) zodat de kolom uitgelijnd blijft. */
function CashIcon({ type }: { type: string }) {
  const Icon = type === "deposit" ? ArrowDownToLine : type === "withdrawal" ? ArrowUpFromLine : type === "fee" ? Receipt : Coins;
  const tone = UP_TYPES.has(type) ? "bg-up-soft text-up" : DOWN_TYPES.has(type) ? "bg-down-soft text-down" : "bg-bg-elev text-muted";
  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${tone}`}>
      <Icon size={15} />
    </span>
  );
}

/** Rechterkolom: bij aan- en verkoop telt het bedrag, bij overboekingen en staking het aantal eenheden. */
function Amount({ t }: { t: TxRow }) {
  const fmt = useFormat();
  const qty = Number(t.quantity);
  const price = Number(t.price);
  const fee = Number(t.fee);
  const unit = t.asset?.symbol ?? "";
  // een verkoop toont de netto-opbrengst, dus daar zijn de kosten er al af
  const feeLine = fee > 0 ? <div className="text-xs text-muted">{t.type === "sell" ? "na" : "incl."} {fmt.money(t.fee, t.currency)} kosten</div> : null;

  if (t.type === "buy" || t.type === "sell") {
    const total = qty * price + (t.type === "sell" ? -fee : fee);
    return (
      <>
        <div className="font-semibold">{fmt.money(total, t.currency)}</div>
        <div className="hidden text-xs text-muted sm:block">
          {fmt.qty(t.quantity)} × {fmt.price(t.price, t.currency, { category: t.asset?.category })}
        </div>
        {feeLine}
      </>
    );
  }
  if (t.type === "transfer_in" || t.type === "transfer_out" || (t.type === "staking" && qty > 0)) {
    return (
      <>
        <div className="font-semibold">
          {t.type === "transfer_out" ? "−" : "+"}
          {fmt.qty(t.quantity)} {unit}
        </div>
        {price > 0 && <div className="text-xs text-muted">≈ {fmt.money(qty * price, t.currency)}</div>}
      </>
    );
  }
  return (
    <>
      <div className="font-semibold">{fmt.money(t.price, t.currency)}</div>
      {feeLine}
    </>
  );
}

export function TransactionsPage() {
  const { portfolioId, portfolios, currency, bump, toast } = useApp();
  const { text } = useFormat();
  const pid = portfolioId == null ? "all" : String(portfolioId);
  const { data, error } = useApi<TxRow[]>(`/api/transactions?portfolioId=${pid}`);
  const { data: portfolio } = useApi<PortfolioView>(`/api/portfolio?portfolioId=${pid}`);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [platform, setPlatform] = useState<number | null>(null);
  const [assetFilter, setAssetFilter] = useState<number | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [edit, setEdit] = useState<{ draft: Partial<TxDraft>; asset: TxRow["asset"] } | null>(null);
  const [showForm, setShowForm] = useState(false);

  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      (data ?? []).filter(
        (r) =>
          (!type || r.type === type) &&
          (!platform || r.platformId === platform) &&
          (!assetFilter || r.assetId === assetFilter) &&
          (!source || r.source === source) &&
          (!q || [r.asset?.symbol, r.asset?.name, r.note, r.platformName, TX_TYPE_LABELS[r.type]].some((f) => f?.toLowerCase().includes(q)))
      ),
    [data, type, platform, assetFilter, source, q]
  );
  // bij een ander filter weer bovenaan beginnen met de eerste pagina
  useEffect(() => setLimit(PAGE_SIZE), [type, platform, assetFilter, source, q, pid]);
  // ?platform=<id> (bijv. vanaf een platform in Instellingen) zet het platformfilter bij binnenkomst
  useEffect(() => {
    const id = Number(new URLSearchParams(window.location.search).get("platform"));
    if (Number.isInteger(id) && id > 0) setPlatform(id);
  }, []);

  const sourcesPresent = useMemo(() => [...new Set((data ?? []).map((r) => r.source))], [data]);
  const platforms = useMemo(() => [...new Map((data ?? []).map((r) => [r.platformId, r.platformName])).entries()], [data]);
  const typesPresent = useMemo(() => Object.keys(TX_TYPE_LABELS).filter((k) => (data ?? []).some((r) => r.type === k)), [data]);
  const filtersActive = !!(type || platform || assetFilter || source || q);
  const clearFilters = () => {
    setQuery("");
    setType(null);
    setPlatform(null);
    setAssetFilter(null);
    setSource(null);
  };
  // Stof-assets: nog in bezit, maar over alle platforms samen minder waard dan de stofdrempel (dezelfde regel als de
  // positielijst). Die vervuilen het assetfilter net zo goed, dus ze blijven weg zolang "stof verbergen" aanstaat.
  // Gesloten posities (aantal 0) zijn geen stof en blijven gewoon te kiezen.
  const dustAssets = useMemo(() => {
    if (!portfolio?.hideDust) return new Set<number>();
    const held = new Map<number, number>();
    for (const p of portfolio.positions) {
      if (Number(p.quantity) <= 0) continue;
      held.set(p.assetId, (held.get(p.assetId) ?? 0) + Number(dustAmount(p.netValue, currency)));
    }
    return new Set([...held].filter(([, value]) => isDust(value)).map(([id]) => id));
  }, [portfolio, currency]);
  // een al gekozen stof-asset blijft in de lijst, anders wijst de select naar een optie die er niet is
  const assets = useMemo(
    () =>
      [...new Map((data ?? []).filter((r) => r.asset && (r.asset.id === assetFilter || !dustAssets.has(r.asset.id))).map((r) => [r.asset!.id, r.asset!.symbol])).entries()].sort((a, b) =>
        a[1].localeCompare(b[1])
      ),
    [data, dustAssets, assetFilter]
  );
  // portfolionaam alleen tonen als die iets zegt: bij "alle portfolio's" met meer dan één actief portfolio
  const showPortfolio = portfolioId == null && portfolios.filter((p) => !p.archived).length > 1;

  const visible = rows.slice(0, limit);
  const groups = useMemo(() => {
    const out: { key: string; label: string; items: TxRow[] }[] = [];
    for (const t of visible) {
      const key = monthKey(t.executedAt);
      if (out.at(-1)?.key !== key) out.push({ key, label: monthLabel(t.executedAt), items: [] });
      out.at(-1)!.items.push(t);
    }
    return out;
  }, [visible]);
  const monthCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of rows) m.set(monthKey(t.executedAt), (m.get(monthKey(t.executedAt)) ?? 0) + 1);
    return m;
  }, [rows]);

  const del = async (id: number) => {
    if (!confirm("Transactie verwijderen?")) return;
    await api(`/api/transactions/${id}`, { method: "DELETE" });
    toast("Transactie verwijderd");
    bump();
  };

  if (error) return <Empty title="Kon transacties niet laden">{error}</Empty>;

  const n = (v: number) => v.toLocaleString("nl-NL");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold">Transacties</h1>
          {data && <p className="text-sm text-muted tnum">{filtersActive ? `${n(rows.length)} van ${n(data.length)} transacties` : `${n(data.length)} transacties`}</p>}
        </div>
        <div className="flex gap-2">
          <a href="/api/export/transactions" className="btn btn-ghost flex items-center gap-1.5 !py-1.5 text-xs" title="Alle transacties als CSV downloaden" aria-label="CSV-export">
            <Download size={14} /> <span className="hidden sm:inline">CSV-export</span>
          </a>
          <Link href="/import" className="btn btn-ghost flex items-center gap-1.5 !py-1.5 text-xs">
            <Upload size={14} /> Importeren
          </Link>
          <button className="btn flex items-center gap-1.5 !py-1.5 text-xs" onClick={() => setShowForm(true)}>
            <Plus size={14} /> <span className="hidden sm:inline">Nieuwe transactie</span>
            <span className="sm:hidden">Nieuw</span>
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            className="input !pl-9"
            placeholder="Zoek op asset, notitie of platform"
            aria-label="Zoeken"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          />
        </div>

        {platforms.length > 1 && (
          <div className="scroll-x flex items-center gap-2">
            <button className="chip whitespace-nowrap" data-active={!platform} onClick={() => setPlatform(null)}>
              Alle platforms
            </button>
            {platforms.map(([id, name]) => (
              <button key={id} className="chip whitespace-nowrap" data-active={platform === id} onClick={() => setPlatform(platform === id ? null : id)}>
                {name}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <select className="input !w-auto !py-1.5 text-xs" aria-label="Type" data-active={!!type} value={type ?? ""} onChange={(e) => setType(e.target.value || null)}>
            <option value="">Alle types</option>
            {typesPresent.map((k) => (
              <option key={k} value={k}>
                {TX_TYPE_LABELS[k] ?? k}
              </option>
            ))}
          </select>
          {assets.length > 1 && (
            <select className="input !w-auto !py-1.5 text-xs" aria-label="Asset" data-active={!!assetFilter} value={assetFilter ?? ""} onChange={(e) => setAssetFilter(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Alle assets</option>
              {assets.map(([id, sym]) => (
                <option key={id} value={id}>
                  {sym}
                </option>
              ))}
            </select>
          )}
          {sourcesPresent.length > 1 && (
            <select className="input !w-auto !py-1.5 text-xs" aria-label="Bron" data-active={!!source} value={source ?? ""} onChange={(e) => setSource(e.target.value || null)}>
              <option value="">Alle bronnen</option>
              {sourcesPresent.map((sname) => (
                <option key={sname} value={sname}>
                  {SOURCE_LABELS[sname] ?? "Handmatig"}
                </option>
              ))}
            </select>
          )}
          {filtersActive && (
            <button className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-accent hover:bg-accent-soft" onClick={clearFilters}>
              <X size={13} /> Wis filters
            </button>
          )}
        </div>
      </div>

      {!data ? (
        <Card>
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        </Card>
      ) : rows.length === 0 ? (
        filtersActive ? (
          <Empty title="Geen transacties gevonden">
            <button className="font-semibold text-accent" onClick={clearFilters}>
              Wis filters
            </button>
          </Empty>
        ) : (
          <Empty title="Nog geen transacties">Voeg een transactie toe of importeer een export.</Empty>
        )
      ) : (
        <>
          <Card flush>
            {groups.map((g, gi) => (
              <section key={g.key}>
                <h2 className={`sticky top-[70px] z-10 flex items-baseline justify-between border-b border-border bg-card px-4 py-2 text-xs font-bold uppercase tracking-wide text-muted lg:top-0 sm:px-5 ${gi === 0 ? "rounded-t-2xl" : "border-t"}`}>
                  {g.label}
                  <span className="font-semibold normal-case tracking-normal tnum">{n(monthCounts.get(g.key) ?? g.items.length)}</span>
                </h2>
                <ul>
                  {g.items.map((t) => (
                    <li key={t.id} className="group flex items-center gap-3 border-b border-border px-4 py-3 text-sm last:border-0 hover:bg-card-hover sm:px-5">
                      <span className={`hidden w-32 shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-center text-[10px] font-bold uppercase tracking-wide sm:block ${badgeClass(t.type)}`}>{TX_TYPE_LABELS[t.type]}</span>
                      {t.asset ? <AssetLogo symbol={t.asset.symbol} logoUrl={t.asset.logoUrl} category={t.asset.category} size={32} /> : <CashIcon type={t.type} />}
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-baseline gap-2">
                          {t.asset ? (
                            <Link href={`/assets/${t.asset.id}`} className="shrink-0 font-semibold hover:text-accent">
                              {t.asset.symbol}
                            </Link>
                          ) : (
                            <span className="shrink-0 font-semibold">{TX_TYPE_LABELS[t.type]}</span>
                          )}
                          {t.asset && t.asset.name !== t.asset.symbol && <span className="hidden truncate text-xs text-muted sm:inline">{t.asset.name}</span>}
                          {t.asset && <span className={`shrink-0 rounded px-1 text-[10px] font-bold uppercase sm:hidden ${badgeClass(t.type)}`}>{TX_TYPE_LABELS[t.type]}</span>}
                        </div>
                        <div className="truncate text-xs text-muted">
                          {dayLabel(t.executedAt)} · {t.platformName}
                          {showPortfolio ? ` · ${t.portfolioName}` : ""}
                        </div>
                        {t.note && (
                          <div className="truncate text-xs text-muted/70" title={text(t.note)}>
                            {text(t.note)}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 text-right tnum">
                        <Amount t={t} />
                      </div>
                      <div className="-mr-1.5 flex shrink-0 justify-end gap-0.5 sm:w-16">
                        {t.source === "api" ? (
                          <Link href={`/settings/platforms/${t.platformId}`} className="tap inline-flex rounded-lg p-1.5 text-muted/60 hover:bg-bg-elev hover:text-text" aria-label="Uit API-koppeling (alleen-lezen)" title="Uit API-koppeling — alleen-lezen. Beheer de koppeling in Instellingen.">
                            <Lock size={14} />
                          </Link>
                        ) : (
                          <>
                            <button
                              className="tap rounded-lg p-1.5 text-muted hover:bg-bg-elev hover:text-text"
                              aria-label="Bewerken"
                              title="Bewerken"
                              onClick={() => setEdit({ draft: { id: t.id, portfolioId: t.portfolioId, platformId: t.platformId, assetId: t.assetId, type: t.type as TxDraft["type"], quantity: t.quantity, price: t.price, currency: t.currency, fee: t.fee, executedAt: isoToLocal(t.executedAt), note: t.note ?? "" }, asset: t.asset })}
                            >
                              <Pencil size={15} />
                            </button>
                            <button className="tap rounded-lg p-1.5 text-muted hover:bg-down-soft hover:text-down" aria-label="Verwijderen" title="Verwijderen" onClick={() => void del(t.id)}>
                              <Trash2 size={15} />
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </Card>
          {rows.length > limit && (
            <div className="flex flex-col items-center gap-1">
              <button className="btn btn-ghost !py-2 text-sm" onClick={() => setLimit((l) => l + PAGE_SIZE * 2)}>
                Toon meer
              </button>
              <span className="text-xs text-muted tnum">
                {n(visible.length)} van {n(rows.length)} getoond
              </span>
            </div>
          )}
        </>
      )}

      <TransactionForm open={showForm || !!edit} onClose={() => { setShowForm(false); setEdit(null); }} onSaved={bump} initial={edit?.draft} initialAsset={edit?.asset ? { id: edit.asset.id, symbol: edit.asset.symbol, name: edit.asset.name, currency: edit.asset.currency, category: edit.asset.category, logoUrl: edit.asset.logoUrl } : null} />
    </div>
  );
}
