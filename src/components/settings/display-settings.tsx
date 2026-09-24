"use client";

/**
 * /settings/weergave: hoe bedragen en lijsten eruitzien (valuta, stofposities, bedragen verbergen) en hoe winst en
 * verlies worden berekend. Kostprijsmethode en valuta-effect herberekenen alle W/V-cijfers en vragen daarom eerst om
 * bevestiging; de rest slaat direct op.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../app-state";
import { CurrencyToggle } from "../shell";
import { Card, Skeleton } from "../ui";
import { dustLabel } from "@/lib/format";
import type { AppSettings } from "@/lib/settings";
import { SettingsPageHeader, SettingsStack, useScrollToHash, useSettings } from "./context";
import { Callout, ConfirmDialog, Disclosure, SaveState, Segmented, SettingRow, SettingRows, StatusBadge, Switch, type SaveStatus } from "./ui";

type Pending = { costMethod: AppSettings["costMethod"] } | { ignoreFx: boolean };

function confirmTitle(p: Pending): string {
  if ("costMethod" in p) return p.costMethod === "fifo" ? "Overschakelen naar FIFO?" : "Overschakelen naar gemiddelde kostprijs?";
  return p.ignoreFx ? "Valuta-effect negeren?" : "Valuta-effect meenemen?";
}

/** Status voor wat niet via save() van de instellingen loopt (valuta via de valutaknop, bedragen verbergen per apparaat). */
function useLocalStatus(): [SaveStatus, (s: SaveStatus) => void] {
  const [status, setStatus] = useState<SaveStatus>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const set = useCallback((s: SaveStatus) => {
    if (timer.current) clearTimeout(timer.current);
    setStatus(s);
    if (s?.kind === "saved") timer.current = setTimeout(() => setStatus(null), 2000);
  }, []);
  return [status, set];
}

export function DisplaySettings() {
  const { data, error, reload, reloadOverview, save, status } = useSettings();
  const { currency, hideAmounts, setHideAmounts } = useApp();
  const [currencyStatus, setCurrencyStatus] = useLocalStatus();
  const [amountsStatus, setAmountsStatus] = useLocalStatus();
  const [pending, setPending] = useState<Pending | null>(null);
  useScrollToHash(!!data);

  if (!data) {
    return (
      <div className="space-y-4">
        <SettingsPageHeader category="weergave" />
        {error ? (
          <Callout tone="down">Instellingen laden mislukt: {error}</Callout>
        ) : (
          <SettingsStack>
            <Skeleton className="h-64" />
            <Skeleton className="h-56" />
          </SettingsStack>
        )}
      </div>
    );
  }

  const s = data.settings;

  return (
    <div className="space-y-4">
      <SettingsPageHeader category="weergave" />
      <SettingsStack>
        <Card title="Weergave" id="weergave" description="Hoe bedragen en lijsten eruitzien. Verandert geen cijfers.">
          <SettingRows>
            {/* één schrijver voor de valuta: dezelfde component en opslag als de valutaknop in de navigatie */}
            <SettingRow label="Valuta" description="Zelfde keuze als de valutaknop in de zijbalk (mobiel: bovenbalk); geldt op al je apparaten.">
              <CurrencyToggle
                full
                onResult={(err) => {
                  if (err) return setCurrencyStatus({ kind: "error", message: err });
                  setCurrencyStatus({ kind: "saved" });
                  reload();
                  reloadOverview();
                }}
              />
              <SaveState status={currencyStatus} />
            </SettingRow>
            <SettingRow
              inline
              label="Stofposities verbergen"
              description={`Posities onder ${dustLabel(currency)}${currency === "BTC" ? " (ook in BTC-weergave)" : ""} verdwijnen uit lijsten; ze tellen wel mee in de totalen.`}
            >
              <Switch checked={s.hideDust} onChange={(v) => void save({ hideDust: v })} label="Stofposities verbergen" />
              <SaveState status={status.hideDust ?? null} />
            </SettingRow>
          </SettingRows>
          <Disclosure summary="Waar precies?">
            <p>In de positielijst, de kas per platform, de allocatie en het assetfilter bij transacties. Op het portfolio-overzicht kun je ze tijdelijk tonen. De drempel is vast: € 1, of $ 1 in dollarweergave.</p>
          </Disclosure>
          <SettingRows className="mt-2 border-t border-border pt-2">
            <SettingRow inline label="Bedragen verbergen" badge={<StatusBadge tone="neutral">Dit apparaat</StatusBadge>} description="Maskeert bedragen en aantallen op dit apparaat; hetzelfde als het oogje in de zijbalk (mobiel: bovenbalk).">
              <Switch
                checked={hideAmounts}
                onChange={(v) => {
                  setHideAmounts(v);
                  setAmountsStatus({ kind: "saved" });
                }}
                label="Bedragen verbergen"
              />
              <SaveState status={amountsStatus} />
            </SettingRow>
          </SettingRows>
        </Card>

        <Card title="Berekening" id="berekening" description="Bepaalt hoe winst en verlies worden berekend. Wijzigen herberekent alle W/V-cijfers in de app.">
          <SettingRows>
            <SettingRow label="Kostprijsmethode" description={s.costMethod === "fifo" ? "FIFO: het oudste lot wordt eerst verkocht." : "Gemiddeld: een verkoop verlaagt elk lot naar rato."}>
              {/* de control blijft op de opgeslagen waarde tot je bevestigt */}
              <Segmented
                label="Kostprijsmethode"
                value={s.costMethod}
                options={[
                  { value: "average", label: "Gemiddeld" },
                  { value: "fifo", label: "FIFO" },
                ]}
                onChange={(v) => setPending({ costMethod: v })}
              />
              <SaveState status={status.costMethod ?? null} />
            </SettingRow>
            <SettingRow label="Valuta-effect in winst/verlies" description={s.ignoreFx ? "Alles tegen de wisselkoers van vandaag." : "Kostprijs tegen de wisselkoers van de aankoopdatum (zoals Delta en Swissquote)."}>
              <Segmented
                label="Valuta-effect in winst/verlies"
                value={s.ignoreFx ? "neg" : "mee"}
                options={[
                  { value: "mee", label: "Meenemen" },
                  { value: "neg", label: "Negeren" },
                ]}
                onChange={(v) => setPending({ ignoreFx: v === "neg" })}
              />
              <SaveState status={status.ignoreFx ?? null} />
            </SettingRow>
          </SettingRows>
          <Disclosure summary="Meer uitleg" className="mt-1">
            <p>
              <b>Gemiddeld</b>: alle aankopen van een asset vormen samen één gemiddelde kostprijs. Verkoop je een deel, dan daalt de kostprijs van elk lot naar rato en blijft de gemiddelde prijs per stuk gelijk.
            </p>
            <p>
              <b>FIFO</b> (first in, first out): een verkoop haalt eerst de oudste aankoop weg. De gerealiseerde winst hangt dan af van wat je voor juist die stukken betaalde, en wat overblijft houdt de prijs van de latere aankopen.
            </p>
            <p>
              <b>Valuta-effect</b>: koop je in dollars terwijl je in euro&apos;s kijkt, dan beweegt je W/V ook met de wisselkoers. Meenemen rekent de kostprijs om tegen de koers van de aankoopdatum, zodat koers- en valutaresultaat samen in je W/V zitten. Negeren rekent alles tegen de koers van vandaag, zodat je alleen de koersbeweging van het asset zelf ziet.
            </p>
            <p>Beide keuzes veranderen alleen de berekening; je transacties blijven hetzelfde.</p>
          </Disclosure>
          <p className="mt-3 text-xs text-muted">
            De kostprijs van wallet-ontvangsten zonder herkende tegenpartij stel je per wallet in, bij{" "}
            <Link href="/settings/platforms" className="text-accent hover:underline">
              Platforms en koppelingen
            </Link>
            .
          </p>
        </Card>
      </SettingsStack>

      <ConfirmDialog
        open={pending != null}
        title={pending ? confirmTitle(pending) : ""}
        confirmLabel="Overschakelen"
        onClose={() => setPending(null)}
        onConfirm={async () => {
          // een fout staat daarna bij het veld zelf (SaveState), dus de dialoog mag altijd dicht
          if (pending) await save(pending);
          setPending(null);
        }}
      >
        <p>Alle gerealiseerde en ongerealiseerde W/V-cijfers worden herberekend. Je kunt altijd terugzetten.</p>
      </ConfirmDialog>
    </div>
  );
}
