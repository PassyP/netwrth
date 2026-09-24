import webpush from "web-push";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { getSecret, setSecret } from "./secrets";
import { getSettings } from "./settings";

export function vapidKeys(): { publicKey: string; privateKey: string } {
  let publicKey = getSecret("vapidPublicKey");
  let privateKey = getSecret("vapidPrivateKey");
  if (!publicKey || !privateKey) {
    const k = webpush.generateVAPIDKeys();
    publicKey = k.publicKey;
    privateKey = k.privateKey;
    setSecret("vapidPublicKey", publicKey);
    setSecret("vapidPrivateKey", privateKey);
  }
  return { publicKey, privateKey };
}

export function savePushSubscription(sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  const db = getDb();
  const existing = db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, sub.endpoint)).get();
  if (!existing) {
    db.insert(schema.pushSubscriptions).values({ endpoint: sub.endpoint, subscription: JSON.stringify(sub), createdAt: new Date().toISOString() }).run();
  }
}

export function removePushSubscription(endpoint: string) {
  getDb().delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, endpoint)).run();
}

/** Push naar alle aangemelde apparaten; verlopen abonnementen (404/410) worden opgeruimd. */
async function sendPush(title: string, body: string): Promise<{ devices: number; sent: number; expired: number }> {
  const db = getDb();
  const subs = db.select().from(schema.pushSubscriptions).all();
  if (subs.length === 0) return { devices: 0, sent: 0, expired: 0 };
  const { publicKey, privateKey } = vapidKeys();
  webpush.setVapidDetails("mailto:netwrth@localhost", publicKey, privateKey);
  const payload = JSON.stringify({ title, body, url: "/alerts" });
  let sent = 0;
  let expired = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(JSON.parse(s.subscription), payload);
        sent++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          removePushSubscription(s.endpoint);
          expired++;
        }
      }
    })
  );
  return { devices: subs.length, sent, expired };
}

async function sendNtfy(title: string, body: string): Promise<{ status: number } | null> {
  const { ntfyTopicUrl } = getSettings();
  if (!ntfyTopicUrl) return null;
  const res = await fetch(ntfyTopicUrl, { method: "POST", headers: { Title: title, Tags: "chart_with_upwards_trend" }, body, signal: AbortSignal.timeout(15000) });
  return { status: res.status };
}

/** Melding in de app + het gekozen kanaal. */
export async function notify(title: string, body: string): Promise<void> {
  const db = getDb();
  db.insert(schema.notifications).values({ title, body, createdAt: new Date().toISOString() }).run();
  const { notifyChannel } = getSettings();
  try {
    if (notifyChannel === "push") await sendPush(title, body);
    else if (notifyChannel === "ntfy") await sendNtfy(title, body);
  } catch (e) {
    console.warn("Melding versturen mislukt:", e instanceof Error ? e.message : e);
  }
}

/**
 * Testmelding via het ingestelde kanaal (Instellingen → Meldingen → Testmelding sturen). Komt ook in Ontvangen
 * meldingen; het resultaat zegt of het kanaal zelf werkte.
 */
export async function sendTestNotification(): Promise<{ ok: boolean; message: string }> {
  const title = "Testmelding";
  const body = "Als je dit ziet, komen meldingen van Netwrth aan.";
  getDb().insert(schema.notifications).values({ title, body, createdAt: new Date().toISOString() }).run();
  const { notifyChannel } = getSettings();
  try {
    if (notifyChannel === "push") {
      const r = await sendPush(title, body);
      if (r.devices === 0) return { ok: false, message: "Geen apparaat aangemeld voor push; meld dit apparaat aan of kies een ander kanaal." };
      if (r.sent === 0) return { ok: false, message: `Push naar ${r.devices} apparaat${r.devices === 1 ? "" : "en"} mislukt${r.expired ? ` (${r.expired} verlopen aanmelding${r.expired === 1 ? "" : "en"} opgeruimd)` : ""}.` };
      return { ok: true, message: `Verstuurd naar ${r.sent} van ${r.devices} apparaat${r.devices === 1 ? "" : "en"}.` };
    }
    if (notifyChannel === "ntfy") {
      const r = await sendNtfy(title, body);
      if (!r) return { ok: false, message: "Geen ntfy topic-URL ingesteld." };
      return r.status < 300 ? { ok: true, message: "Verstuurd via ntfy." } : { ok: false, message: `ntfy antwoordde met HTTP ${r.status}.` };
    }
    return { ok: true, message: "Staat in Ontvangen meldingen (kanaal: alleen in de app)." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
