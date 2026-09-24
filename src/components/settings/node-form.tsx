"use client";

/**
 * Instellen van de Bitcoin-node, gedeeld door de kaart Bitcoin-node (Platforms en koppelingen) en de inline stap in de
 * koppelingswizard. De eigen node is de weg; de publieke terugval is bewust een tweede stap met een waarschuwing,
 * omdat een publieke node de adressen van je wallet ziet. Testen gebeurt alleen op een klik en de knop is uitgeschakeld
 * zolang een test loopt (publieke nodes blokkeren een IP bij veel verzoeken).
 */
import { useState } from "react";
import { api } from "../app-state";
import { useSettings } from "./context";
import { Callout, CommitInput, Disclosure, InlineResult, SettingRow, SettingRows, StatusBadge, type TestResult } from "./ui";

const httpUrl = (v: string) => (v === "" || /^https?:\/\/\S+$/i.test(v) ? null : "De URL moet met http:// of https:// beginnen");
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function useNodeTest() {
  const [result, setResult] = useState<TestResult>(null);
  const run = async (url: string, who: string) => {
    setResult({ busy: true, message: `${who} testen… (een trage publieke node kan tot een minuut duren)` });
    try {
      const r = await api<{ ok: boolean; message: string }>("/api/settings/bitcoin-test", { method: "POST", json: { url } });
      setResult({ ok: r.ok, message: `${who}: ${r.message}` });
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  };
  return { result, run, busy: !!result && "busy" in result };
}

export function NodeForm({ variant, onConfigured }: { variant: "card" | "wizard"; onConfigured?: () => void }) {
  const { data, save, reload } = useSettings();
  const own = useNodeTest();
  const pub = useNodeTest();
  const [confirmPublic, setConfirmPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  const s = data.settings;
  const fromEnv = data.install.bitcoinApiUrlSource === "env";

  const saveOwn = async (v: string) => {
    const err = await save({ bitcoinApiUrl: v }, "bitcoinApiUrl");
    if (err) return err;
    reload(); // de bron (eigen invoer of BITCOIN_API_URL) kan veranderd zijn, en die staat niet in de PATCH-respons
    if (v) onConfigured?.();
    return null;
  };
  const enableFallback = async (on: boolean) => {
    setError(null);
    const err = await save({ bitcoinFallbackEnabled: on }, "bitcoinFallbackEnabled");
    if (err) setError(err);
    else {
      setConfirmPublic(false);
      if (on) onConfigured?.();
    }
  };

  const ownField = (
    <>
      <CommitInput
        label="URL van je eigen node"
        type="url"
        placeholder="http://umbrel.local:3006"
        value={fromEnv ? "" : s.bitcoinApiUrl}
        validate={httpUrl}
        onCommit={saveOwn}
        after={
          <button type="button" className="btn btn-ghost shrink-0 !py-2 text-xs" disabled={own.busy || (!s.bitcoinApiUrl && !fromEnv)} onClick={() => void own.run(s.bitcoinApiUrl, "Eigen node")}>
            Testen
          </button>
        }
      />
      {fromEnv && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <StatusBadge tone="neutral">uit omgeving</StatusBadge> Nu gebruikt: <span className="font-mono">{s.bitcoinApiUrl}</span> (BITCOIN_API_URL). Vul een URL in om die te vervangen.
        </p>
      )}
      <InlineResult result={own.result} />
    </>
  );

  const publicWarning = (
    <Callout tone="warn">
      <p>
        <b className="text-text">Een publieke node ziet de adressen van je wallet.</b> Hij remt bovendien af of blokkeert tijdelijk bij veel verzoeken; voor grote wallets is je eigen node de enige goede bron.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="btn btn-ghost !py-1.5 text-xs" onClick={() => void enableFallback(true)}>
          Toch de publieke node gebruiken
        </button>
        <button type="button" className="btn btn-ghost !py-1.5 text-xs" onClick={() => setConfirmPublic(false)}>
          Annuleren
        </button>
      </div>
    </Callout>
  );

  if (variant === "wizard") {
    return (
      <div className="space-y-2 rounded-xl border border-warn/40 bg-warn/10 p-3">
        <p className="text-sm font-semibold">Stel eerst je Bitcoin-node in</p>
        <p className="text-xs text-muted">De mempool-app op je Umbrel, bijv. http://umbrel.local:3006 (vanaf een Mac in je netwerk) of http://10.21.21.26:3006 (binnen Umbrel). Wat je hier invult blijft staan.</p>
        {ownField}
        {!s.bitcoinFallbackEnabled &&
          (confirmPublic ? (
            publicWarning
          ) : (
            <button type="button" className="text-xs text-muted underline hover:text-text" onClick={() => setConfirmPublic(true)}>
              Geen eigen node? Publieke node gebruiken…
            </button>
          ))}
        {error && <p className="text-xs text-down">{error}</p>}
      </div>
    );
  }

  return (
    <>
      <SettingRows>
        <SettingRow label="Eigen node" description="De mempool-app op je Umbrel (Esplora-API); vereist de Electrs-app.">
          {ownField}
        </SettingRow>
        <SettingRow
          label="Publieke terugval"
          badge={s.bitcoinFallbackEnabled ? <StatusBadge tone="warn">Aan · {hostOf(s.bitcoinFallbackUrl)}</StatusBadge> : <StatusBadge tone="neutral">Uit</StatusBadge>}
          description="Alleen als je eigen node onbereikbaar is. De publieke node ziet dan je wallet-adressen."
        >
          {s.bitcoinFallbackEnabled ? (
            <>
              <CommitInput label="URL van de publieke node" type="url" placeholder="https://mempool.space" value={s.bitcoinFallbackUrl} validate={httpUrl} onCommit={(v) => save({ bitcoinFallbackUrl: v }, "bitcoinFallbackUrl")} after={<TestButton busy={pub.busy} onClick={() => void pub.run(s.bitcoinFallbackUrl, "Publieke node")} />} />
              <InlineResult result={pub.result} />
              <button type="button" className="btn btn-ghost w-fit !py-1.5 text-xs" onClick={() => void enableFallback(false)}>
                Terugval uitschakelen
              </button>
            </>
          ) : (
            <Disclosure summary="Terugval instellen">
              <CommitInput label="URL van de publieke node" type="url" placeholder="https://mempool.space" value={s.bitcoinFallbackUrl} validate={httpUrl} onCommit={(v) => save({ bitcoinFallbackUrl: v }, "bitcoinFallbackUrl")} after={<TestButton busy={pub.busy} onClick={() => void pub.run(s.bitcoinFallbackUrl, "Publieke node")} />} />
              <InlineResult result={pub.result} />
              {confirmPublic ? (
                publicWarning
              ) : (
                <button type="button" className="btn btn-ghost !py-1.5 text-xs" onClick={() => setConfirmPublic(true)}>
                  Terugval inschakelen…
                </button>
              )}
            </Disclosure>
          )}
        </SettingRow>
      </SettingRows>
      {error && <p className="text-xs text-down">{error}</p>}
      <Disclosure summary="Hoe werkt de nodekeuze?">
        <p>
          <b>Eigen node eerst.</b> De mempool-app op je Umbrel: binnen Umbrel <code>http://10.21.21.26:3006</code>, vanaf een Mac in je netwerk <code>http://umbrel.local:3006</code>. Die app heeft de Electrs-app nodig voor adreslookups. Je wallet-adressen verlaten je netwerk niet.
        </p>
        <p>
          <b>Terugval alleen als je dat aanzet.</b> Is de eigen node onbereikbaar (of niet ingesteld) en staat de terugval aan, dan gebruikt de app de publieke node. Elke sync die de terugval gebruikt meldt dat in het syncrapport, en Instellingen toont het als aandachtspunt.
        </p>
        <p>
          <b>Terugval uit</b> (standaard): bij een onbereikbare eigen node mislukt de sync met een duidelijke melding en blijft het laatst bekende saldo staan. Elke Esplora-compatibele node werkt als terugval (ook blockstream.info of mempool.emzy.de).
        </p>
      </Disclosure>
    </>
  );
}

function TestButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-ghost shrink-0 !py-2 text-xs" disabled={busy} onClick={onClick}>
      Testen
    </button>
  );
}
