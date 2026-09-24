import { describe, it, expect } from "vitest";
import { LEGACY_ANCHORS, SETTINGS_NAV, legacyTarget, searchSettings } from "./settings-nav";

describe("instellingen-register", () => {
  it("elke oude anker van de lange instellingenpagina heeft een bestemming", () => {
    for (const a of ["weergave", "portfolios", "platforms", "koppelingen", "bitcoin", "meldingen", "beveiliging", "backup", "taken"]) {
      expect(LEGACY_ANCHORS[a], a).toMatch(/^\/settings\//);
    }
    expect(legacyTarget("#bitcoin")).toBe("/settings/platforms#bitcoin-node");
    expect(legacyTarget("BACKUP")).toBe("/settings/beveiliging#backup");
    expect(legacyTarget("#onbekend")).toBeNull();
    expect(legacyTarget("#constructor")).toBeNull();
    expect(legacyTarget("#__proto__")).toBeNull();
    expect(legacyTarget("")).toBeNull();
  });

  it("labels zijn uniek en routes liggen onder /settings", () => {
    const labels = SETTINGS_NAV.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const c of SETTINGS_NAV) expect(c.href).toBe(`/settings/${c.id}`);
  });

  it("zoekt op trefwoord en combineert woorden", () => {
    expect(searchSettings("fifo").map((h) => h.href)).toEqual(["/settings/weergave#berekening"]);
    expect(searchSettings("umbrel")[0]).toMatchObject({ label: "Bitcoin-node", href: "/settings/platforms#bitcoin-node" });
    expect(searchSettings("secret.key")[0].href).toBe("/settings/beveiliging#backup");
    expect(searchSettings("push test")).toHaveLength(1);
    expect(searchSettings("   ")).toEqual([]);
  });
});
