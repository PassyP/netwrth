"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Plus, AlertTriangle } from "lucide-react";
import { useApi, useApp } from "./app-state";
import { Card, Money, Gain, Skeleton, Empty, AssetLogo, RangePills, Price, Qty, Pct, colorFor, timeAgo } from "./ui";
import { ValueChart, Donut, type HistoryPointView } from "./charts";
import { TransactionForm } from "./transaction-form";
import type { ConnectionRow } from "./connections";
import type { PortfolioView, PositionView } from "@/lib/portfolio";
import { CATEGORY_LABELS, CATEGORY_COLORS, dustAmount, dustLabel, isDust } from "@/lib/format";

const RANGES = ["1D", "1W", "1M", "3M", "1J", "Alles"] as const;
const CATEGORY_ORDER = ["crypto", "stock", "etf", "commodity", "real_estate"];

export function Overview() {
  const { portfolioId, currency, bump } = useApp();
  const pid = portfolioId == null ? "all" : String(portfolioId);
  const { data, error } = useApi<PortfolioView>(`/api/portfolio?portfolioId=${pid}`);
  const [range, setRange] = useState<(typeof RANGES)[number]>("Alles");
  const { data: history } = useApi<HistoryPointView[]>(`/api/history?portfolioId=${pid}&range=${range}`);
  const { data: connections } = useApi<ConnectionRow[]>("/api/connections");
  const linkedPlatforms = useMemo(() => new Set((connections ?? []).map((c) => c.platformId)), [connections]);
  const [category, setCategory] = useState<string | null>(null);
  const [platform, setPlatform] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [showDust, setShowDust] = useState(false);
  const hideDust = data?.hideDust ?? true;

  // posities die aan de filters voldoen; dit is ook de basis voor de gefilterde totalen, zodat verborgen stof wel
  // blijft meetellen in de waarde (verbergen is een weergavekeuze, geen correctie van je vermogen)
  const positions = useMemo(() => {
    if (!data) return [];
    return data.positions.filter((p) => (!category || p.category === category) && (!platform || p.platformId === platform) && Number(p.quantity) > 0);
  }, [data, category, platform]);

  const dustHidden = hideDust && !showDust;
  const visible = useMemo(() => (dustHidden ? positions.filter((p) => !isDust(dustAmount(p.netValue, currency))) : positions), [positions, dustHidden, currency]);
  const dustCount = positions.length - visible.length;

  const groups = useMemo(() => {
    const m = new Map<string, PositionView[]>();
    for (const p of visible) {
      if (!m.has(p.category)) m.set(p.category, []);
      m.get(p.category)!.push(p);
    }
    return [...m.entries()].sort((a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]));
  }, [visible]);

  const categoriesPresent = useMemo(() => [...new Set((data?.positions ?? []).map((p) => p.category))].sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b)), [data]);
  const platformsPresent = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of data?.positions ?? []) m.set(p.platformId, p.platformName);
    return [...m.entries()];
  }, [data]);

  if (error) return <Empty title="Kon het portfolio niet laden">{error}</Empty>;

  const t = data?.totals;
  const filtered = category || platform;
  const sum = (key: "value" | "netValue" | "unrealized" | "dayChange") => positions.reduce((s, p) => s + Number(p[key][currency]), 0);
  const cash = (data?.cash ?? []).filter((c) => !dustHidden || !isDust(c.amount));

  return (
    <div className="space-y-4 pb-16">
      {/* Kop: totaalwaarde */}
      <Card>
        {!data ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-4 w-48" />
          </div>
        ) : (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-muted">{filtered ? "Waarde (gefilterd)" : "Totale waarde"}</div>
              <div className="mt-1 text-4xl font-extrabold tracking-tight tnum sm:text-5xl">{filtered ? <Money value={String(sum("netValue"))} /> : <Money value={t!.netValue} />}</div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span>
                  <span className="text-muted">Vandaag </span>
                  {filtered ? <Gain value={String(sum("dayChange"))} /> : <Gain value={t!.dayChange} pct={t!.dayChangePct[currency]} />}
                </span>
                <span>
                  <span className="text-muted">Ongerealiseerd </span>
                  {filtered ? <Gain value={String(sum("unrealized"))} /> : <Gain value={t!.unrealized} pct={t!.unrealizedPct[currency]} />}
                </span>
                {!filtered && (
                  <span>
                    <span className="text-muted">Totaal resultaat </span>
                    <Gain value={t!.totalResult} pct={t!.returnPct[currency]} />
                  </span>
                )}
              </div>
            </div>
            <dl className="grid shrink-0 grid-cols-[auto_auto] gap-x-6 gap-y-1 whitespace-nowrap text-sm sm:text-right">
              <dt className="text-muted">Inleg</dt>
              <dd className="tnum">
                <Money value={t!.cost} />
              </dd>
              <dt className="text-muted">Gerealiseerd</dt>
              <dd className={colorFor(t!.realized[currency])}>
                <Money value={t!.realized} sign />
              </dd>
              <dt className="text-muted">Dividend/rente</dt>
              <dd className={colorFor(t!.income[currency])}>
                <Money value={t!.income} sign />
              </dd>
              <dt className="text-muted">Kosten</dt>
              <dd className="tnum text-muted">
                <Money value={t!.fees} />
              </dd>
              {Number(t!.debt[currency]) > 0 && (
                <>
                  <dt className="text-muted">Schuld</dt>
                  <dd className="tnum whitespace-nowrap text-muted">
                    <Money value={{ EUR: String(-Number(t!.debt.EUR)), USD: String(-Number(t!.debt.USD)), BTC: String(-Number(t!.debt.BTC)) }} />
                  </dd>
                </>
              )}
            </dl>
          </div>
        )}
        {data && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>Laatste koers: {timeAgo(data.lastUpdated)}</span>
            {data.fxMissing.length > 0 && (
              <span className="flex items-center gap-1 text-warn">
                <AlertTriangle size={14} /> Geen wisselkoers voor {data.fxMissing.join(", ")} — klik op Verversen
              </span>
            )}
          </div>
        )}
      </Card>

      {/* Grafiek + allocatie */}
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3" title="Waarde vs. inleg" action={<RangePills value={range} options={RANGES} onChange={setRange} />}>
          {history ? <ValueChart points={history} /> : <Skeleton className="h-60" />}
          <div className="mt-2 flex gap-4 text-xs text-muted">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-4 rounded bg-up" /> Waarde
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-0.5 w-4 border-t border-dashed border-muted" /> Inleg
            </span>
          </div>
        </Card>
        <Card className="lg:col-span-2" title="Allocatie" action={<Link href="/allocation" className="tap text-xs font-semibold text-accent">Alles</Link>}>
          {data ? <Donut slices={data.allocation.byCategory} colorKey="category" selected={category} onSelect={(k) => setCategory(k)} layout="column" /> : <Skeleton className="h-48" />}
        </Card>
      </div>

      {/* Filters */}
      {data && data.positions.length > 0 && (
        <div className="scroll-x flex items-center gap-2 sm:flex-wrap">
          <button className="chip whitespace-nowrap" data-active={!category} onClick={() => setCategory(null)}>
            Alle categorieën
          </button>
          {categoriesPresent.map((c) => (
            <button key={c} className="chip whitespace-nowrap" data-active={category === c} onClick={() => setCategory(category === c ? null : c)}>
              {CATEGORY_LABELS[c] ?? c}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-border" />
          <button className="chip whitespace-nowrap" data-active={!platform} onClick={() => setPlatform(null)}>
            Alle platforms
          </button>
          {platformsPresent.map(([id, name]) => (
            <button key={id} className="chip whitespace-nowrap" data-active={platform === id} onClick={() => setPlatform(platform === id ? null : id)}>
              {name}
            </button>
          ))}
        </div>
      )}

      {/* Posities */}
      {!data ? (
        <Card>
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        </Card>
      ) : data.positions.length === 0 ? (
        <Empty title="Nog geen posities">
          Voeg je eerste aankoop toe met de knop rechtsonder, of{" "}
          <Link href="/import" className="text-accent">
            importeer een export
          </Link>{" "}
          van eToro of Swissquote.
        </Empty>
      ) : (
        groups.map(([cat, list]) => {
          const subtotal = list.reduce((s, p) => s + Number(p.netValue[currency]), 0);
          const subGain = list.reduce((s, p) => s + Number(p.unrealized[currency]), 0);
          return (
            <Card key={cat} flush>
              <div className="flex items-center justify-between border-b border-border px-4 py-3 sm:px-5">
                <div className="flex items-center gap-2 font-bold">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: CATEGORY_COLORS[cat] }} />
                  {CATEGORY_LABELS[cat] ?? cat}
                  <span className="text-xs font-semibold text-muted">{list.length}</span>
                </div>
                <div className="text-right text-sm">
                  <Money value={String(subtotal)} className="font-semibold" />
                  <span className="ml-2">
                    <Gain value={String(subGain)} />
                  </span>
                </div>
              </div>
              <ul>
                {list.map((p) => (
                  <PositionRow key={p.key} p={p} linked={linkedPlatforms.has(p.platformId)} />
                ))}
              </ul>
            </Card>
          );
        })
      )}

      {data && dustCount > 0 && (
        <button className="w-full py-2 text-center text-xs text-muted hover:text-text" onClick={() => setShowDust(true)}>
          {dustCount} stofpositie{dustCount === 1 ? "" : "s"} verborgen (minder dan {dustLabel(currency)} waard) · tonen
        </button>
      )}
      {data && hideDust && showDust && (
        <button className="w-full py-2 text-center text-xs text-muted hover:text-text" onClick={() => setShowDust(false)}>
          Stofposities weer verbergen
        </button>
      )}

      {data && cash.length > 0 && (
        <Card title="Kas per platform">
          <ul className="grid gap-2 sm:grid-cols-3">
            {cash.map((c) => (
              <li key={`${c.platformId}-${c.currency}`} className="flex justify-between rounded-xl bg-bg-elev px-3 py-2 text-sm">
                <span className="text-muted">
                  {c.platformName} · {c.currency}
                </span>
                <Money value={c.amount} currency={c.currency} className={colorFor(c.amount)} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <button onClick={() => setShowForm(true)} className="fixed bottom-20 right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 hover:brightness-110 lg:bottom-8 lg:right-8" aria-label="Transactie toevoegen">
        <Plus size={26} />
      </button>
      <TransactionForm open={showForm} onClose={() => setShowForm(false)} onSaved={bump} />
    </div>
  );
}

function PositionRow({ p, linked }: { p: PositionView; linked: boolean }) {
  const { currency } = useApp();
  return (
    <li className="border-b border-border last:border-b-0">
      <Link href={`/assets/${p.assetId}`} className="flex items-center gap-3 px-4 py-3 hover:bg-card-hover sm:px-5">
        <AssetLogo symbol={p.symbol} logoUrl={p.logoUrl} category={p.category} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{p.name}</div>
          <div className="text-xs text-muted sm:truncate">
            <span className="mr-1 rounded-md bg-bg-elev px-1.5 py-0.5 text-[10px] font-bold uppercase" title={linked ? "Via API-koppeling" : undefined}>
              {p.platformName}
              {linked ? " ⚡" : ""}
            </span>
            <Qty value={p.quantity} /> {p.symbol} · <Price value={p.price} currency={p.priceCurrency} category={p.category} />
            {p.priceMissing && <span className="ml-1 text-warn">(kostprijs)</span>}
            {p.dayChangePct != null && (
              <span className={`ml-1 ${colorFor(p.dayChangePct)}`}>
                <Pct value={p.dayChangePct} />
              </span>
            )}
            {p.warnings.length > 0 && <AlertTriangle size={12} className="ml-1 inline text-warn" />}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-semibold tnum">
            <Money value={p.netValue} />
          </div>
          <div className="text-xs">
            <Gain value={p.unrealized} pct={Number(p.cost[currency]) > 0 ? p.unrealizedPct[currency] : null} />
          </div>
        </div>
      </Link>
    </li>
  );
}
