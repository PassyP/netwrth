"use client";

import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import type Decimal from "decimal.js";
import { formatMoney, formatPercent, formatQuantity, formatPrice, maskNumbers, CATEGORY_COLORS } from "@/lib/format";
import { useApp } from "./app-state";

export type MoneyPair = { EUR: string; USD: string; BTC: string };

/**
 * De formatters met "Bedragen verbergen" erin, voor plekken waar <Money>/<Qty>/<Price> niet passen (grafiek-tooltips,
 * samengestelde regels, vrije tekst). Bedragen en aantallen worden ••••; koersen blijven zichtbaar, behalve bij
 * vastgoed (aantal altijd 1, de "koers" is de waardering van je eigen huis); `text` maskeert elk getal in servertekst.
 * Componenten importeren formatMoney/formatQuantity/formatPrice daarom niet zelf (eslint.config.mjs bewaakt dat).
 */
export function useFormat() {
  const { hideAmounts } = useApp();
  return {
    hidden: hideAmounts,
    money: (value: Decimal.Value, currency: string, opts: { decimals?: number; sign?: boolean } = {}) => formatMoney(value, currency, { ...opts, hidden: hideAmounts }),
    qty: (value: Decimal.Value) => formatQuantity(value, { hidden: hideAmounts }),
    price: (value: Decimal.Value, currency: string, opts: { decimals?: number; category?: string | null } = {}) =>
      formatPrice(value, currency, { decimals: opts.decimals, hidden: hideAmounts && opts.category === "real_estate" }),
    text: (s: string) => (hideAmounts ? maskNumbers(s) : s),
  };
}

export function Money({ value, currency, sign, className = "", decimals }: { value: MoneyPair | string; currency?: string; sign?: boolean; className?: string; decimals?: number }) {
  const app = useApp();
  const ccy = currency ?? app.currency;
  const v = typeof value === "string" ? value : value[app.currency];
  return <span className={`tnum ${className}`}>{formatMoney(v, ccy, { sign, decimals, hidden: app.hideAmounts })}</span>;
}

/** Prijs per stuk; geef `category` mee, dan wordt een vastgoedwaardering verborgen (zie useFormat). */
export function Price({ value, currency, category, className = "" }: { value: string | null; currency: string | null; category?: string | null; className?: string }) {
  const { price } = useFormat();
  if (value == null) return <span className={`text-muted ${className}`}>—</span>;
  return <span className={`tnum ${className}`}>{price(value, currency ?? "USD", { category })}</span>;
}

export function Qty({ value, className = "" }: { value: string; className?: string }) {
  const { qty } = useFormat();
  return <span className={`tnum ${className}`}>{qty(value)}</span>;
}

export function Pct({ value, sign = true, className = "" }: { value: string | null; sign?: boolean; className?: string }) {
  if (value == null) return <span className={`text-muted ${className}`}>—</span>;
  return <span className={`tnum ${className}`}>{formatPercent(value, { sign })}</span>;
}

export function colorFor(v: string | number | null | undefined): string {
  const n = Number(v ?? 0);
  if (n > 0) return "text-up";
  if (n < 0) return "text-down";
  return "text-muted";
}

/** Winst/verlies: bedrag + percentage, gekleurd, met teken. */
export function Gain({ value, pct, className = "", size = "sm" }: { value: MoneyPair | string; pct?: string | null; className?: string; size?: "sm" | "lg" }) {
  const app = useApp();
  const v = typeof value === "string" ? value : value[app.currency];
  const color = colorFor(v);
  return (
    <span className={`${color} ${size === "lg" ? "text-base font-semibold" : "text-sm"} ${className}`}>
      <Money value={v} sign />
      {/* een echte spatie (geen marge), zodat bedrag en percentage op smalle schermen over twee regels mogen */}
      {pct != null && (
        <>
          {" "}
          <span className="whitespace-nowrap opacity-90">
            (<Pct value={pct} />)
          </span>
        </>
      )}
    </span>
  );
}

/**
 * Kaart met optionele titel, actie rechts in de kop en een beschrijving van één regel onder de titel. `id` maakt de kaart
 * een anker (deeplinks als /settings/koersen#planning) met ruimte voor de sticky balken.
 */
export function Card({ children, className = "", title, action, flush = false, description, id, titleExtra }: { children: React.ReactNode; className?: string; title?: string; action?: React.ReactNode; flush?: boolean; description?: React.ReactNode; id?: string; titleExtra?: React.ReactNode }) {
  return (
    <section id={id} className={`card ${id ? "scroll-mt-20 lg:scroll-mt-8" : ""} ${flush ? "" : "p-4 sm:p-5"} ${className}`}>
      {(title || action) && (
        <div className={`flex flex-wrap items-center justify-between gap-2 ${flush ? "border-b border-border px-4 py-3 sm:px-5" : description ? "mb-1" : "mb-3"}`}>
          {title && (
            <h2 className="flex flex-wrap items-center gap-2 text-sm font-bold uppercase tracking-wide text-muted">
              {title}
              {titleExtra}
            </h2>
          )}
          {action}
        </div>
      )}
      {description && <p className={`text-sm text-muted ${flush ? "px-4 pt-3 sm:px-5" : "mb-3"}`}>{description}</p>}
      {children}
    </section>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-2 px-6 py-10 text-center">
      <p className="font-semibold">{title}</p>
      {children && <div className="text-sm text-muted">{children}</div>}
    </div>
  );
}

export function AssetLogo({ symbol, logoUrl, category, size = 36 }: { symbol: string; logoUrl?: string | null; category?: string; size?: number }) {
  const bg = CATEGORY_COLORS[category ?? ""] ?? "#4f8cff";
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoUrl} alt="" width={size} height={size} className="shrink-0 rounded-full bg-white object-contain" style={{ width: size, height: size }} />;
  }
  return (
    <span className="flex shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ width: size, height: size, background: bg }}>
      {symbol.slice(0, 4)}
    </span>
  );
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, children, wide = false }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; wide?: boolean }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  // via een ref: een nieuwe onClose bij elke render van de ouder mag de focus niet laten verspringen
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    // Focus in de dialoog (een veld met autoFocus heeft hem al), Tab blijft erin, en bij sluiten terug naar de knop die
    // hem opende: anders tabt een toetsenbordgebruiker door de pagina achter het scherm.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return close.current();
      if (e.key !== "Tab" || !panel.current) return;
      const list = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !panel.current.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`card max-h-[92dvh] w-full overflow-y-auto rounded-b-none p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] outline-none sm:rounded-2xl sm:pb-5 ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-bold">
            {title}
          </h2>
          <button onClick={onClose} className="tap -mr-1 rounded-full p-1 text-muted hover:bg-card-hover hover:text-text" aria-label="Sluiten">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function RangePills<T extends string>({ value, options, onChange }: { value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div className="scroll-x flex max-w-full gap-0.5 sm:gap-1">
      {options.map((o) => (
        <button key={o} className="pill shrink-0 !px-2.5 sm:!px-3" data-active={value === o} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "nog geen koers";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "zojuist";
  if (m < 60) return `${m} min geleden`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} uur geleden`;
  const d = Math.round(h / 24);
  return `${d} dag${d === 1 ? "" : "en"} geleden`;
}
