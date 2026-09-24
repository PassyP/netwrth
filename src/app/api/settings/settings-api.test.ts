import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-settings-api-"));

import { GET, PATCH } from "./route";
import { GET as OVERVIEW } from "./overview/route";
import { POST as DISMISS, DELETE as UNDISMISS } from "./attention/route";
import { PATCH as PATCH_CONN } from "../connections/[id]/route";
import { POST as PREVIEW } from "../connections/preview/route";
import { createConnection, hasOwnKeys } from "@/lib/connections/sync";
import { setSecret } from "@/lib/secrets";
import { getDb, schema } from "@/lib/db";

const req = (url: string, method = "GET", body?: unknown) => new Request(`http://test${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

describe("PATCH /api/settings", () => {
  it("weigert een onbekende tijdzone en een ongeldige tijd, accepteert geldige waarden", async () => {
    expect((await PATCH(req("/api/settings", "PATCH", { timezone: "Mars/Olympus" }), undefined)).status).toBe(400);
    expect((await PATCH(req("/api/settings", "PATCH", { refreshTime: "25:00" }), undefined)).status).toBe(400);
    expect((await PATCH(req("/api/settings", "PATCH", { ntfyTopicUrl: "ntfy.sh/x" }), undefined)).status).toBe(400);
    const ok = await PATCH(req("/api/settings", "PATCH", { timezone: "UTC", refreshTime: "08:30", priceRefreshMinutes: 120 }), undefined);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ timezone: "UTC", refreshTime: "08:30", priceRefreshMinutes: 120 });
  });

  it("GET geeft de installatie-informatie mee", async () => {
    const body = await (await GET(req("/api/settings"), undefined)).json();
    expect(body.install).toMatchObject({ secretSource: "file", lastBackupAt: null, bitcoinApiUrlSource: "none" });
    expect(body.install.dataDir).toBe(process.env.DATA_DIR);
    expect(body).not.toHaveProperty("jobs");
  });
});

describe("statusoverzicht", () => {
  it("geeft aandachtspunten en samenvattingen; negeren werkt niet voor kritieke punten", async () => {
    const o = await (await OVERVIEW(req("/api/settings/overview"), undefined)).json();
    expect(o.attention.items[0].key).toBe("security:password");
    expect(Object.keys(o.summaries)).toEqual(["weergave", "portfolios", "platforms", "koersen", "meldingen", "beveiliging"]);
    const backup = o.attention.items.find((i: { key: string }) => i.key === "backup:none");
    await DISMISS(req("/api/settings/attention", "POST", { key: backup.key, fingerprint: backup.fingerprint }), undefined);
    await DISMISS(req("/api/settings/attention", "POST", { key: "security:password", fingerprint: "no-password" }), undefined);
    const after = await (await OVERVIEW(req("/api/settings/overview"), undefined)).json();
    expect(after.attention.items.map((i: { key: string }) => i.key)).toEqual(["security:password"]);
    expect(after.attention.dismissed).toBe(1);
    await UNDISMISS(req("/api/settings/attention", "DELETE"), undefined);
    expect((await (await OVERVIEW(req("/api/settings/overview"), undefined)).json()).attention.dismissed).toBe(0);
    expect(await (await OVERVIEW(req("/api/settings/overview?only=critical"), undefined)).json()).toEqual({ critical: 1 });
  });
});

describe("koppelingen", () => {
  it("eToro van gedeelde naar eigen keys vereist beide keys; gedeelde keys alleen voor eToro", async () => {
    const portfolio = getDb().select().from(schema.portfolios).get()!;
    const etoro = createConnection({ provider: "etoro", label: "eToro", portfolioId: portfolio.id, mode: "alongside" });
    expect((await PATCH_CONN(req(`/api/connections/${etoro.id}`, "PATCH", { apiKey: "ONLYONEKEY" }), ctx(etoro.id))).status).toBe(400);
    expect((await PATCH_CONN(req(`/api/connections/${etoro.id}`, "PATCH", { apiKey: "OWNKEY01", apiSecret: "OWNUSER1" }), ctx(etoro.id))).status).toBe(200);
    expect((await PATCH_CONN(req(`/api/connections/${etoro.id}`, "PATCH", { apiKey: "NEWKEY02" }), ctx(etoro.id))).status).toBe(200); // al eigen keys: één vervangen mag
    // zonder gedeelde keys zou de koppeling na het wissen van de eigen keys niets meer hebben
    expect((await PATCH_CONN(req(`/api/connections/${etoro.id}`, "PATCH", { useSharedKeys: true }), ctx(etoro.id))).status).toBe(400);
    expect(hasOwnKeys(etoro.id)).toBe(true);
    setSecret("etoroApiKey", "SHAREDK1");
    setSecret("etoroUserKey", "SHAREDU1");
    expect((await PATCH_CONN(req(`/api/connections/${etoro.id}`, "PATCH", { useSharedKeys: true }), ctx(etoro.id))).status).toBe(200);
    expect(hasOwnKeys(etoro.id)).toBe(false);
    const kraken = createConnection({ provider: "kraken", label: "Kraken", portfolioId: portfolio.id, mode: "alongside", apiKey: "KEY00001", apiSecret: "SECRET01" });
    expect((await PATCH_CONN(req(`/api/connections/${kraken.id}`, "PATCH", { useSharedKeys: true }), ctx(kraken.id))).status).toBe(400);
  });

  it("preview: platform en aantal te vervangen transacties", async () => {
    const portfolio = getDb().select().from(schema.portfolios).get()!;
    const r = await (await PREVIEW(req("/api/connections/preview", "POST", { provider: "bitcoin", label: "Nieuwe wallet", portfolioId: portfolio.id }), undefined)).json();
    expect(r).toEqual({ platformId: null, name: "Nieuwe wallet", type: "wallet", exists: false, replaceable: 0 });
    const k = await (await PREVIEW(req("/api/connections/preview", "POST", { provider: "kraken", label: "", portfolioId: portfolio.id }), undefined)).json();
    expect(k).toMatchObject({ name: "Kraken", exists: true, replaceable: 0 });
  });
});
