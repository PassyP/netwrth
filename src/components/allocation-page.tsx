"use client";

import { useState } from "react";
import Link from "next/link";
import { useApi, useApp } from "./app-state";
import { Card, Empty, Skeleton, Money, type MoneyPair } from "./ui";
import { Donut } from "./charts";
import { dustAmount, isDust } from "@/lib/format";
import type { PortfolioView } from "@/lib/portfolio";

const VIEWS = [
  { key: "byCategory", label: "Categorie" },
  { key: "byPlatform", label: "Platform" },
  { key: "byCurrency", label: "Valuta" },
  { key: "byAsset", label: "Asset" },
] as const;

export function AllocationPage() {
  const { portfolioId, currency } = useApp();
  const pid = portfolioId == null ? "all" : String(portfolioId);
  const { data, error } = useApi<PortfolioView>(`/api/portfolio?portfolioId=${pid}`);
  const [view, setView] = useState<(typeof VIEWS)[number]["key"]>("byCategory");
  const [selected, setSelected] = useState<string | null>(null);

  if (error) return <Empty title="Kon allocatie niet laden">{error}</Empty>;
  if (!data) return <Skeleton className="h-96" />;
  // stof telt in de percentages gewoon mee (die komen van de server); het verdwijnt alleen uit de lijsten
  const dusty = (value: MoneyPair) => data.hideDust && isDust(dustAmount(value, currency));
  const slices = data.allocation[view].filter((s) => !dusty(s.value));
  const positions = data.positions.filter((p) => Number(p.quantity) > 0 && !dusty(p.netValue));
  const filteredPositions = positions.filter((p) => {
    if (!selected) return true;
    if (view === "byCategory") return p.category === selected;
    if (view === "byPlatform") return String(p.platformId) === selected;
    if (view === "byCurrency") return p.currency === selected;
    return String(p.assetId) === selected;
  });
  const hiddenCount = data.positions.filter((p) => Number(p.quantity) > 0).length - positions.length;

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
        <Donut slices={slices} colorKey={view === "byCategory" ? "category" : "index"} selected={selected} onSelect={setSelected} />
        <p className="mt-3 text-xs text-muted">
          Netto waarde <Money value={data.totals.netValue} className="font-semibold text-text" /> = 100%. Vastgoed telt mee na aftrek van de schuld.
          {hiddenCount > 0 && ` ${hiddenCount} stofpositie${hiddenCount === 1 ? "" : "s"} niet getoond (wel meegeteld).`}
        </p>
      </Card>
      <Card
        title={selected ? `Posities in ${slices.find((s) => s.key === selected)?.label ?? ""}` : "Alle posities"}
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
