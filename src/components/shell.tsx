"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LayoutDashboard, ArrowLeftRight, Bell, Settings, PieChart, RefreshCw, Upload, LogOut, Eye, EyeOff } from "lucide-react";
import { useApp, type Ccy } from "./app-state";
import { currencySymbol } from "@/lib/format";

const NAV = [
  { href: "/", label: "Portfolio", icon: LayoutDashboard },
  { href: "/transactions", label: "Transacties", icon: ArrowLeftRight },
  { href: "/allocation", label: "Allocatie", icon: PieChart },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/settings", label: "Instellingen", icon: Settings },
];

/**
 * Weergavevaluta; dezelfde opgeslagen instelling als Instellingen → Weergave (die gebruikt deze component ook).
 * `onResult` krijgt de uitkomst van het opslaan, voor de inline "Opgeslagen" daar.
 */
export function CurrencyToggle({ onResult, full = false }: { onResult?: (error: string | null) => void; full?: boolean }) {
  const { currency, setCurrency, toast } = useApp();
  const choose = (c: Ccy) => {
    if (c === currency) return;
    setCurrency(c).then(
      () => onResult?.(null),
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (onResult) onResult(msg);
        else toast(msg, "error");
      }
    );
  };
  return (
    <div className={`flex rounded-full border border-border bg-bg-elev p-0.5 text-xs font-bold ${full ? "w-full" : ""}`} role="group" aria-label="Weergavevaluta">
      {(["EUR", "USD", "BTC"] as const).map((c) => (
        <button key={c} onClick={() => choose(c)} className={`min-w-9 rounded-full px-3 py-2 transition lg:min-w-0 lg:py-1 ${full ? "flex-1 lg:py-1.5" : ""} ${currency === c ? "bg-accent text-white" : "text-muted hover:text-text"}`} aria-pressed={currency === c} aria-label={c} title={c}>
          {currencySymbol(c)}
          <span className="hidden sm:inline"> {c}</span>
        </button>
      ))}
    </div>
  );
}

export function PortfolioPicker() {
  const { portfolioId, setPortfolioId, portfolios } = useApp();
  const active = portfolios.filter((p) => !p.archived);
  return (
    <select className="input min-w-0 !w-auto max-w-[45vw] truncate !py-1.5 text-sm font-semibold lg:max-w-none" value={portfolioId == null ? "all" : String(portfolioId)} onChange={(e) => setPortfolioId(e.target.value === "all" ? null : Number(e.target.value))} aria-label="Portfolio">
      <option value="all">Alle portfolios</option>
      {active.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

/** Bedragen en aantallen worden ••••, zodat niemand kan meekijken; per apparaat onthouden (zie app-state). */
export function HideAmountsToggle({ compact = false }: { compact?: boolean }) {
  const { hideAmounts, setHideAmounts } = useApp();
  const Icon = hideAmounts ? EyeOff : Eye;
  return (
    <button onClick={() => setHideAmounts(!hideAmounts)} className={`btn btn-ghost flex items-center gap-2 !py-1.5 ${compact ? "!px-2.5" : ""} ${hideAmounts ? "!border-accent !bg-accent-soft !text-accent" : ""}`} aria-pressed={hideAmounts} title="Bedragen verbergen" aria-label="Bedragen verbergen">
      <Icon size={16} />
      {!compact && <span className="hidden sm:inline">Bedragen verbergen</span>}
    </button>
  );
}

export function RefreshButton({ compact = false }: { compact?: boolean }) {
  const { refreshing, refreshPrices } = useApp();
  return (
    <button onClick={() => void refreshPrices()} disabled={refreshing} className={`btn btn-ghost flex items-center gap-2 !py-1.5 ${compact ? "!px-2.5" : ""}`} title="Koersen verversen" aria-label="Koersen verversen">
      <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
      {!compact && <span className="hidden sm:inline">Verversen</span>}
    </button>
  );
}

/**
 * Rode stip op Instellingen bij kritieke punten (geen wachtwoord, geen herstelcode, een koppeling in fout). De eerste
 * waarde komt van de server (layout), daarna opnieuw na elke wijziging in de app.
 */
function useSettingsCritical(initial: number): number {
  const [n, setN] = useState(initial);
  const { version } = useApp();
  useEffect(() => {
    if (version === 0) return;
    fetch("/api/settings/overview?only=critical")
      .then((r) => r.json())
      .then((j) => setN(typeof j?.critical === "number" ? j.critical : 0))
      .catch(() => undefined);
  }, [version]);
  return n;
}

function SettingsDot({ count }: { count: number }) {
  if (!count) return null;
  return <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-down ring-2 ring-bg-elev" role="status" aria-label="Instellingen: actie nodig" title="Instellingen: actie nodig" />;
}

function UnreadBadge() {
  const [n, setN] = useState(0);
  const { version } = useApp();
  useEffect(() => {
    fetch("/api/notifications?unread=1")
      .then((r) => r.json())
      .then((j) => setN(Array.isArray(j) ? j.length : 0))
      .catch(() => undefined);
  }, [version]);
  if (!n) return null;
  return <span className="absolute -right-1 -top-1 rounded-full bg-down px-1.5 text-[10px] font-bold text-white">{n}</span>;
}

export function LogoutButton({ compact = false }: { compact?: boolean }) {
  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.reload();
  };
  return (
    <button onClick={() => void logout()} className={compact ? "flex flex-col items-center gap-1 rounded-lg px-3 py-1 text-[11px] font-semibold text-muted" : "btn btn-ghost flex items-center gap-2 !py-1.5"} title="Uitloggen">
      <LogOut size={compact ? 20 : 16} />
      {compact ? "Uitloggen" : <span className="hidden sm:inline">Uitloggen</span>}
    </button>
  );
}

/** `authEnabled`: er is een wachtwoord ingesteld, dus toon de uitlogknop. */
export function Shell({ children, authEnabled = false, settingsCritical = 0 }: { children: React.ReactNode; authEnabled?: boolean; settingsCritical?: number }) {
  const pathname = usePathname();
  const critical = useSettingsCritical(settingsCritical);
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-bg-elev px-4 py-6 lg:flex">
        <Link href="/" className="mb-8 flex items-center gap-2 px-2 text-lg font-extrabold tracking-tight">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" className="h-8 w-8" />
          Netwrth
        </Link>
        <nav className="flex flex-col gap-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link key={href} href={href} className={`relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${active ? "bg-accent-soft text-accent" : "text-muted hover:bg-card hover:text-text"}`}>
                <span className="relative">
                  <Icon size={18} />
                  {href === "/alerts" && <UnreadBadge />}
                  {href === "/settings" && <SettingsDot count={critical} />}
                </span>
                {label}
              </Link>
            );
          })}
          <Link href="/import" className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${pathname.startsWith("/import") ? "bg-accent-soft text-accent" : "text-muted hover:bg-card hover:text-text"}`}>
            <Upload size={18} /> Import
          </Link>
        </nav>
        <div className="mt-auto flex flex-col gap-3 px-1">
          <PortfolioPicker />
          <CurrencyToggle />
          <HideAmountsToggle />
          <RefreshButton />
          {authEnabled && <LogoutButton />}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex items-center justify-between gap-2 border-b border-border bg-bg/80 px-4 py-3 backdrop-blur lg:hidden">
          <PortfolioPicker />
          <div className="flex shrink-0 items-center gap-1.5">
            <HideAmountsToggle compact />
            <CurrencyToggle />
            <RefreshButton compact />
          </div>
        </header>
        <main className="safe-bottom mx-auto w-full max-w-6xl px-4 py-4 lg:px-8 lg:py-8">{children}</main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t border-border bg-bg-elev/95 px-2 pb-[env(safe-area-inset-bottom)] pt-2 backdrop-blur lg:hidden">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href) || (href === "/transactions" && pathname.startsWith("/import"));
          return (
            <Link key={href} href={href} className={`relative flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg px-1 py-1 text-[11px] font-semibold ${active ? "text-accent" : "text-muted"}`}>
              <span className="relative">
                <Icon size={20} />
                {href === "/alerts" && <UnreadBadge />}
                {href === "/settings" && <SettingsDot count={critical} />}
              </span>
              {label}
            </Link>
          );
        })}
        {authEnabled && <LogoutButton compact />}
      </nav>
    </div>
  );
}
