import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-settings-overview-"));
delete process.env.BITCOIN_API_URL;

import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { setPassword, clearPassword } from "./auth";
import { setSetting, setMeta } from "./settings";
import { createConnection } from "./connections/sync";
import { ZPUB } from "./bitcoin/test-vectors";
import { computeAttention, criticalCount, dismissAttention, recentActivity, settingsSummaries, warningCount } from "./settings-overview";

const NOW = new Date("2026-03-10T12:00:00.000Z");
const keys = () => computeAttention(NOW).items.map((i) => i.key);

describe("aandachtspunten", () => {
  it("zonder wachtwoord: kritiek, niet weg te klikken, en telt voor de stip", () => {
    const a = computeAttention(NOW);
    const pw = a.items.find((i) => i.key === "security:password")!;
    expect(pw).toMatchObject({ severity: "critical", dismissible: false, action: { href: "/settings/beveiliging#toegang" } });
    expect(a.items[0].key).toBe("security:password"); // kritiek eerst
    dismissAttention("security:password", pw.fingerprint);
    expect(keys()).toContain("security:password");
    expect(criticalCount()).toBe(1);
  });

  it("met wachtwoord verdwijnt het punt; zonder back-up volgt een info-punt met directe download", () => {
    setPassword("geheim123");
    expect(keys()).not.toContain("security:password");
    expect(criticalCount()).toBe(0);
    const backup = computeAttention(NOW).items.find((i) => i.key === "backup:none")!;
    expect(backup).toMatchObject({ severity: "info", action: { href: "/api/backup", download: true } });
    setMeta("lastBackupAt", "2026-03-01T10:00:00.000Z");
    expect(keys()).not.toContain("backup:none");
    expect(keys()).not.toContain("backup:old");
    setMeta("lastBackupAt", "2026-01-01T10:00:00.000Z");
    expect(keys()).toContain("backup:old");
  });

  it("mislukte koersen noemen de namen en tellen de mislukte rondes", () => {
    const db = getDb();
    const job = (ok: boolean, message: string, details?: unknown, at = "2026-03-10T10:00:00.000Z") =>
      db.insert(schema.jobRuns).values({ job: "refresh:interval", startedAt: at, finishedAt: at, ok, message, details: details ? JSON.stringify(details) : null }).run();
    job(true, "5 bijgewerkt, 0 mislukt", undefined, "2026-03-10T08:00:00.000Z");
    job(false, "4 bijgewerkt, 1 mislukt: AAA", { failed: [{ asset: "AAA", assetId: 1, error: "404" }] }, "2026-03-10T09:00:00.000Z");
    job(false, "3 bijgewerkt, 2 mislukt: AAA, BBB", { failed: [{ asset: "AAA", error: "404" }, { asset: "BBB", error: "timeout" }] });
    const item = computeAttention(NOW).items.find((i) => i.key === "prices:failed")!;
    expect(item.body).toBe("AAA en BBB mislukten in 2 van de laatste 3 rondes.");
    expect(item.action.href).toBe("/settings/koersen#taken");
    // weggeklikt blijft weg zolang dezelfde koersen mislukken; een nieuwe naam brengt het terug
    dismissAttention(item.key, item.fingerprint);
    expect(keys()).not.toContain("prices:failed");
    job(false, "3 bijgewerkt, 1 mislukt: CCC", { failed: [{ asset: "CCC", error: "x" }] }, "2026-03-10T11:00:00.000Z");
    expect(keys()).toContain("prices:failed");
    expect(computeAttention(NOW).dismissed).toBe(0);
  });

  it("koppelingen: fout is kritiek, waarschuwingen en afstemming zijn let op; wallet zonder node", () => {
    const db = getDb();
    const wallet = createConnection({ provider: "bitcoin", label: "Koude wallet", portfolioId: 1, mode: "alongside", accounts: [{ xpub: ZPUB, scriptType: "p2wpkh", label: "Account 1" }] });
    expect(keys()).toContain("node:missing");
    const kraken = createConnection({ provider: "kraken", label: "Kraken", portfolioId: 1, mode: "alongside", apiKey: "test-key", apiSecret: "test-secret" });
    db.update(schema.connections).set({ status: "error", lastError: "Kraken 403: permission denied\nmeer tekst" }).where(eq(schema.connections.id, kraken.id)).run();
    const err = computeAttention(NOW).items.find((i) => i.key === `conn:${kraken.id}:error`)!;
    expect(err).toMatchObject({ severity: "critical", body: "sync mislukt (Kraken 403: permission denied).", action: { href: `/settings/platforms/${kraken.platformId}` } });
    expect(criticalCount()).toBe(1);

    db.update(schema.connections).set({ status: "ok", lastError: null, reconciliation: JSON.stringify([{ symbol: "ETH", assetId: null, computed: "1", reported: "1.1", diff: "0.1" }]) }).where(eq(schema.connections.id, kraken.id)).run();
    db.insert(schema.syncRuns).values({ connectionId: kraken.id, trigger: "manual", startedAt: "2026-03-10T09:00:00.000Z", finishedAt: "2026-03-10T09:01:00.000Z", ok: true, message: "0 nieuw, 0 overgeslagen, 2 waarschuwing(en)", warnings: JSON.stringify(["a", "b"]) }).run();
    const list = computeAttention(NOW).items;
    expect(list.find((i) => i.key === `conn:${kraken.id}:recon`)?.body).toBe("1 afstemmingsverschil (ETH).");
    expect(list.find((i) => i.key === `conn:${kraken.id}:warnings`)?.body).toBe("2 waarschuwingen bij de laatste sync.");
    // de fingerprint heeft een vaste lengte, ook bij honderden waarschuwingen (de route neemt er hooguit 5000 tekens aan)
    const many = Array.from({ length: 200 }, (_, i) => `Trade T${i}: valutawissel overgeslagen (geen positie), handmatig controleren.`);
    db.insert(schema.syncRuns).values({ connectionId: kraken.id, trigger: "manual", startedAt: "2026-03-10T09:30:00.000Z", finishedAt: "2026-03-10T09:31:00.000Z", ok: true, message: "0 nieuw, 0 overgeslagen, 350 waarschuwing(en)", warnings: JSON.stringify(many) }).run();
    const noisy = computeAttention(NOW).items.find((i) => i.key === `conn:${kraken.id}:warnings`)!;
    expect(noisy.body).toBe("350 waarschuwingen bij de laatste sync.");
    expect(noisy.fingerprint).toHaveLength(32);

    // publieke node in gebruik (cursor van de laatste sync)
    db.update(schema.connections).set({ cursor: JSON.stringify({ source: "fallback" }) }).where(eq(schema.connections.id, wallet.id)).run();
    setSetting("bitcoinApiUrl", "http://node.local:3006");
    const fb = computeAttention(NOW).items.find((i) => i.key === "node:fallback")!;
    expect(fb.body).toBe("Koude wallet synchroniseert via mempool.space; die node ziet je wallet-adressen.");
    expect(keys()).not.toContain("node:missing");
  });

  it("meldingen: push zonder apparaten en ntfy zonder URL", () => {
    setSetting("notifyChannel", "push");
    expect(keys()).toContain("notify:push-none");
    // negeren vervalt als het punt opgelost is: komt het terug, dan is het weer zichtbaar
    const push = computeAttention(NOW).items.find((i) => i.key === "notify:push-none")!;
    dismissAttention(push.key, push.fingerprint);
    expect(keys()).not.toContain("notify:push-none");
    setSetting("notifyChannel", "app");
    computeAttention(NOW);
    setSetting("notifyChannel", "push");
    expect(keys()).toContain("notify:push-none");
    setSetting("notifyChannel", "ntfy");
    expect(keys()).toContain("notify:ntfy-missing");
    setSetting("ntfyTopicUrl", "https://ntfy.example/test-topic");
    expect(keys()).not.toContain("notify:ntfy-missing");
    setSetting("notifyChannel", "app");
  });

  it("gearchiveerd portfolio met koppeling is info", () => {
    getDb().update(schema.portfolios).set({ archived: true }).where(eq(schema.portfolios.id, 1)).run();
    const item = computeAttention(NOW).items.find((i) => i.key === "portfolio:1:archived")!;
    expect(item).toMatchObject({ severity: "info", body: "maar 2 koppelingen boeken er nog in." });
    getDb().update(schema.portfolios).set({ archived: false }).where(eq(schema.portfolios.id, 1)).run();
  });
});

describe("samenvattingen en activiteit", () => {
  it("één regel per categorie", () => {
    const s = settingsSummaries(NOW);
    expect(s.weergave.text).toBe("EUR · gemiddelde kostprijs · valuta-effect mee · stof verborgen");
    expect(s.portfolios.text).toBe("1 actief");
    expect(s.platforms.text).toMatch(/^\d+ platforms · 2 koppelingen · publieke node$/);
    expect(s.platforms.level).toBe("warn");
    expect(s.koersen.text).toBe("Koersen elk uur · ronde 23:45 · 1 mislukt");
    expect(s.meldingen.text).toBe("Alleen in de app");
    expect(s.beveiliging.text).toBe("Beveiligd · back-up 01-01-2026");
    clearPassword();
    expect(settingsSummaries(NOW).beveiliging).toMatchObject({ text: "Niet beveiligd · back-up 01-01-2026", level: "critical" });
  });

  it("activiteit: koersrondes en syncs in één lijst, nieuwste eerst, met mislukte koersen en waarschuwingen", () => {
    const a = recentActivity(10);
    expect(a[0]).toMatchObject({ kind: "job", key: "refresh:interval", label: "Koersen verversen (automatisch)", failed: [{ asset: "CCC" }] });
    const syncs = a.filter((r) => r.kind === "sync");
    expect(syncs[0]).toMatchObject({ label: "Sync Kraken (handmatig)" });
    expect(syncs.map((r) => r.warnings.length)).toEqual([200, 2]);
    expect(syncs[1].warnings).toEqual(["a", "b"]);
  });

  it("warningCount valt terug op de melding van oudere runs", () => {
    expect(warningCount({ warnings: null, message: "1 nieuw, 0 overgeslagen, 3 waarschuwing(en)" })).toBe(3);
    expect(warningCount({ warnings: JSON.stringify(["x"]), message: "" })).toBe(1);
    expect(warningCount({ warnings: ["x", "y"], message: "0 nieuw, 350 waarschuwing(en)" })).toBe(350); // lijst afgekapt
    expect(warningCount(null)).toBe(0);
  });
});
