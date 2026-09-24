"use client";

/**
 * Meldingen: het kanaal (alleen in de app, push of ntfy), de aangemelde apparaten en een testmelding. Push kiezen meldt
 * dit apparaat eerst aan als dat kan en slaat pas daarna op; een apparaat aan- of afmelden verandert het kanaal nooit.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, useApp } from "../app-state";
import { Card, Skeleton } from "../ui";
import { SettingsPageHeader, SettingsStack, useScrollToHash, useSettings } from "./context";
import { Callout, CommitInput, ConfirmDialog, InlineResult, SaveState, Segmented, SettingRow, SettingRows, StatusBadge, type TestResult } from "./ui";

type Channel = "app" | "push" | "ntfy";
/** Waar een push-actie begon: bij de kanaalkeuze of bij een apparaat. Daar staat ook de voortgang en de fout. */
type Where = "channel" | "device";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const httpUrl = (v: string) => (v === "" || /^https?:\/\/\S+$/i.test(v) ? null : "De topic-URL moet met http:// of https:// beginnen");

/** Hosts op je eigen netwerk: daarheen is http geen probleem, over internet wel. */
function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "::1") return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function insecureOverInternet(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && !isLocalHost(u.hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Push op dit apparaat

/** Push werkt alleen in een beveiligde context (HTTPS) en op iOS alleen in de geïnstalleerde app. */
const deviceSupportsPush = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** De shell registreert de service worker; zonder werkende worker komt `ready` nooit, dus niet eindeloos wachten. */
function serviceWorkerReady(): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("De service worker start niet; herlaad de pagina en probeer het opnieuw.")), 10_000)),
  ]);
}

async function subscribeThisDevice(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission === "denied") throw new Error("Meldingen zijn voor deze site geblokkeerd; sta ze toe in de instellingen van je browser.");
  if (permission !== "granted") throw new Error("Geen toestemming voor meldingen gegeven.");
  const reg = await serviceWorkerReady();
  const { publicKey } = await api<{ publicKey: string }>("/api/push/vapid");
  const options = { userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) };
  let sub: PushSubscription;
  try {
    sub = await reg.pushManager.subscribe(options);
  } catch (e) {
    // een bestaande aanmelding met een andere sleutel (bijv. na een herstelde back-up) blokkeert een nieuwe
    const old = await reg.pushManager.getSubscription();
    if (!old) throw e;
    await old.unsubscribe();
    sub = await reg.pushManager.subscribe(options);
  }
  await api("/api/push/subscribe", { method: "POST", json: sub.toJSON() });
}

async function unsubscribeThisDevice(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api("/api/push/subscribe", { method: "DELETE", json: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------

export function NotificationSettings() {
  const { data, save, status, reload, reloadOverview } = useSettings();
  const { bump } = useApp();
  const [support, setSupport] = useState<boolean | null>(null); // null = nog aan het controleren
  const [subscribed, setSubscribed] = useState(false);
  const [pending, setPending] = useState<{ where: Where; message: string } | null>(null);
  const [pushError, setPushError] = useState<{ where: Where; message: string } | null>(null);
  const [confirmLast, setConfirmLast] = useState(false);
  const [test, setTest] = useState<TestResult>(null);
  useScrollToHash(!!data);

  useEffect(() => {
    if (!deviceSupportsPush()) {
      setSupport(false);
      return;
    }
    setSupport(true);
    let cancelled = false;
    currentSubscription()
      .then((sub) => !cancelled && setSubscribed(!!sub))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) {
    return (
      <SettingsStack>
        <SettingsPageHeader category="meldingen" />
        <Skeleton className="h-72" />
      </SettingsStack>
    );
  }

  const s = data.settings;
  const devices = data.pushSubs;
  // lokaal aangemeld maar de server kent geen enkel apparaat (bijv. na een herstelde back-up): opnieuw aanmelden
  const deviceOn = subscribed && devices > 0;
  // fouten en voortgang van een apparaat staan bij de apparaten als die zichtbaar zijn (kanaal push), anders bij het kanaal
  const inChannelRow = (w: Where) => w === "channel" || s.notifyChannel !== "push";

  const runPush = async (where: Where, message: string, fn: () => Promise<void>): Promise<boolean> => {
    setPushError(null);
    setPending({ where, message });
    try {
      await fn();
      return true;
    } catch (e) {
      setPushError({ where, message: errorText(e) });
      return false;
    } finally {
      setPending(null);
    }
  };

  const chooseChannel = async (c: Channel) => {
    setPushError(null);
    setTest(null);
    if (c === "push" && support && !deviceOn) {
      const ok = await runPush("channel", "Dit apparaat aanmelden voor push…", async () => {
        await subscribeThisDevice();
        setSubscribed(true);
      });
      if (!ok) return;
    }
    const err = await save({ notifyChannel: c });
    // pas na het opslaan verversen: een eerdere GET kan de oude keuze terugzetten
    if (!err && c === "push") reload();
  };

  const subscribe = async () => {
    await runPush("device", "Dit apparaat aanmelden…", async () => {
      await subscribeThisDevice();
      setSubscribed(true);
    });
    reload();
    reloadOverview();
  };

  const unsubscribe = async () => {
    await runPush("device", "Afmelden…", async () => {
      await unsubscribeThisDevice();
      setSubscribed(false);
    });
    reload();
    reloadOverview();
  };

  const askUnsubscribe = () => {
    if (s.notifyChannel === "push" && devices <= 1) setConfirmLast(true);
    else void unsubscribe();
  };

  const sendTest = async () => {
    setTest({ busy: true, message: "Testmelding sturen…" });
    try {
      const r = await api<{ ok: boolean; message: string }>("/api/notifications/test", { method: "POST" });
      setTest({ ok: r.ok, message: r.message });
    } catch (e) {
      setTest({ ok: false, message: errorText(e) });
    }
    bump(); // de testmelding staat ook onder Alerts (teller in de navigatie); een push-test ruimt verlopen apparaten op
  };

  const feedback = (here: (w: Where) => boolean) => (
    <>
      {pending && here(pending.where) && <InlineResult result={{ busy: true, message: pending.message }} />}
      {pushError && here(pushError.where) && <InlineResult result={{ ok: false, message: pushError.message }} />}
    </>
  );

  const unsubscribeButton = (
    <button type="button" className="text-xs font-semibold text-accent hover:underline disabled:opacity-50" disabled={!!pending} onClick={askUnsubscribe}>
      Afmelden
    </button>
  );

  const pushUnavailable = support === false && devices === 0;

  return (
    <SettingsStack>
      <SettingsPageHeader category="meldingen" />
      <p className="text-xs text-muted">
        Het verversschema staat onder{" "}
        <Link href="/settings/koersen#planning" className="text-accent hover:underline">
          Koersen en planning
        </Link>
        .
      </p>

      <Card title="Kanaal" id="kanaal" description="In de app komt elke melding altijd; het kanaal hier komt erbij.">
        <SettingRows>
          <SettingRow label="Kanaal">
            {/* natuurlijke breedte: in drie gelijke delen past "Alleen in de app" niet in de kolom */}
            <Segmented<Channel>
              label="Kanaal"
              full={false}
              value={s.notifyChannel}
              onChange={(c) => void chooseChannel(c)}
              options={[
                { value: "app", label: "Alleen in de app", disabled: !!pending },
                { value: "push", label: "Push", disabled: !!pending || pushUnavailable, title: pushUnavailable ? "Push vereist HTTPS en de app geïnstalleerd op je telefoon" : undefined },
                { value: "ntfy", label: "ntfy", disabled: !!pending },
              ]}
            />
            <SaveState status={status.notifyChannel ?? null} />
            {feedback(inChannelRow)}
            {s.notifyChannel !== "push" && deviceOn && (
              <p className="text-xs text-muted">
                Dit apparaat is nog aangemeld voor push · {unsubscribeButton}
              </p>
            )}
          </SettingRow>

          {s.notifyChannel === "push" && (
            <SettingRow label="Apparaten" description={`${devices} ${devices === 1 ? "apparaat" : "apparaten"} aangemeld`}>
              <div className="text-sm">
                {deviceOn ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone="ok">Dit apparaat: aangemeld</StatusBadge>
                    {unsubscribeButton}
                  </span>
                ) : support === false ? (
                  <span className="text-muted">Push werkt niet in deze browser (HTTPS en installatie als app nodig).</span>
                ) : (
                  <button type="button" className="btn btn-ghost !py-1.5 text-xs" disabled={!!pending || support === null} onClick={() => void subscribe()}>
                    Dit apparaat aanmelden
                  </button>
                )}
              </div>
              {feedback((w) => !inChannelRow(w))}
              {devices === 0 && (
                <Callout tone="warn">
                  <p>Geen enkel apparaat ontvangt push.</p>
                  <button type="button" className="mt-1 font-semibold text-accent hover:underline disabled:opacity-50" disabled={!!pending} onClick={() => void chooseChannel("app")}>
                    Kanaal op Alleen in de app zetten
                  </button>
                </Callout>
              )}
            </SettingRow>
          )}

          {s.notifyChannel === "ntfy" && (
            <SettingRow label="Topic-URL" description="Iedereen die het topic kent kan meelezen; kies een lang, willekeurig topic.">
              <CommitInput
                label="ntfy topic-URL"
                type="url"
                inputMode="url"
                placeholder="https://ntfy.sh/<eigen-lang-willekeurig-topic>"
                value={s.ntfyTopicUrl}
                validate={httpUrl}
                onCommit={(v) => save({ ntfyTopicUrl: v })}
              />
              {insecureOverInternet(s.ntfyTopicUrl) && <p className="text-xs text-warn">Via http gaat de melding onversleuteld over internet.</p>}
            </SettingRow>
          )}

          <SettingRow label="Controleren" description="Stuurt een testmelding via het gekozen kanaal.">
            <button type="button" className="btn btn-ghost self-start !py-1.5 text-xs" disabled={!!test && "busy" in test} onClick={() => void sendTest()}>
              Testmelding sturen
            </button>
            <InlineResult result={test} />
          </SettingRow>
        </SettingRows>
      </Card>

      <p className="text-xs text-muted">
        Je krijgt een melding bij een koersalert (instellen onder{" "}
        <Link href="/alerts" className="text-accent hover:underline">
          Alerts
        </Link>
        ), een afstemmingsverschil bij een koppeling en een mislukte sync. Ontvangen meldingen lees je onder Alerts.
      </p>

      <ConfirmDialog
        open={confirmLast}
        title="Laatste apparaat afmelden?"
        confirmLabel="Afmelden"
        onClose={() => setConfirmLast(false)}
        onConfirm={async () => {
          await unsubscribe();
          setConfirmLast(false);
        }}
      >
        <p>Daarna ontvangt geen enkel apparaat push; meldingen komen alleen nog in de app.</p>
      </ConfirmDialog>
    </SettingsStack>
  );
}
