"use client";

import { useState } from "react";
import Link from "next/link";
import { useApi, useApp } from "./app-state";
import { Card, Empty, Skeleton, Money, Gain, RangePills, type MoneyPair } from "./ui";
import { Donut, ValueChart, HISTORY_RANGES, sliceColor, type HistoryPointView, type HistoryRange } from "./charts";
import { dustAmount, isDust } from "@/lib/format";
import type { PortfolioView, PositionView } from "@/lib/portfolio";

// `filter` is hetzelfde segment in /api/history (HistoryFilter in lib/history.ts), `noun` staat in de uitleg
const VIEWS = [
  { key: "byCategory", label: "Categorie", filter: "category", noun: "categorie" },
  { key: "byPlatform", label: "Platform", filter: "platform", noun: "platform" },
  { key: "byCurrency", label: "Valuta", filter: "currency", noun: "valuta" },
  { key: "byAsset", label: "Asset", filter: "asset", noun: "asset" },
] as const;
type ViewKey = (typeof VIEWS)[number]["key"];

/** Hoort de positie bij segment `key`? Dezelfde sleutels als de allocatie van de server. */
function inSegment(p: PositionView, view: ViewKey, key: string): boolean {
  if (view === "byCategory") return p.category === key;
  if (view === "byPlatform") return String(p.platformId) === key;
  if (view === "byCurrency") return p.currency === key;
  return String(p.assetId) === key;
}

export function AllocationPage() {
  const { portfolioId, currency } = useApp();
  const pid = portfolioId == null ? "all" : String(portfolioId);
  const { data, error } = useApi<PortfolioView>(`/api/portfolio?portfolioId=${pid}`);
  const [view, setView] = useState<ViewKey>("byCategory");
  const [selected, setSelected] = useState<string | null>(null);
  const [range, setRange] = useState<HistoryRange>("Alles");
  const viewDef = VIEWS.find((v) => v.key === view)!;
  // waarde vs. inleg van het aangeklikte segment; zonder selectie het hele portfolio, zoals op het overzicht
  const segment = selected ? `&by=${viewDef.filter}&key=${encodeURIComponent(selected)}` : "";
  const { data: history, loading: historyLoading } = useApi<HistoryPointView[]>(`/api/history?portfolioId=${pid}&range=${range}${segment}`);

  if (error) return <Empty title="Kon allocatie niet laden">{error}</Empty>;
  if (!data) return <Skeleton className="h-96" />;
  // stof telt in de percentages gewoon mee (die komen van de server); het verdwijnt alleen uit de lijsten
  const dusty = (value: MoneyPair) => data.hideDust && isDust(dustAmount(value, currency));
  const colorKey = view === "byCategory" ? "category" : "index";
  const slices = data.allocation[view].filter((s) => !dusty(s.value));
  const selectedIndex = slices.findIndex((s) => s.key === selected);
  const selectedSlice = selectedIndex >= 0 ? slices[selectedIndex] : null;
  const positions = data.positions.filter((p) => Number(p.quantity) > 0 && !dusty(p.netValue));
  const filteredPositions = positions.filter((p) => !selected || inSegment(p, view, selected));
  const hiddenCount = data.positions.filter((p) => Number(p.quantity) > 0).length - positions.length;
  // kerncijfers van het segment met stof erbij, zodat "Waarde" precies het bedrag in de donut is
  const segmentPositions = data.positions.filter((p) => !selected || inSegment(p, view, selected));
  const sum = (key: "netValue" | "cost" | "unrealized") => segmentPositions.reduce((s, p) => s + Number(p[key][currency]), 0);
  const cost = sum("cost");
  const unrealized = sum("unrealized");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-extrabold">Allocatie</h1>
        <div className="flex gap-1">
          {VIEWS.map((v) => (
            <button key={v.key} className="pill" data-active={view === v.key} onClick={() => { setView(v.key); setSelected(null); }}>
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <Card>
        <Donut slices={slices} colorKey={colorKey} selected={selected} onSelect={setSelected} />
        <p className="mt-3 text-xs text-muted">
          Netto waarde <Money value={data.totals.netValue} className="font-semibold text-text" /> = 100%. Vastgoed telt mee na aftrek van de schuld.
          {hiddenCount > 0 && ` ${hiddenCount} stofpositie${hiddenCount === 1 ? "" : "s"} niet getoond (wel meegeteld).`}
        </p>
      </Card>
      <Card
        title="Waarde vs. inleg"
        titleExtra={<SegmentChip label={selectedSlice?.label ?? "Alle posities"} color={selectedSlice ? sliceColor(selectedSlice.key, selectedIndex, colorKey) : undefined} />}
        action={<RangePills value={range} options={HISTORY_RANGES} onChange={setRange} />}
        description={selected ? undefined : `Klik op een ${viewDef.noun} hierboven om alleen die te bekijken.`}
      >
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)]">
          <Stat label="Waarde">
            <Money value={String(sum("netValue"))} />
          </Stat>
          <Stat label="Inleg">
            <Money value={String(cost)} />
          </Stat>
          <Stat label="Ongerealiseerd" className="col-span-2 sm:col-span-1">
            <Gain value={String(unrealized)} pct={cost > 0 ? ((unrealized / cost) * 100).toFixed(2) : null} size="lg" />
          </Stat>
        </div>
        {history ? (
          // bij een ander segment of een andere periode blijft de vorige lijn staan tot de nieuwe binnen is
          <div className={`transition-opacity ${historyLoading ? "opacity-60" : ""}`}>
            <ValueChart points={history} legend />
          </div>
        ) : (
          <Skeleton className="h-60" />
        )}
      </Card>
      <Card
        title={selectedSlice ? `Posities in ${selectedSlice.label}` : "Alle posities"}
        action={
          selected ? (
            <button className="text-xs font-semibold text-accent" onClick={() => setSelected(null)}>
              Toon alles
            </button>
          ) : undefined
        }
        flush
      >
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted">
            <tr className="border-b border-border">
              <th className="px-3 py-2 sm:px-4">Asset</th>
              <th className="hidden px-2 py-2 sm:table-cell">Platform</th>
              <th className="px-2 py-2 text-right">Waarde</th>
              <th className="px-3 py-2 text-right sm:px-4">Aandeel</th>
            </tr>
          </thead>
          <tbody>
            {filteredPositions.map((p) => {
              const total = Number(data.totals.netValue.EUR);
              const pct = total ? (Number(p.netValue.EUR) / total) * 100 : 0;
              return (
                <tr key={p.key} className="border-b border-border last:border-0">
                  <td className="px-3 py-2 sm:px-4">
                    <Link href={`/assets/${p.assetId}`} className="group block py-1">
                      <span className="font-semibold group-hover:text-accent">{p.symbol}</span>
                      {p.name !== p.symbol && <span className="block text-xs text-muted sm:ml-2 sm:inline">{p.name}</span>}
                    </Link>
                  </td>
                  <td className="hidden px-2 py-2 text-muted sm:table-cell">{p.platformName}</td>
                  <td className="px-2 py-2 text-right">
                    <Money value={p.netValue} />
                  </td>
                  <td className="px-3 py-2 sm:px-4">
                    <div className="flex items-center justify-end gap-2">
                      <span className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-bg-elev sm:block">
                        <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, pct)}%` }} />
                      </span>
                      <span className="w-12 text-right tnum">{pct.toFixed(1).replace(".", ",")}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/** Kerncijfer boven de grafiek. */
function Stat({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`min-w-0 rounded-xl bg-bg-elev px-3 py-2 ${className}`}>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-base font-semibold tnum">{children}</div>
    </div>
  );
}

/** Het getoonde segment naast de kaarttitel, in gewone letters (de titel zelf staat in hoofdletters). */
function SegmentChip({ label, color }: { label: string; color?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-elev px-2.5 py-0.5 text-xs font-semibold normal-case tracking-normal text-text">
      {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />}
      {label}
    </span>
  );
}
