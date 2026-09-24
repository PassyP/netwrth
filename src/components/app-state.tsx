"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { HIDE_AMOUNTS_COOKIE, setDisplayTimeZone } from "@/lib/format";

export type Ccy = "EUR" | "USD" | "BTC";

interface AppState {
  currency: Ccy;
  /** Wijzigt de weergavevaluta op alle apparaten (opgeslagen); bij een fout gaat de keuze terug en volgt een Error. */
  setCurrency: (c: Ccy) => Promise<void>;
  hideAmounts: boolean; // "Bedragen verbergen": bedragen en aantallen worden •••• (zie useFormat in ui.tsx)
  setHideAmounts: (v: boolean) => void;

  portfolioId: number | null; // null = alles
  setPortfolioId: (id: number | null) => void;
  portfolios: { id: number; name: string; archived: boolean }[];
  reloadPortfolios: () => Promise<void>;
  version: number; // verhoogt na elke wijziging → data opnieuw laden
  bump: () => void;
  refreshing: boolean;
  refreshPrices: () => Promise<void>;
  toast: (msg: string, kind?: "ok" | "error") => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children, initialCurrency, initialHideAmounts, timeZone }: { children: React.ReactNode; initialCurrency: Ccy; initialHideAmounts: boolean; timeZone?: string }) {
  // Datums en tijden in de tijdzone van de instellingen, al bij de eerste render. Alleen bij een nieuwe waarde van de
  // server: een wijziging in Koersen en planning zet de zone meteen zelf, en een latere render met de oude prop (de
  // layout wordt bij client-navigatie niet opnieuw geladen) mag die niet terugdraaien.
  const appliedTimeZone = useRef<string | undefined>(undefined);
  if (appliedTimeZone.current !== timeZone) {
    appliedTimeZone.current = timeZone;
    setDisplayTimeZone(timeZone);
  }
  const [currency, setCurrencyState] = useState<Ccy>(initialCurrency);
  const [hideAmounts, setHideAmountsState] = useState(initialHideAmounts);
  const [portfolioId, setPortfolioIdState] = useState<number | null>(null);
  const [portfolios, setPortfolios] = useState<AppState["portfolios"]>([]);
  const [version, setVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: "ok" | "error" }[]>([]);

  useEffect(() => {
    try {
      const p = localStorage.getItem("pm.portfolioId");
      if (p != null && p !== "") setPortfolioIdState(p === "all" ? null : Number(p));
    } catch {}
  }, []);

  const reloadPortfolios = useCallback(async () => {
    const r = await fetch("/api/portfolios");
    if (r.ok) setPortfolios(await r.json());
  }, []);

  useEffect(() => {
    void reloadPortfolios();
  }, [reloadPortfolios, version]);

  const setCurrency = useCallback(
    async (c: Ccy) => {
      const previous = currency;
      setCurrencyState(c);
      try {
        localStorage.setItem("pm.currency", c);
      } catch {}
      const r = await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayCurrency: c }) }).catch(() => null);
      if (!r || !r.ok) {
        setCurrencyState(previous);
        const j = r ? await r.json().catch(() => null) : null;
        throw new Error(j?.error ?? "Valuta opslaan mislukt");
      }
    },
    [currency]
  );

  // per apparaat (cookie, niet in de database): op je telefoon verborgen terwijl de desktop thuis alles toont. Geen
  // Secure-vlag, want de app draait ook via http op het thuisnetwerk.
  const setHideAmounts = useCallback((v: boolean) => {
    setHideAmountsState(v);
    document.cookie = `${HIDE_AMOUNTS_COOKIE}=${v ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  }, []);

  const setPortfolioId = useCallback((id: number | null) => {
    setPortfolioIdState(id);
    try {
      localStorage.setItem("pm.portfolioId", id == null ? "all" : String(id));
    } catch {}
  }, []);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const toast = useCallback((msg: string, kind: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const refreshPrices = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch("/api/refresh", { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "Verversen mislukt");
      const walletFailed = ((data.wallets ?? []) as { ok: boolean }[]).filter((w) => !w.ok).length;
      const failed = [...new Set(((data.failed ?? []) as { asset: string }[]).map((f) => f.asset))];
      const failedText = failed.length ? `, ${failed.length} mislukt (${failed.slice(0, 4).join(", ")}${failed.length > 4 ? ", …" : ""})` : "";
      toast(`${data.updated} koersen bijgewerkt${failedText}${walletFailed ? `, wallet-sync mislukt (${walletFailed})` : ""}`, failed.length || walletFailed ? "error" : "ok");
      bump();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Verversen mislukt", "error");
    } finally {
      setRefreshing(false);
    }
  }, [bump, toast]);

  const value = useMemo<AppState>(
    () => ({ currency, setCurrency, hideAmounts, setHideAmounts, portfolioId, setPortfolioId, portfolios, reloadPortfolios, version, bump, refreshing, refreshPrices, toast }),
    [currency, setCurrency, hideAmounts, setHideAmounts, portfolioId, setPortfolioId, portfolios, reloadPortfolios, version, bump, refreshing, refreshPrices, toast]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="fixed left-1/2 top-4 z-[100] flex -translate-x-1/2 flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`card px-4 py-2 text-sm shadow-lg ${t.kind === "error" ? "border-down text-down" : "border-up text-up"}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp buiten AppStateProvider");
  return v;
}

/** Eenvoudige data-hook: laadt opnieuw als url of app.version verandert. */
export function useApi<T>(url: string | null): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const { version } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!url);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setLoading(true);
    fetch(url)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? r.statusText);
        return j as T;
      })
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [url, version, tick]);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

export async function api<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { ...(init?.json !== undefined ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const text = await r.text();
  const j = text ? JSON.parse(text) : null;
  // Sessie verlopen: herladen toont het inlogscherm.
  if (r.status === 401 && j?.error === "Niet ingelogd" && typeof window !== "undefined") window.location.reload();
  if (!r.ok) throw new Error(j?.error ?? r.statusText);
  return j as T;
}
