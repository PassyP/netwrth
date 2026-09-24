"use client";

import { Area, AreaChart, CartesianGrid, Cell, DefaultTooltipContent, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import { formatDate, formatPercent, currencySymbol, CATEGORY_COLORS } from "@/lib/format";
import { useApp } from "./app-state";
import { useFormat, type MoneyPair } from "./ui";

export interface HistoryPointView {
  date: string;
  value: MoneyPair;
  invested: MoneyPair;
}

/** Periodes van /api/history, voor de grafieken waarde vs. inleg (overzicht en allocatie). */
export const HISTORY_RANGES = ["1D", "1W", "1M", "3M", "1J", "5J", "Alles"] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];

const PALETTE = ["#4f8cff", "#22c55e", "#f7931a", "#a855f7", "#eab308", "#ec4899", "#14b8a6", "#f97316", "#8b5cf6", "#06b6d4"];

/** Kleur van een allocatiesegment: vast per categorie, anders op volgorde. Dezelfde in de donut en in de kop erboven. */
export function sliceColor(key: string, index: number, colorKey: "index" | "category"): string {
  return colorKey === "category" ? CATEGORY_COLORS[key] ?? PALETTE[index % PALETTE.length] : PALETTE[index % PALETTE.length];
}

function compact(n: number, ccy: string): string {
  const abs = Math.abs(n);
  const sym = currencySymbol(ccy);
  // BTC-bedragen zijn klein: geen k/M maar een paar significante cijfers ("₿1,23", "₿0,0452")
  if (ccy === "BTC") return `${sym}${Number(n.toPrecision(3)).toString().replace(".", ",")}`;
  // decimalen alleen waar nodig: ticks om de €500 moeten "€2,5k" en "€3k" worden, niet twee keer "€3k"
  const short = (v: number) => Number(v.toFixed(2)).toString().replace(".", ",");
  if (abs >= 1e6) return `${sym}${short(n / 1e6)}M`;
  if (abs >= 1e3) return `${sym}${short(n / 1e3)}k`;
  return `${sym}${n.toFixed(0)}`;
}

/**
 * Ronde ticks binnen [lo, hi]: stappen van 1, 2 of 5 × 10ⁿ, een stuk of vijf. Met alleen een domein kiest recharts
 * gelijke delen daarvan ("€1,92k", "€2,37k"); bij de kleinere bedragen van één allocatiesegment valt dat op.
 */
function niceTicks(lo: number, hi: number): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

// Regels van de tooltip in deze volgorde; recharts sorteert anders op naam en dan komt "btc" bovenaan
const VALUE_ROWS: Record<string, string> = { invested: "Inleg", value: "Waarde", btc: "Waarde in BTC", gain: "Ongerealiseerd" };
const VALUE_ORDER = Object.keys(VALUE_ROWS);

/**
 * De standaard-tooltip van recharts plus de regels "Waarde in BTC" (value.BTC van de server: bitcoin telt daar 1:1, dus
 * niet terugrekenen vanuit euro) en "Ongerealiseerd" (waarde min inleg op die dag). Geen extra lijnen in de grafiek;
 * opmaak en aria-live blijven die van recharts.
 */
function ValueTooltip(props: TooltipContentProps) {
  const value = props.payload.find((e) => e.dataKey === "value");
  const invested = props.payload.find((e) => e.dataKey === "invested");
  if (!value || !invested) return <DefaultTooltipContent {...props} />;
  const btc = (value.payload as { btc?: string | null }).btc;
  const gain = Number(value.value) - Number(invested.value);
  const extra = [
    // neutrale tekstkleur: groen/rood van "Waarde" zegt iets over waarde vs. inleg in de weergavevaluta, niet in BTC
    ...(btc != null ? [{ ...value, dataKey: "btc", name: "btc", value: btc, color: "#e8ebf1" }] : []),
    { ...value, dataKey: "gain", name: "gain", value: gain, color: gain > 0 ? "#22c55e" : gain < 0 ? "#ef4444" : "#8b93a4" },
  ];
  return <DefaultTooltipContent {...props} payload={[...props.payload, ...extra]} />;
}

export function ValueChart({ points, height = 240, legend = false }: { points: HistoryPointView[]; height?: number; legend?: boolean }) {
  const { currency } = useApp();
  const { money, hidden } = useFormat();
  // in BTC-weergave staat de BTC-waarde al bij "Waarde": dan geen extra regel
  const data = points.map((p) => ({ date: p.date, value: Number(p.value[currency]), invested: Number(p.invested[currency]), btc: currency === "BTC" ? null : p.value.BTC }));
  if (data.length === 0) return <div className="flex h-40 items-center justify-center text-sm text-muted">Nog geen historie</div>;
  const last = data[data.length - 1];
  const up = last.value >= last.invested;
  const color = up ? "#22c55e" : "#ef4444";
  const min = Math.min(...data.map((d) => Math.min(d.value, d.invested)));
  const max = Math.max(...data.map((d) => Math.max(d.value, d.invested)));
  const pad = (max - min) * 0.1 || max * 0.05 || 1;
  const domain: [number, number] = [Math.max(0, min - pad), max + pad];
  return (
    <>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: hidden ? 8 : 0, bottom: 0 }}>
          <defs>
            <linearGradient id="valueFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#232a38" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" tick={{ fill: "#8b93a4", fontSize: 11 }} tickFormatter={(d: string) => formatDate(d)} minTickGap={40} axisLine={false} tickLine={false} />
          {/* bij "Bedragen verbergen" geen y-as: de ticks zijn bedragen; de lijn zelf toont alleen het verloop */}
          <YAxis hide={hidden} domain={domain} ticks={niceTicks(...domain)} tick={{ fill: "#8b93a4", fontSize: 11 }} tickFormatter={(v: number) => compact(v, currency)} axisLine={false} tickLine={false} width={56} />
          <Tooltip
            contentStyle={{ background: "#161b25", border: "1px solid #232a38", borderRadius: 12, fontSize: 12 }}
            labelStyle={{ color: "#8b93a4" }}
            labelFormatter={(d) => formatDate(String(d))}
            formatter={(v, name, item) => {
              const key = String(name);
              if (key === "btc") return [money(String(v), "BTC"), VALUE_ROWS.btc];
              if (key === "gain") {
                // het percentage blijft bij "Bedragen verbergen" zichtbaar, net als bij <Gain>
                const invested = Number((item?.payload as { invested?: number } | undefined)?.invested);
                const pct = invested > 0 ? ` (${formatPercent((Number(v) / invested) * 100, { sign: true })})` : "";
                return [`${money(Number(v), currency, { sign: true })}${pct}`, VALUE_ROWS.gain];
              }
              return [money(Number(v), currency), VALUE_ROWS[key] ?? key];
            }}
            itemSorter={(e) => VALUE_ORDER.indexOf(String(e.dataKey))}
            content={ValueTooltip}
          />
          <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill="url(#valueFill)" isAnimationActive={false} />
          <Line type="monotone" dataKey="invested" stroke="#8b93a4" strokeWidth={1.5} dot={false} strokeDasharray="4 3" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
      {legend && (
        <div className="mt-2 flex gap-4 text-xs text-muted">
          <span className="flex items-center gap-1">
            {/* kleur van het vlak: groen boven de inleg, rood eronder */}
            <span className={`inline-block h-2 w-4 rounded ${up ? "bg-up" : "bg-down"}`} /> Waarde
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-4 border-t border-dashed border-muted" /> Inleg
          </span>
        </div>
      )}
    </>
  );
}

export function PriceChart({ points, currency, height = 220 }: { points: { day: string; price: string }[]; currency: string; height?: number }) {
  const { price } = useFormat();
  const data = points.map((p) => ({ date: p.day, price: Number(p.price) }));
  if (data.length < 2) return <div className="flex h-40 items-center justify-center text-sm text-muted">Nog geen koershistorie</div>;
  const up = data[data.length - 1].price >= data[0].price;
  const color = up ? "#22c55e" : "#ef4444";
  const min = Math.min(...data.map((d) => d.price));
  const max = Math.max(...data.map((d) => d.price));
  const pad = (max - min) * 0.1 || max * 0.05 || 1;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#232a38" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" tick={{ fill: "#8b93a4", fontSize: 11 }} tickFormatter={(d: string) => formatDate(d)} minTickGap={40} axisLine={false} tickLine={false} />
        <YAxis domain={[min - pad, max + pad]} ticks={niceTicks(min - pad, max + pad)} tick={{ fill: "#8b93a4", fontSize: 11 }} tickFormatter={(v: number) => compact(v, currency)} axisLine={false} tickLine={false} width={56} />
        <Tooltip contentStyle={{ background: "#161b25", border: "1px solid #232a38", borderRadius: 12, fontSize: 12 }} labelFormatter={(d) => formatDate(String(d))} formatter={(v) => [price(Number(v), currency, { decimals: 4 }), "Koers"]} />
        <Area type="monotone" dataKey="price" stroke={color} strokeWidth={2} fill="url(#priceFill)" isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export interface Slice {
  key: string;
  label: string;
  value: MoneyPair;
  pct: number;
}

export function Donut({ slices, onSelect, selected, colorKey = "index", layout = "row" }: { slices: Slice[]; onSelect?: (key: string | null) => void; selected?: string | null; colorKey?: "index" | "category"; layout?: "row" | "column" }) {
  const { currency } = useApp();
  const { money } = useFormat();
  const data = slices.map((s, i) => ({ ...s, amount: Number(s.value[currency]), color: sliceColor(s.key, i, colorKey) }));
  if (data.length === 0) return <div className="flex h-40 items-center justify-center text-sm text-muted">Geen posities</div>;
  return (
    <div className={`flex min-w-0 flex-col items-center gap-4 ${layout === "row" ? "sm:flex-row" : ""}`}>
      <div className="h-48 w-48 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="amount" nameKey="label" innerRadius={58} outerRadius={88} paddingAngle={2} stroke="none" isAnimationActive={false} onClick={(d) => onSelect?.(selected === (d as { key: string }).key ? null : (d as { key: string }).key)}>
              {data.map((d) => (
                <Cell key={d.key} fill={d.color} opacity={selected && selected !== d.key ? 0.35 : 1} cursor={onSelect ? "pointer" : undefined} />
              ))}
            </Pie>
            <Tooltip contentStyle={{ background: "#161b25", border: "1px solid #232a38", borderRadius: 12, fontSize: 12 }} formatter={(v, _n, item) => [`${money(Number(v), currency)} (${(item?.payload as { pct: number })?.pct?.toFixed(1).replace(".", ",")}%)`, String(item?.name ?? "")]} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="w-full min-w-0 space-y-1.5 text-sm">
        {data.map((d) => (
          <li key={d.key}>
            <button className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-card-hover lg:py-1 ${selected === d.key ? "bg-card-hover" : ""}`} onClick={() => onSelect?.(selected === d.key ? null : d.key)}>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.color }} />
              <span className="min-w-0 flex-1 truncate">{d.label}</span>
              <span className="tnum w-12 shrink-0 text-right text-muted">{d.pct.toFixed(1).replace(".", ",")}%</span>
              <span className="tnum shrink-0 whitespace-nowrap text-right">{money(d.amount, currency)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
