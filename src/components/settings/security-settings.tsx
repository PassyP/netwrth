"use client";

/**
 * Beveiliging en back-up: wie de app kan openen (wachtwoord, herstelcode, uitloggen) en hoe je je gegevens terugkrijgt
 * na verlies (back-up plus de sleutel die keys en xpubs ontsleutelt). Zonder wachtwoord staat het formulier direct open:
 * op Umbrel is dit de enige toegangsbeveiliging. Fouten staan bij het veld, niet in een toast.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Download } from "lucide-react";
import { api, useApp } from "../app-state";
import { Card, Skeleton } from "../ui";
import { RecoveryCodeBox } from "../recovery-code";
import { SettingsPageHeader, SettingsStack, useScrollToHash, useSettings } from "./context";
import { Callout, ConfirmDialog, DangerZone, Disclosure, SettingRow, SettingRows, StatusBadge } from "./ui";
import { formatDate } from "@/lib/format";

// gelijk aan MIN_PASSWORD_LENGTH in lib/auth (die module is serverzijde en hoort niet in de clientbundel)
const MIN = 6;

type Errors = Partial<Record<"current" | "next" | "repeat" | "form", string>>;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** "Huidig wachtwoord is onjuist" hoort bij het veld Huidig wachtwoord; de rest onder het formulier. */
const toErrors = (e: unknown): Errors => {
  const message = errorText(e);
  return /huidig wachtwoord/i.test(message) ? { current: message } : { form: message };
};

function PasswordInput({
  label,
  value,
  onChange,
  error,
  autoComplete,
  autoFocus,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  autoComplete: "new-password" | "current-password";
  autoFocus?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const id = useId();
  return (
    <label className="block min-w-0">
      <span className="label">{label}</span>
      <input
        ref={inputRef}
        className={`input ${error ? "!border-down" : ""}`}
        type="password"
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        value={value}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && (
        <span id={`${id}-error`} className="mt-1 block text-xs text-down">
          {error}
        </span>
      )}
    </label>
  );
}

/**
 * Wachtwoord instellen (zonder `withCurrent`) of wijzigen. De knop is altijd klikbaar; wat ontbreekt staat na indienen
 * onder het veld. Geeft de nieuwe herstelcode door via `onCode`.
 */
function PasswordForm({ withCurrent = false, wide = false, submitLabel, note, focusOnHash, onCode, onCancel }: { withCurrent?: boolean; wide?: boolean; submitLabel: string; note: string; focusOnHash?: string; onCode: (code: string) => void; onCancel?: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // deeplink vanaf het statusoverzicht (#toegang): meteen kunnen typen; het scrollen doet useScrollToHash
    if (focusOnHash && window.location.hash === `#${focusOnHash}`) first.current?.focus({ preventScroll: true });
  }, [focusOnHash]);

  const edit = (field: keyof Errors, set: (v: string) => void) => (v: string) => {
    set(v);
    setErrors((x) => ({ ...x, [field]: undefined, form: undefined }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const errs: Errors = {};
    if (withCurrent && !current) errs.current = "Vul je huidige wachtwoord in";
    if (next.length < MIN) errs.next = `Minimaal ${MIN} tekens`;
    if (next !== repeat) errs.repeat = "De wachtwoorden zijn niet gelijk";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const r = await api<{ recoveryCode: string }>("/api/auth/password", { method: "POST", json: { current: withCurrent ? current : undefined, next } });
      onCode(r.recoveryCode);
    } catch (err) {
      setErrors(toErrors(err));
      setBusy(false);
    }
  };

  const small = wide ? "" : "!py-1.5 text-xs";
  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-3">
      <div className={`grid gap-2 ${wide ? "sm:grid-cols-2" : ""}`}>
        {withCurrent && <PasswordInput label="Huidig wachtwoord" autoComplete="current-password" autoFocus value={current} onChange={edit("current", setCurrent)} error={errors.current} />}
        <PasswordInput label="Nieuw wachtwoord" autoComplete="new-password" inputRef={withCurrent ? undefined : first} value={next} onChange={edit("next", setNext)} error={errors.next} />
        <PasswordInput label="Herhaal wachtwoord" autoComplete="new-password" value={repeat} onChange={edit("repeat", setRepeat)} error={errors.repeat} />
      </div>
      <p className="text-xs text-muted">{note}</p>
      {errors.form && (
        <p className="text-xs text-down" role="alert">
          {errors.form}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={`btn ${small}`} aria-busy={busy}>
          {busy ? "Bezig…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className={`btn btn-ghost ${small}`} onClick={onCancel} disabled={busy}>
            Annuleren
          </button>
        )}
      </div>
    </form>
  );
}

/** Nieuwe herstelcode met het huidige wachtwoord; de oude vervalt. */
function RecoveryForm({ hasCode, onCode, onCancel }: { hasCode: boolean; onCode: (code: string) => void; onCancel: () => void }) {
  const [current, setCurrent] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!current) return setError("Vul je huidige wachtwoord in");
    setBusy(true);
    try {
      const r = await api<{ recoveryCode: string }>("/api/auth/recovery-code", { method: "POST", json: { current } });
      onCode(r.recoveryCode);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="space-y-3">
      <PasswordInput
        label="Huidig wachtwoord"
        autoComplete="current-password"
        autoFocus
        value={current}
        onChange={(v) => {
          setCurrent(v);
          setError(undefined);
        }}
        error={error}
      />
      {hasCode && <p className="text-xs text-muted">De oude code werkt daarna niet meer.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn !py-1.5 text-xs" aria-busy={busy}>
          {busy ? "Bezig…" : hasCode ? "Nieuwe herstelcode maken" : "Herstelcode maken"}
        </button>
        <button type="button" className="btn btn-ghost !py-1.5 text-xs" onClick={onCancel} disabled={busy}>
          Annuleren
        </button>
      </div>
    </form>
  );
}

export function SecuritySettings() {
  const { data, reload, reloadOverview } = useSettings();
  const { toast, bump } = useApp();
  // de herstelcode staat eenmalig in beeld; daarna de hele pagina herladen (nieuwe sessie) of alleen de gegevens
  const [code, setCode] = useState<{ value: string; then: "reload" | "refresh" } | null>(null);
  const [mode, setMode] = useState<"change" | "recovery" | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [removeCurrent, setRemoveCurrent] = useState("");
  const [removeError, setRemoveError] = useState<string | undefined>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const backupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useScrollToHash(!!data);
  useEffect(
    () => () => {
      if (backupTimer.current) clearTimeout(backupTimer.current);
    },
    []
  );

  if (!data) {
    return (
      <SettingsStack>
        <SettingsPageHeader category="beveiliging" />
        <Skeleton className="h-72" />
        <Skeleton className="h-48" />
      </SettingsStack>
    );
  }

  const { passwordSet, recoveryCodeSet, install } = data;

  const codeDone = () => {
    if (code?.then === "reload") return window.location.reload();
    setCode(null);
    setMode(null);
    bump(); // laadt ook de rode stip op Instellingen in de navigatie opnieuw (geen herstelcode was kritiek)
  };

  const logout = async () => {
    setLogoutError(null);
    try {
      await api("/api/auth/logout", { method: "POST" });
      window.location.reload();
    } catch (e) {
      setLogoutError(errorText(e));
    }
  };

  const onBackupClick = () => {
    // de download zet lastBackupAt op de server; daarna "Laatste back-up" en het statusoverzicht bijwerken
    if (backupTimer.current) clearTimeout(backupTimer.current);
    backupTimer.current = setTimeout(() => {
      reload();
      reloadOverview();
    }, 2000);
  };

  const removePassword = async () => {
    try {
      await api("/api/auth/password", { method: "DELETE", json: { current: removeCurrent } });
      setConfirmRemove(false);
      toast("Wachtwoord verwijderd");
      // even wachten zodat de melding te zien is; herladen werkt ook de zijbalk bij (geen uitlogknop meer)
      setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      setConfirmRemove(false);
      setRemoveError(errorText(e));
    }
  };

  const badge = !passwordSet ? (
    <StatusBadge tone="down" dot>
      Niet beveiligd
    </StatusBadge>
  ) : !recoveryCodeSet ? (
    <StatusBadge tone="warn">Geen herstelcode</StatusBadge>
  ) : (
    <StatusBadge tone="ok">Beveiligd</StatusBadge>
  );

  return (
    <SettingsStack>
      <SettingsPageHeader category="beveiliging" />

      <Card
        title="Toegang"
        id="toegang"
        titleExtra={badge}
        description={passwordSet ? "De app vraagt om in te loggen. Op Umbrel is dit de enige toegangsbeveiliging." : "Zonder wachtwoord kan iedereen op je netwerk de app openen en je saldi en wallets zien. Op Umbrel is dit de enige toegangsbeveiliging."}
      >
        {code ? (
          <RecoveryCodeBox code={code.value} onDone={codeDone} />
        ) : !passwordSet ? (
          <PasswordForm wide focusOnHash="toegang" submitLabel="Wachtwoord instellen" note="Daarna zie je eenmalig een herstelcode. Zonder wachtwoord én herstelcode kom je niet meer in de app." onCode={(c) => setCode({ value: c, then: "reload" })} />
        ) : (
          <SettingRows>
            <SettingRow label="Wachtwoord" badge={<StatusBadge tone="ok">Actief</StatusBadge>}>
              {mode === "change" ? (
                <PasswordForm withCurrent submitLabel="Wachtwoord wijzigen" note="Andere apparaten moeten daarna opnieuw inloggen; deze browser blijft ingelogd." onCode={(c) => setCode({ value: c, then: "reload" })} onCancel={() => setMode(null)} />
              ) : (
                <button type="button" className="btn btn-ghost self-start !py-1.5 text-xs" onClick={() => setMode("change")}>
                  Wijzigen
                </button>
              )}
            </SettingRow>
            <SettingRow label="Herstelcode" description="Hiermee stel je een nieuw wachtwoord in als je het vergeet." badge={recoveryCodeSet ? <StatusBadge tone="ok">Aanwezig</StatusBadge> : <StatusBadge tone="warn">Ontbreekt</StatusBadge>}>
              {mode === "recovery" ? (
                <RecoveryForm hasCode={recoveryCodeSet} onCode={(c) => setCode({ value: c, then: "refresh" })} onCancel={() => setMode(null)} />
              ) : (
                <button type="button" className="btn btn-ghost self-start !py-1.5 text-xs" onClick={() => setMode("recovery")}>
                  {recoveryCodeSet ? "Nieuwe herstelcode" : "Herstelcode maken"}
                </button>
              )}
            </SettingRow>
            <SettingRow label="Dit apparaat" description="Log deze browser uit; andere apparaten blijven ingelogd.">
              <button type="button" className="btn btn-ghost self-start !py-1.5 text-xs" onClick={() => void logout()}>
                Uitloggen
              </button>
              {logoutError && <p className="text-xs text-down">{logoutError}</p>}
            </SettingRow>
          </SettingRows>
        )}
        {!code && (
          <Disclosure summary="Hoe werken inloggen en herstel?" className="mt-3">
            <p>
              Met <b>Ingelogd blijven</b> onthoudt een browser de login 90 dagen; zonder vinkje tot je de browser sluit.
            </p>
            <p>
              Wachtwoord vergeten? Kies op het inlogscherm <b>Wachtwoord vergeten?</b> en stel met je herstelcode een nieuw wachtwoord in.
            </p>
            <p>Ben je allebei kwijt, dan kom je niet meer in de app. Bewaar de herstelcode dus op een veilige plek, bijvoorbeeld in je wachtwoordmanager.</p>
          </Disclosure>
        )}
      </Card>

      <Card title="Back-up en export" id="backup">
        <SettingRows>
          <div className="pb-3">
            <SettingRow label="Volledige back-up" description="Alle transacties, instellingen en versleutelde keys.">
              <a href="/api/backup" download className="btn inline-flex items-center gap-1.5 self-start !py-1.5 text-xs" onClick={onBackupClick}>
                <Download size={14} /> Back-up downloaden (.db)
              </a>
              <span className="text-xs text-muted">{install.lastBackupAt ? `Laatste back-up: ${formatDate(install.lastBackupAt, true)}` : "Nog geen back-up gedownload"}</span>
            </SettingRow>
            <div className="space-y-2">
              <Callout tone="key">
                {install.secretSource === "env" ? (
                  <p>Je gebruikt APP_SECRET: bewaar die waarde samen met je back-up. Zonder die sleutel zijn je API-keys en xpubs na herstel onleesbaar.</p>
                ) : (
                  <p>
                    Bewaar ook secret.key uit <span className="break-all font-mono">{install.dataDir}</span> (de datamap). Zonder die sleutel zijn je API-keys en xpubs na herstel onleesbaar.
                  </p>
                )}
              </Callout>
              <Disclosure summary="Zo herstel je een back-up">
                <ol className="list-decimal space-y-1 pl-4">
                  <li>Stop de app.</li>
                  <li>
                    Zet het .db-bestand terug als <b>portfolio.db</b> in de datamap (<span className="break-all font-mono">{install.dataDir}</span>).
                  </li>
                  <li>
                    Zet <b>secret.key</b> ernaast (of gebruik dezelfde APP_SECRET).
                  </li>
                  <li>Start de app.</li>
                </ol>
              </Disclosure>
            </div>
          </div>
          <SettingRow label="Transacties exporteren" description="CSV van alle portfolios; kan ook op de pagina Transacties.">
            <a href="/api/export/transactions" download className="btn btn-ghost inline-flex items-center gap-1.5 self-start !py-1.5 text-xs">
              <Download size={14} /> CSV downloaden
            </a>
          </SettingRow>
        </SettingRows>
      </Card>

      {passwordSet && (
        <DangerZone>
          <SettingRow label="Wachtwoord verwijderen" description="Daarna kan iedereen op je netwerk de app openen en je saldi zien.">
            <form
              noValidate
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (removeCurrent) setConfirmRemove(true);
              }}
            >
              <PasswordInput
                label="Huidig wachtwoord"
                autoComplete="current-password"
                value={removeCurrent}
                onChange={(v) => {
                  setRemoveCurrent(v);
                  setRemoveError(undefined);
                }}
                error={removeError}
              />
              <button type="submit" className="btn btn-danger self-start !py-1.5 text-xs" disabled={!removeCurrent}>
                Wachtwoord verwijderen…
              </button>
            </form>
          </SettingRow>
        </DangerZone>
      )}

      <ConfirmDialog open={confirmRemove} title="Wachtwoord verwijderen?" tone="danger" confirmLabel="Wachtwoord verwijderen" onClose={() => setConfirmRemove(false)} onConfirm={removePassword}>
        <p>Daarna kan iedereen op je netwerk de app openen en je saldi en wallets zien.</p>
      </ConfirmDialog>
    </SettingsStack>
  );
}
