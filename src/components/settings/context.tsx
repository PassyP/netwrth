"use client";

/**
 * Gedeelde staat van de instellingenpagina's: één fetch van /api/settings (blijft staan bij navigatie tussen de
 * subroutes, want de layout blijft gemount), een save() met status per veld, het statusoverzicht voor de stippen in de
 * navigatie, en de paginakop met terug-link en (vanaf lg) de rij met categorieën.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { useApi, useApp, api } from "../app-state";
import { SETTINGS_NAV, type SettingsCategoryId } from "@/lib/settings-nav";
import type { AppSettings } from "@/lib/settings";
import { StatusDot, type SaveStatus } from "./ui";

export interface MaskedSecret {
  present: boolean;
  last4: string | null;
  updatedAt: string | null;
}

export interface InstallInfo {
  version: string;
  fxDate: string | null;
  timezone: string;
  lastBackupAt: string | null;
  secretSource: "env" | "file";
  dataDir: string;
  bitcoinApiUrlSource: "user" | "env" | "none";
}

export interface SettingsData {
  settings: AppSettings;
  secrets: { etoroApiKey: MaskedSecret; etoroUserKey: MaskedSecret };
  pushSubs: number;
  passwordSet: boolean;
  recoveryCodeSet: boolean;
  install: InstallInfo;
}

export interface AttentionItem {
  key: string;
  severity: "critical" | "warn" | "info";
  title: string;
  body: string;
  action: { label: string; href: string; download?: boolean };
  fingerprint: string;
  dismissible: boolean;
}

export interface OverviewData {
  attention: { items: AttentionItem[]; dismissed: number };
  summaries: Record<SettingsCategoryId, { text: string; level: "critical" | "warn" | null }>;
  install: InstallInfo;
}

/** Wijzigingen die cijfers in de rest van de app veranderen: daarna laadt alles opnieuw (bump). */
const AFFECTS_NUMBERS: (keyof AppSettings)[] = ["displayCurrency", "costMethod", "ignoreFx", "hideDust"];

interface SettingsCtx {
  data: SettingsData | null;
  error: string | null;
  reload: () => void;
  overview: OverviewData | null;
  overviewError: string | null;
  reloadOverview: () => void;
  /** Slaat op als er echt iets verandert; geeft null (gelukt) of de foutmelding terug. Status per veld in `status`. */
  save: (patch: Partial<AppSettings>, field?: string) => Promise<string | null>;
  status: Record<string, SaveStatus>;
}

const Ctx = createContext<SettingsCtx | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const { bump } = useApp();
  const { data: fetched, error, reload } = useApi<SettingsData>("/api/settings");
  const { data: overview, error: overviewError, reload: reloadOverview } = useApi<OverviewData>("/api/settings/overview");
  const [data, setData] = useState<SettingsData | null>(null);
  const [status, setStatusMap] = useState<Record<string, SaveStatus>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    if (fetched) setData(fetched);
  }, [fetched]);
  useEffect(() => {
    const t = timers.current;
    return () => Object.values(t).forEach(clearTimeout);
  }, []);

  const setStatus = useCallback((field: string, s: SaveStatus, clearAfterMs?: number) => {
    setStatusMap((m) => ({ ...m, [field]: s }));
    if (timers.current[field]) clearTimeout(timers.current[field]);
    if (clearAfterMs) timers.current[field] = setTimeout(() => setStatusMap((m) => ({ ...m, [field]: null })), clearAfterMs);
  }, []);

  const save = useCallback(
    async (patch: Partial<AppSettings>, field?: string): Promise<string | null> => {
      const key = field ?? Object.keys(patch)[0] ?? "settings";
      const current = data?.settings;
      const changed = Object.entries(patch).filter(([k, v]) => v !== undefined && current?.[k as keyof AppSettings] !== v);
      if (!changed.length) return null;
      setStatus(key, { kind: "saving" });
      try {
        const updated = await api<AppSettings>("/api/settings", { method: "PATCH", json: Object.fromEntries(changed) });
        setData((d) => (d ? { ...d, settings: updated } : d));
        setStatus(key, { kind: "saved" }, 2000);
        if (changed.some(([k]) => AFFECTS_NUMBERS.includes(k as keyof AppSettings))) bump();
        else reloadOverview();
        return null;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus(key, { kind: "error", message: msg });
        return msg;
      }
    },
    [data, setStatus, bump, reloadOverview]
  );

  return <Ctx.Provider value={{ data, error, reload, overview, overviewError, reloadOverview, save, status }}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSettings buiten SettingsProvider");
  return v;
}

/**
 * Scrollt naar het anker in de URL zodra de pagina zijn data heeft (een native anker-scroll mist het doel, omdat eerst
 * een skeleton staat), en bij latere hash-wijzigingen.
 */
export function useScrollToHash(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    const go = () => {
      const raw = window.location.hash.slice(1);
      let id = raw;
      try {
        id = decodeURIComponent(raw);
      } catch {
        /* kapotte %-code in een link: dan het anker zoals het er staat */
      }
      const el = id ? document.getElementById(id) : null;
      if (el && !stopped) el.scrollIntoView({ block: "start" });
    };
    // Kaarten die later hun data krijgen (en de scroll-afhandeling van de router) verschuiven het doel nog even:
    // blijf het anker volgen zolang de pagina groeit, tot de gebruiker zelf scrolt of na twee seconden.
    const stop = () => {
      stopped = true;
      observer.disconnect();
    };
    const observer = new ResizeObserver(() => go());
    observer.observe(document.body);
    // In een verborgen tab draaien rAF en ResizeObserver niet: daar telt het venster pas vanaf het moment van tonen.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startWindow = () => {
      if (!document.hidden && !timer) timer = setTimeout(stop, 2000);
    };
    startWindow();
    document.addEventListener("visibilitychange", startWindow);
    const userScroll = () => stop();
    window.addEventListener("wheel", userScroll, { passive: true });
    window.addEventListener("touchmove", userScroll, { passive: true });
    window.addEventListener("keydown", userScroll);
    go();
    requestAnimationFrame(go);
    const onHash = () => {
      stopped = false;
      go();
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      stop();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", startWindow);
      window.removeEventListener("wheel", userScroll);
      window.removeEventListener("touchmove", userScroll);
      window.removeEventListener("keydown", userScroll);
      window.removeEventListener("hashchange", onHash);
    };
  }, [ready]);
}

/**
 * Kop van een instellingenpagina: terug-link, titel (gelijk aan het label in de navigatie), één regel uitleg en vanaf lg
 * een rij met de categorieën (breekt af in plaats van horizontaal te scrollen). Onder lg is /settings de navigatie.
 */
export function SettingsPageHeader({ category, title, description, back = { href: "/settings", label: "Instellingen" }, right }: { category: SettingsCategoryId; title?: React.ReactNode; description?: React.ReactNode; back?: { href: string; label: string }; right?: React.ReactNode }) {
  const { overview } = useSettings();
  const pathname = usePathname();
  const cat = SETTINGS_NAV.find((c) => c.id === category)!;
  return (
    <div className="space-y-1">
      <Link href={back.href} className="tap -ml-1 inline-flex items-center gap-0.5 rounded-lg pr-2 text-sm text-muted hover:text-text">
        <ChevronLeft size={16} /> {back.label}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex min-w-0 flex-wrap items-center gap-2 text-xl font-extrabold">{title ?? cat.label}</h1>
        {right}
      </div>
      {(description ?? (title ? null : cat.description)) && <p className="text-sm text-muted">{description ?? cat.description}</p>}
      <nav aria-label="Instellingen" className="!mt-4 hidden flex-wrap gap-1 border-b border-border pb-4 lg:flex">
        {SETTINGS_NAV.map((c) => {
          const active = pathname === c.href || pathname.startsWith(`${c.href}/`);
          return (
            <Link key={c.id} href={c.href} className="pill inline-flex items-center gap-1.5" data-active={active} aria-current={active ? "page" : undefined}>
              {c.label}
              <StatusDot level={overview?.summaries[c.id]?.level} />
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** Ruimte tussen de kop en de kaarten, en tussen de kaarten. */
export function SettingsStack({ children }: { children: React.ReactNode }) {
  return <div className="space-y-4">{children}</div>;
}
