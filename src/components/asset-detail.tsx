"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Bell, Pencil, Plus, Trash2, Lock } from "lucide-react";
import { api, useApi, useApp } from "./app-state";
import { Card, Money, Gain, Skeleton, Empty, AssetLogo, RangePills, Price, Qty, Pct, colorFor, timeAgo, Modal, Field, useFormat } from "./ui";
import { PriceChart } from "./charts";
import { TransactionForm, isoToLocal, type TxDraft } from "./transaction-form";
import type { PositionView } from "@/lib/portfolio";
import { CATEGORY_LABELS, TX_TYPE_LABELS, dustAmount, dustLabel, formatDate, isDust, priceSourceLabel } from "@/lib/format";

const RANGES = ["1W", "1M", "3M", "1J", "5J", "Alles"] as const;
// transacties per keer: bij bijv. BTC via een exchange-koppeling lopen er honderden onder één asset
const TX_PAGE = 25;

interface Detail {
  asset: { id: number; symbol: string; name: string; category: string; currency: string; priceSource: string; sourceId: string | null; isin: string | null; exchange: string | null; logoUrl: string | null };
  quote: { price: string; currency: string; ts: string } | null;
  previousClose: string | null;
  positions: PositionView[];
  transactions: { id: number; portfolioId: number; platformId: number; type: string; quantity: string; price: string; currency: string; fee: string; executedAt: string; note: string | null; source: string }[];
  valuations: { id: number; date: string; value: string; currency: string; debt: string; note: string | null }[];
  alerts: { id: number; condition: string; threshold: string; currency: string; status: string }[];
}

export function AssetDetail({ id }: { id: number }) {
  const { currency, bump, toast } = useApp();
  const fmt = useFormat();
  const { data, error } = useApi<Detail>(`/api/assets/${id}`);
  const [range, setRange] = useState<(typeof RANGES)[number]>("1J");
  const { data: history } = useApi<{ day: string; price: string; currency: string }[]>(`/api/assets/${id}/history?range=${range}`);
  const [editTx, setEditTx] = useState<Partial<TxDraft> | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showAlert, setShowAlert] = useState(false);
  const [showValuation, setShowValuation] = useState(false);
  const [showPrice, setShowPrice] = useState(false);
  const [showEditAsset, setShowEditAsset] = useState(false);
  const [showSmallLots, setShowSmallLots] = useState(false);
  const [txLimit, setTxLimit] = useState(TX_PAGE);
  const [realizedLimit, setRealizedLimit] = useState(TX_PAGE);

  if (error) return <Empty title="Asset niet gevonden">{error}</Empty>;
  if (!data)
    return (
      <div className="space-y-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );

  const a = data.asset;
  const total = data.positions.reduce(
    (acc, p) => ({ qty: acc.qty + Number(p.quantity), value: acc.value + Number(p.netValue[currency]), cost: acc.cost + Number(p.cost[currency]), unreal: acc.unreal + Number(p.unrealized[currency]), realized: acc.realized + Number(p.realized[currency]), income: acc.income + Number(p.income[currency]) }),
    { qty: 0, value: 0, cost: 0, unreal: 0, realized: 0, income: 0 }
  );
  const dayPct = data.quote && data.previousClose ? ((Number(data.quote.price) - Number(data.previousClose)) / Number(data.previousClose)) * 100 : null;
  const isRealEstate = a.category === "real_estate";
  // Na een bronwissel (bijv. eToro in USD → Kraken in EUR) staan oudere koersrijen in een andere valuta dan de nieuwste;
  // de grafiek heeft één as en toont daarom alleen de reeks in de valuta van de laatste koers.
  const chartCurrency = history?.[history.length - 1]?.currency ?? a.currency;
  const chartPoints = history?.filter((p) => p.currency === chartCurrency);
  const lots = data.positions.flatMap((p) => p.lots.map((l) => ({ ...l, platformName: p.platformName, costCurrency: p.costCurrency })));
  // Bij de gemiddelde-kostprijsmethode houdt elk lot na een verkoop een restje over; honderden van die restjes (waarde ~0)
  // verdringen de aankopen die er nog toe doen. Zelfde stofdrempel als de positielijst.
  const smallLots = lots.filter((l) => isDust(dustAmount(l.value, currency)));
  const shownLots = showSmallLots ? lots : lots.filter((l) => !isDust(dustAmount(l.value, currency)));
  // nieuwste verkopen eerst, net als de transactielijst
  const realizedEvents = data.positions
    .flatMap((p) => p.realizedEvents.map((e) => ({ ...e, platformName: p.platformName, costCurrency: p.costCurrency })))
    .sort((x, y) => y.executedAt.localeCompare(x.executedAt));

  const deleteTx = async (txId: number) => {
    if (!confirm("Transactie verwijderen? Posities en historie worden opnieuw berekend.")) return;
    await api(`/api/transactions/${txId}`, { method: "DELETE" });
    toast("Transactie verwijderd");
    bump();
  };

  return (
    <div className="space-y-4">
      <Link href="/" className="inline-flex items-center gap-1 py-2 text-sm text-muted hover:text-text lg:py-0">
        <ArrowLeft size={16} /> Portfolio
      </Link>

      <Card>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-3">
            <AssetLogo symbol={a.symbol} logoUrl={a.logoUrl} category={a.category} size={48} />
            <div>
              <h1 className="text-xl font-extrabold">{a.name}</h1>
              <div className="text-sm text-muted">
                {a.symbol} · {CATEGORY_LABELS[a.category]} · {a.currency}
                {a.isin ? ` · ${a.isin}` : ""} · bron {priceSourceLabel(a.priceSource, a.sourceId)}
                <button className="tap ml-1 text-accent" onClick={() => setShowEditAsset(true)} aria-label="Asset bewerken" title="Asset bewerken">
                  <Pencil size={12} className="inline" />
                </button>
              </div>
            </div>
          </div>
          <div className="sm:text-right">
            <div className="text-3xl font-extrabold tnum">
              <Price value={data.quote?.price ?? null} currency={data.quote?.currency ?? a.currency} category={a.category} />
            </div>
            <div className="text-sm">
              {dayPct != null ? (
                <span className={colorFor(dayPct)}>
                  <Pct value={dayPct.toFixed(2)} /> vandaag
                </span>
              ) : (
                <span className="text-muted">—</span>
              )}
              <span className="ml-2 text-xs text-muted">{timeAgo(data.quote?.ts ?? null)}</span>
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="btn flex items-center gap-1 !py-1.5 text-xs" onClick={() => setShowForm(true)}>
            <Plus size={14} /> Transactie
          </button>
          <button className="btn btn-ghost flex items-center gap-1 !py-1.5 text-xs" onClick={() => setShowAlert(true)}>
            <Bell size={14} /> Alert instellen
          </button>
          {isRealEstate ? (
            <button className="btn btn-ghost !py-1.5 text-xs" onClick={() => setShowValuation(true)}>
              Waarde bijwerken
            </button>
          ) : (
            a.priceSource === "manual" && (
              <button className="btn btn-ghost !py-1.5 text-xs" onClick={() => setShowPrice(true)}>
                Koers invoeren
              </button>
            )
          )}
        </div>
      </Card>

      {data.positions.length > 0 && (
        <Card title="Jouw positie">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 2xl:grid-cols-6">
            <Stat label="Aantal">
              <Qty value={String(total.qty)} />
            </Stat>
            <Stat label="Gem. kostprijs">
              <Price value={data.positions[0].avgCost} currency={data.positions[0].costCurrency} category={a.category} />
            </Stat>
            <Stat label="Waarde">
              <Money value={String(total.value)} />
            </Stat>
            <Stat label="Inleg">
              <Money value={String(total.cost)} />
            </Stat>
            <Stat label="Ongerealiseerd">
              <Gain value={String(total.unreal)} />
              {total.cost > 0 && (
                <div className={`text-xs font-normal ${colorFor(total.unreal)}`}>
                  <Pct value={((total.unreal / total.cost) * 100).toFixed(2)} />
                </div>
              )}
            </Stat>
            <Stat label="Gerealiseerd + inkomsten">
              <Gain value={String(total.realized + total.income)} />
            </Stat>
          </dl>
          {data.positions.some((p) => p.warnings.length) && <p className="mt-2 text-xs text-warn">{fmt.text(data.positions.flatMap((p) => p.warnings).join(" "))}</p>}
        </Card>
      )}

      {!isRealEstate && (
        <Card title="Koers" action={<RangePills value={range} options={RANGES} onChange={setRange} />}>
          {chartPoints ? <PriceChart points={chartPoints} currency={chartCurrency} /> : <Skeleton className="h-56" />}
        </Card>
      )}

      {lots.length > 0 && (
        <Card title="Winst/verlies per aankoop" flush>
          <div className="scroll-x">
            <table className="w-full text-xs sm:text-sm">
              <thead className="text-left text-xs uppercase text-muted">
                <tr className="border-b border-border">
                  <th className="px-2 py-2 sm:px-4">Datum</th>
                  <th className="hidden px-1 py-2 sm:px-2 sm:table-cell">Platform</th>
                  <th className="px-1 py-2 sm:px-2 text-right">Aantal (open)</th>
                  <th className="hidden px-1 py-2 sm:px-2 text-right sm:table-cell">Prijs</th>
                  <th className="px-1 py-2 sm:px-2 text-right">Waarde</th>
                  <th className="px-2 py-2 sm:px-4 text-right">W/V</th>
                </tr>
              </thead>
              <tbody>
                {shownLots.map((l) => (
                  <tr key={`${l.txId}-${l.platformName}`} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap px-2 py-2 sm:px-4 tnum"><TableDate iso={l.executedAt} /></td>
                    <td className="hidden px-1 py-2 sm:px-2 text-muted sm:table-cell">{l.platformName}</td>
                    <td className="whitespace-nowrap px-1 py-2 sm:px-2 text-right tnum">
                      <Qty value={l.quantityOpen} />
                      {l.quantityOpen !== l.quantityOriginal && <span className="hidden text-xs text-muted sm:inline"> / <Qty value={l.quantityOriginal} /></span>}
                    </td>
                    <td className="hidden px-1 py-2 sm:px-2 text-right sm:table-cell">
                      <Price value={l.pricePerUnit} currency={l.costCurrency} category={a.category} />
                      {l.internal && (
                        <span className="ml-1 rounded-md bg-card px-1 py-0.5 text-[10px] font-bold uppercase text-muted" title="Overboeking tussen eigen platforms: de kostprijs van de zender is meegenomen, geen nieuwe inleg">
                          overboeking
                        </span>
                      )}
                    </td>
                    <td className="px-1 py-2 sm:px-2 text-right">
                      <Money value={l.value} />
                    </td>
                    <td className="px-2 py-2 sm:px-4 text-right sm:whitespace-nowrap">
                      <Gain value={l.unrealized} pct={Number(l.costOpen) > 0 ? l.unrealizedPct : null} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {smallLots.length > 0 && (
            <button className="w-full border-t border-border px-4 py-2.5 text-center text-xs text-muted hover:text-text" onClick={() => setShowSmallLots(!showSmallLots)}>
              {showSmallLots ? "Restjes weer verbergen" : `${smallLots.length} aankopen met een restwaarde onder ${dustLabel(currency)} tonen`}
            </button>
          )}
        </Card>
      )}

      {realizedEvents.length > 0 && (
        <Card
          title="Gerealiseerd"
          action={
            <span className="text-sm">
              <span className="mr-1 text-xs text-muted">{realizedEvents.length.toLocaleString("nl-NL")} verkopen ·</span>
              <Gain value={String(total.realized)} />
            </span>
          }
          flush
        >
          <div className="scroll-x">
            <table className="w-full text-xs sm:text-sm">
              <thead className="text-left text-xs uppercase text-muted">
                <tr className="border-b border-border">
                  <th className="px-2 py-2 sm:px-4">Datum</th>
                  <th className="px-1 py-2 sm:px-2 text-right">Aantal</th>
                  <th className="px-1 py-2 sm:px-2 text-right">Opbrengst</th>
                  <th className="hidden px-1 py-2 sm:px-2 text-right sm:table-cell">Kostprijs</th>
                  <th className="px-2 py-2 sm:px-4 text-right">W/V</th>
                </tr>
              </thead>
              <tbody>
                {realizedEvents.slice(0, realizedLimit).map((e) => (
                  <tr key={e.txId} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap px-2 py-2 sm:px-4 tnum"><TableDate iso={e.executedAt} /></td>
                    <td className="px-1 py-2 sm:px-2 text-right tnum">
                      <Qty value={e.quantity} />
                    </td>
                    <td className="px-1 py-2 sm:px-2 text-right">{fmt.money(e.proceeds, e.costCurrency)}</td>
                    <td className="hidden px-1 py-2 sm:px-2 text-right sm:table-cell">{fmt.money(e.cost, e.costCurrency)}</td>
                    <td className="px-2 py-2 sm:px-4 text-right">
                      <Gain value={e.pnl} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {realizedEvents.length > realizedLimit && (
            <button className="w-full border-t border-border px-4 py-2.5 text-center text-xs font-semibold text-accent hover:bg-card-hover" onClick={() => setRealizedLimit((l) => l + 100)}>
              Toon meer ({(realizedEvents.length - realizedLimit).toLocaleString("nl-NL")} resterend)
            </button>
          )}
        </Card>
      )}

      {isRealEstate && data.valuations.length > 0 && (
        <Card title="Waarderingen" flush>
          <div className="scroll-x">
            <table className="w-full text-xs sm:text-sm">
              <thead className="text-left text-xs uppercase text-muted">
                <tr className="border-b border-border">
                  <th className="px-2 py-2 sm:px-4">Datum</th>
                  <th className="px-1 py-2 sm:px-2 text-right">Waarde</th>
                  <th className="px-1 py-2 sm:px-2 text-right">Schuld</th>
                  <th className="px-2 py-2 sm:px-4 text-right">Netto</th>
                </tr>
              </thead>
              <tbody>
                {data.valuations.map((v) => (
                  <tr key={v.id} className="border-b border-border last:border-0">
                    <td className="px-2 py-2 sm:px-4 tnum">{formatDate(v.date)}</td>
                    <td className="px-1 py-2 sm:px-2 text-right">{fmt.money(v.value, v.currency)}</td>
                    <td className="px-1 py-2 sm:px-2 text-right">{fmt.money(v.debt, v.currency)}</td>
                    <td className="px-2 py-2 sm:px-4 text-right font-semibold">{fmt.money(Number(v.value) - Number(v.debt), v.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Transacties" action={data.transactions.length > 0 ? <span className="text-xs text-muted tnum">{data.transactions.length.toLocaleString("nl-NL")}</span> : undefined} flush>
        {data.transactions.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">Nog geen transacties.</p>
        ) : (
          <ul>
            {data.transactions.slice(0, txLimit).map((t) => (
              <li key={t.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 text-sm last:border-0">
                <span className={`w-[7.5rem] shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-center sm:w-32 text-[10px] font-bold uppercase ${t.type === "buy" || t.type === "transfer_in" ? "bg-up-soft text-up" : t.type === "sell" || t.type === "transfer_out" ? "bg-down-soft text-down" : "bg-bg-elev text-muted"}`}>{TX_TYPE_LABELS[t.type]}</span>
                <span className="hidden w-32 shrink-0 tnum text-muted sm:block">{formatDate(t.executedAt, true)}</span>
                <span className="min-w-0 flex-1 tnum">
                  <span className="block text-xs text-muted sm:hidden">{formatDate(t.executedAt, true)}</span>
                  {["transfer_in", "transfer_out"].includes(t.type) && Number(t.price) === 0 ? (
                    <>
                      {t.type === "transfer_out" ? "−" : "+"}
                      <Qty value={t.quantity} /> {a.symbol}
                    </>
                  ) : ["buy", "sell", "transfer_in", "transfer_out"].includes(t.type) ? (
                    <>
                      <Qty value={t.quantity} /> × {fmt.price(t.price, t.currency, { category: a.category })}
                    </>
                  ) : t.type === "staking" && Number(t.quantity) > 0 ? (
                    <>
                      <Qty value={t.quantity} /> {a.symbol}
                    </>
                  ) : (
                    fmt.money(t.price, t.currency)
                  )}
                  {Number(t.fee) > 0 && <span className="text-xs text-muted"> · kosten {fmt.money(t.fee, t.currency)}</span>}
                </span>
                {t.source === "api" ? (
                  <span className="tap hidden p-1.5 text-muted/60 sm:inline-flex" title="Uit API-koppeling — alleen-lezen">
                    <Lock size={14} aria-label="Uit API-koppeling (alleen-lezen)" />
                  </span>
                ) : (
                  <>
                    <button className="tap rounded-lg p-1.5 text-muted hover:bg-bg-elev hover:text-text" aria-label="Bewerken" title="Bewerken" onClick={() => setEditTx({ id: t.id, portfolioId: t.portfolioId, platformId: t.platformId, assetId: a.id, type: t.type as TxDraft["type"], quantity: t.quantity, price: t.price, currency: t.currency, fee: t.fee, executedAt: isoToLocal(t.executedAt), note: t.note ?? "" })}>
                      <Pencil size={14} />
                    </button>
                    <button className="tap rounded-lg p-1.5 text-muted hover:bg-down-soft hover:text-down" aria-label="Verwijderen" title="Verwijderen" onClick={() => void deleteTx(t.id)}>
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {data.transactions.length > txLimit && (
          <button className="w-full border-t border-border px-4 py-2.5 text-center text-xs font-semibold text-accent hover:bg-card-hover" onClick={() => setTxLimit((l) => l + 100)}>
            Toon meer ({(data.transactions.length - txLimit).toLocaleString("nl-NL")} resterend)
          </button>
        )}
      </Card>

      <TransactionForm open={showForm || !!editTx} onClose={() => { setShowForm(false); setEditTx(null); }} onSaved={bump} initial={editTx} initialAsset={{ id: a.id, symbol: a.symbol, name: a.name, currency: a.currency, category: a.category, logoUrl: a.logoUrl }} />
      <AlertModal open={showAlert} onClose={() => setShowAlert(false)} assetId={a.id} currency={data.quote?.currency ?? a.currency} price={data.quote?.price ?? null} category={a.category} />
      <ValuationModal open={showValuation} onClose={() => setShowValuation(false)} assetId={a.id} currency={a.currency} last={data.valuations[0]} />
      <ManualPriceModal open={showPrice} onClose={() => setShowPrice(false)} assetId={a.id} currency={a.currency} />
      <EditAssetModal open={showEditAsset} onClose={() => setShowEditAsset(false)} asset={a} />
    </div>
  );
}

/** Datum in een tabel: op mobiel met een tweecijferig jaar, zodat de tabel zonder zijwaarts scrollen past. */
function TableDate({ iso }: { iso: string }) {
  const full = formatDate(iso);
  return (
    <>
      <span className="sm:hidden">{full.replace(/-\d{2}(\d{2})$/, "-$1")}</span>
      <span className="hidden sm:inline">{full}</span>
    </>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="whitespace-nowrap font-semibold tnum">{children}</dd>
    </div>
  );
}

export function AlertModal({ open, onClose, assetId, currency, price, category }: { open: boolean; onClose: () => void; assetId: number; currency: string; price: string | null; category?: string }) {
  const { bump, toast } = useApp();
  const fmt = useFormat();
  const [condition, setCondition] = useState<"above" | "below">("above");
  const [threshold, setThreshold] = useState("");
  const [ccy, setCcy] = useState(currency === "EUR" ? "EUR" : "USD");
  const save = async () => {
    try {
      await api("/api/alerts", { method: "POST", json: { assetId, condition, threshold, currency: ccy } });
      toast("Alert ingesteld");
      bump();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Koersalert">
      <div className="space-y-3">
        {price && <p className="text-sm text-muted">Huidige koers: {fmt.price(price, currency, { decimals: 4, category })}</p>}
        <div className="flex gap-1">
          <button className="pill" data-active={condition === "above"} onClick={() => setCondition("above")}>
            Boven
          </button>
          <button className="pill" data-active={condition === "below"} onClick={() => setCondition("below")}>
            Onder
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Drempel">
            <input className="input" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="0,00" />
          </Field>
          <Field label="Valuta">
            <select className="input" value={ccy} onChange={(e) => setCcy(e.target.value)}>
              <option>EUR</option>
              <option>USD</option>
            </select>
          </Field>
        </div>
        <p className="text-xs text-muted">Alerts worden gecontroleerd bij elke koersronde: automatisch (Instellingen → Koersen en planning), in de dagelijkse ronde en na een klik op Verversen.</p>
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>
            Annuleren
          </button>
          <button className="btn" onClick={() => void save()} disabled={!threshold}>
            Opslaan
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ValuationModal({ open, onClose, assetId, currency, last }: { open: boolean; onClose: () => void; assetId: number; currency: string; last?: { value: string; debt: string } }) {
  const { bump, toast } = useApp();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [value, setValue] = useState(last?.value ?? "");
  const [debt, setDebt] = useState(last?.debt ?? "0");
  const save = async () => {
    try {
      await api(`/api/assets/${assetId}/valuation`, { method: "POST", json: { date, value: value.replace(",", "."), currency, debt: (debt || "0").replace(",", ".") } });
      toast("Waardering opgeslagen");
      bump();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Waarde bijwerken">
      <div className="space-y-3">
        <Field label="Datum">
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={`Waarde (${currency})`}>
            <input className="input" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Field label={`Schuld / hypotheek (${currency})`}>
            <input className="input" inputMode="decimal" value={debt} onChange={(e) => setDebt(e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>
            Annuleren
          </button>
          <button className="btn" onClick={() => void save()} disabled={!value}>
            Opslaan
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ManualPriceModal({ open, onClose, assetId, currency }: { open: boolean; onClose: () => void; assetId: number; currency: string }) {
  const { bump, toast } = useApp();
  const [price, setPrice] = useState("");
  const save = async () => {
    try {
      await api(`/api/assets/${assetId}/price`, { method: "POST", json: { price: price.replace(",", "."), currency } });
      toast("Koers opgeslagen");
      bump();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Koers invoeren">
      <div className="space-y-3">
        <Field label={`Koers (${currency})`}>
          <input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>
            Annuleren
          </button>
          <button className="btn" onClick={() => void save()} disabled={!price}>
            Opslaan
          </button>
        </div>
      </div>
    </Modal>
  );
}

function EditAssetModal({ open, onClose, asset }: { open: boolean; onClose: () => void; asset: Detail["asset"] }) {
  const { bump, toast } = useApp();
  const [f, setF] = useState({ name: asset.name, category: asset.category, priceSource: asset.priceSource, sourceId: asset.sourceId ?? "", isin: asset.isin ?? "" });
  const save = async () => {
    try {
      await api(`/api/assets/${asset.id}`, { method: "PATCH", json: { ...f, sourceId: f.sourceId || null, isin: f.isin || null } });
      toast("Asset bijgewerkt");
      bump();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Asset bewerken">
      <div className="space-y-3">
        <Field label="Naam">
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Categorie">
            <select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Koersbron">
            <select className="input" value={f.priceSource} onChange={(e) => setF({ ...f, priceSource: e.target.value })}>
              <option value="etoro">eToro</option>
              <option value="yahoo">Yahoo Finance</option>
              <option value="kraken">Kraken</option>
              <option value="manual">Handmatig</option>
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label={f.priceSource === "etoro" ? "eToro instrumentId" : f.priceSource === "yahoo" ? "Yahoo-symbool (bijv. VWRL.L)" : f.priceSource === "kraken" ? "Kraken-paar (bijv. XXBTZEUR)" : "Bron-id"}>
            <input className="input" value={f.sourceId} onChange={(e) => setF({ ...f, sourceId: e.target.value })} />
          </Field>
          <Field label="ISIN">
            <input className="input" value={f.isin} onChange={(e) => setF({ ...f, isin: e.target.value })} />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>
            Annuleren
          </button>
          <button className="btn" onClick={() => void save()}>
            Opslaan
          </button>
        </div>
      </div>
    </Modal>
  );
}
