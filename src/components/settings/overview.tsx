"use client";

/**
 * /settings: wat nu aandacht vraagt, de index van alle categorieën met hun huidige stand, en een zoekveld. De index ís
 * hier de navigatie (geen pill-rij). Oude ankers (/settings#bitcoin uit bladwijzers en de README) gaan door naar hun
 * nieuwe plek.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useMemo, useState } from "react";
import { Bell, ChartLine, ChevronDown, CircleCheck, FolderOpen, Plug, Search, ShieldCheck, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { api, useApp } from "../app-state";
import { Card, Skeleton, useFormat } from "../ui";
import { formatDate } from "@/lib/format";
import { SETTINGS_NAV, legacyTarget, searchSettings, type SettingsCategoryId } from "@/lib/settings-nav";
import { useSettings, type AttentionItem, type InstallInfo, type OverviewData } from "./context";
import { Callout, ListRow, StatusBadge, StatusDot, type Tone } from "./ui";

const ICONS: Record<SettingsCategoryId, LucideIcon> = {
  weergave: SlidersHorizontal,
  portfolios: FolderOpen,
  platforms: Plug,
  koersen: ChartLine,
  meldingen: Bell,
  beveiliging: ShieldCheck,
};

const SEVERITY: Record<AttentionItem["severity"], { tone: Tone; label: string }> = {
  critical: { tone: "down", label: "Kritiek" },
  warn: { tone: "warn", label: "Let op" },
  info: { tone: "neutral", label: "Info" },
};

/** Zoveel punten staan er zonder "Nog N tonen"; een langere lijst duwt de index uit beeld. */
const VISIBLE_ITEMS = 4;

export function SettingsOverview() {
  const router = useRouter();
  const { overview, error: settingsError, overviewError, reload, reloadOverview } = useSettings();
  const error = overviewError ?? settingsError;
  const [redirecting, setRedirecting] = useState(false);

  // vóór de eerste paint, zodat bij een oud anker niets van het overzicht in beeld flitst
  useLayoutEffect(() => {
    const go = () => {
      const target = legacyTarget(window.location.hash);
      if (!target) return;
      setRedirecting(true);
      router.replace(target);
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, [router]);

  if (redirecting || (!overview && !error)) return <OverviewSkeleton />;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-xl font-extrabold">Instellingen</h1>
        <p className="text-sm text-muted">Wat nu aandacht vraagt en hoe alles staat.</p>
      </div>
      {!overview ? (
        <Callout tone="down">
          Instellingen laden mislukt: {error}{" "}
          <button
            type="button"
            className="font-semibold text-accent hover:underline"
            onClick={() => {
              reload();
              reloadOverview();
            }}
          >
            Opnieuw proberen
          </button>
        </Callout>
      ) : (
        <>
          <AttentionCard attention={overview.attention} />
          <IndexCard summaries={overview.summaries} />
          <InstallFooter install={overview.install} />
        </>
      )}
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-12 w-72 max-w-full" />
      <Skeleton className="h-28" />
      <Skeleton className="h-80" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Aandachtspunten

interface Entry {
  key: string;
  mobile: boolean;
  desktop: boolean;
  node: React.ReactNode;
}

/**
 * Rijen met een lijn ertussen, waarbij onder en vanaf lg andere rijen zichtbaar zijn. divide-y en first: tellen
 * verborgen rijen mee; daarom krijgt per breakpoint alleen de eerste zichtbare rij geen lijn.
 */
function ResponsiveRows({ entries }: { entries: Entry[] }) {
  let seenMobile = false;
  let seenDesktop = false;
  return (
    <ul className="-my-2">
      {entries.map((e) => {
        const mobile = e.mobile ? (seenMobile ? "block border-t" : "block border-t-0") : "hidden";
        const desktop = e.desktop ? (seenDesktop ? "lg:block lg:border-t" : "lg:block lg:border-t-0") : "lg:hidden";
        seenMobile ||= e.mobile;
        seenDesktop ||= e.desktop;
        return (
          <li key={e.key} className={`border-border py-2.5 ${mobile} ${desktop}`}>
            {e.node}
          </li>
        );
      })}
    </ul>
  );
}

function AttentionCard({ attention }: { attention: OverviewData["attention"] }) {
  const { toast } = useApp();
  const { reloadOverview } = useSettings();
  const [showAll, setShowAll] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // meteen weg na "Negeren", zonder op het nieuwe overzicht te wachten; per fingerprint, zodat een veranderd punt terugkomt
  const [hidden, setHidden] = useState<string[]>([]);

  const idOf = (i: AttentionItem) => `${i.key}|${i.fingerprint}`;
  const items = attention.items.filter((i) => !hidden.includes(idOf(i)));
  const dismissed = attention.dismissed + (attention.items.length - items.length);

  const dismiss = async (item: AttentionItem) => {
    setBusy(item.key);
    try {
      await api("/api/settings/attention", { method: "POST", json: { key: item.key, fingerprint: item.fingerprint } });
      setHidden((h) => [...h, idOf(item)]);
      reloadOverview();
      toast("Genegeerd tot er iets verandert");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setBusy("restore");
    try {
      await api("/api/settings/attention", { method: "DELETE" });
      setHidden([]);
      reloadOverview();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const dismissedLine =
    dismissed > 0 ? (
      <p className="text-xs text-muted">
        {dismissed} genegeerd ·{" "}
        <button type="button" className="font-semibold text-accent hover:underline disabled:opacity-50" disabled={busy != null} onClick={() => void restore()}>
          Weer tonen
        </button>
      </p>
    ) : null;

  if (!items.length) {
    return (
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p className="flex items-center gap-2 text-sm">
            <CircleCheck size={16} className="shrink-0 text-up" /> Alles in orde.
          </p>
          {dismissedLine}
        </div>
      </Card>
    );
  }

  // de server sorteert al op ernst; hier nog eens, want het inklappen op mobiel rekent erop dat kritiek vooraan staat
  const critical = items.filter((i) => i.severity === "critical");
  const others = items.filter((i) => i.severity !== "critical");
  const ordered = [...critical, ...others];
  const limit = showAll ? Infinity : VISIBLE_ITEMS;
  const othersSev = others.some((o) => o.severity === "warn") ? SEVERITY.warn : SEVERITY.info;

  // Onder lg staan alleen de kritieke punten voluit; de rest zit achter één rij die uitklapt.
  const entries: Entry[] = [];
  ordered.forEach((item, i) => {
    const isCritical = item.severity === "critical";
    if (!isCritical && i === critical.length) {
      entries.push({
        key: "mobile-toggle",
        mobile: true,
        desktop: false,
        node: (
          <button type="button" className="flex min-h-9 w-full items-center gap-2 text-left text-sm" aria-expanded={mobileOpen} onClick={() => setMobileOpen((o) => !o)}>
            <StatusBadge tone={othersSev.tone}>{othersSev.label}</StatusBadge>
            <span className="min-w-0 flex-1 font-semibold">
              {others.length} {others.length === 1 ? "punt" : "punten"} om te bekijken
            </span>
            <ChevronDown size={16} className={`shrink-0 text-muted transition-transform motion-reduce:transition-none ${mobileOpen ? "rotate-180" : ""}`} aria-hidden />
          </button>
        ),
      });
    }
    entries.push({
      key: item.key,
      desktop: i < limit,
      mobile: isCritical ? i < limit : mobileOpen,
      // één primaire knop per kaart: alleen het eerste (ernstigste) kritieke punt
      node: <AttentionRow item={item} primary={isCritical && i === 0} busy={busy != null} onDismiss={() => void dismiss(item)} />,
    });
  });

  const moreDesktop = items.length > VISIBLE_ITEMS;
  const moreMobile = critical.length > VISIBLE_ITEMS;
  const moreLabel = (n: number) => (showAll ? "Minder tonen" : `Nog ${n - VISIBLE_ITEMS} tonen`);
  const moreClass = "font-semibold text-accent hover:underline";

  return (
    <Card title="Aandachtspunten">
      <ResponsiveRows entries={entries} />
      {(moreDesktop || moreMobile || dismissedLine) && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
          {moreDesktop && (
            <button type="button" className={`hidden lg:inline ${moreClass}`} onClick={() => setShowAll((v) => !v)}>
              {moreLabel(items.length)}
            </button>
          )}
          {moreMobile && (
            <button type="button" className={`tap lg:hidden ${moreClass}`} onClick={() => setShowAll((v) => !v)}>
              {moreLabel(critical.length)}
            </button>
          )}
          {dismissedLine && <div className="ml-auto">{dismissedLine}</div>}
        </div>
      )}
    </Card>
  );
}

function AttentionRow({ item, primary, busy, onDismiss }: { item: AttentionItem; primary: boolean; busy: boolean; onDismiss: () => void }) {
  const fmt = useFormat();
  const { toast } = useApp();
  const { reloadOverview } = useSettings();
  const sev = SEVERITY[item.severity];
  // onder lg over de volle breedte op een eigen regel
  const actionClass = `${primary ? "btn" : "btn btn-ghost"} inline-flex flex-1 items-center justify-center whitespace-nowrap !py-1.5 text-xs lg:flex-none`;

  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <StatusBadge tone={sev.tone}>{sev.label}</StatusBadge>
        {/* de body kan een foutmelding van een koppeling bevatten, met bedragen erin */}
        <p className="min-w-0 break-words text-sm">
          <b>{item.title}</b> {fmt.text(item.body)}
        </p>
      </div>
      <div className="flex items-center gap-3 lg:shrink-0">
        {item.action.download ? (
          <a
            href={item.action.href}
            download
            className={actionClass}
            onClick={() => {
              toast("Back-up wordt gedownload");
              // de server noteert de back-up bij het downloaden; daarna verdwijnt dit punt
              setTimeout(reloadOverview, 3000);
            }}
          >
            {item.action.label}
          </a>
        ) : (
          <Link href={item.action.href} className={actionClass}>
            {item.action.label}
          </Link>
        )}
        {item.dismissible && (
          <button type="button" className="tap text-xs text-muted hover:text-text disabled:opacity-50" disabled={busy} onClick={onDismiss}>
            Negeren
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Index en zoeken

function IndexCard({ summaries }: { summaries: OverviewData["summaries"] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const hits = useMemo(() => searchSettings(query), [query]);
  const searching = query.trim() !== "";

  const search = (
    <div className="relative w-full lg:w-96">
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
      <input
        type="search"
        className="input !pl-9"
        placeholder="Zoek een instelling, bijv. FIFO, node of back-up"
        aria-label="Zoek een instelling"
        enterKeyHint="go"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits[0]) {
            e.preventDefault();
            router.push(hits[0].href);
          }
          if (e.key === "Escape") setQuery("");
        }}
      />
    </div>
  );

  return (
    <Card title="Alle instellingen" action={search}>
      {searching ? (
        hits.length ? (
          <ul className="space-y-1">
            {hits.map((h) => (
              <ListRow key={`${h.href}|${h.label}`} href={h.href} title={h.label} meta={h.category} />
            ))}
          </ul>
        ) : (
          <p className="py-2 text-sm text-muted">Niets gevonden.</p>
        )
      ) : (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {SETTINGS_NAV.map((c) => {
            const Icon = ICONS[c.id];
            const summary = summaries[c.id];
            return (
              <ListRow
                key={c.id}
                href={c.href}
                title={c.label}
                meta={summary?.text}
                leading={
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-card text-muted">
                    <Icon size={18} aria-hidden />
                  </span>
                }
                trailing={summary?.level ? <StatusDot level={summary.level} /> : undefined}
              />
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Voetregel

function InstallFooter({ install }: { install: InstallInfo }) {
  // een kale datum (JJJJ-MM-DD) op het middaguur, zodat hij in geen enkele tijdzone een dag verschuift
  const fxDate = install.fxDate ? formatDate(/^\d{4}-\d{2}-\d{2}$/.test(install.fxDate) ? `${install.fxDate}T12:00:00Z` : install.fxDate) : null;
  const parts = [install.version ? `Netwrth ${install.version}` : null, fxDate ? `wisselkoersen van ${fxDate}` : null, install.timezone ? `tijden in ${install.timezone}` : null].filter(Boolean);
  return (
    <p className="px-1 text-xs text-muted">
      {parts.map((p) => `${p} · `).join("")}
      <Link href="/settings/beveiliging#backup" className="text-accent hover:underline">
        bewaar secret.key bij je back-up
      </Link>
    </p>
  );
}
