import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-auth-test-"));

import { hashPassword, verifyPassword, signToken, verifyToken, sessionKey, setPassword, clearPassword, isPasswordSet, checkPassword, createSessionToken, isAuthorized, readSessionCookie, sessionCookie, lockedFor, registerFailure, registerSuccess, generateRecoveryCode, normalizeRecoveryCode, checkRecoveryCode, isRecoveryCodeSet, rotateRecoveryCode } from "./auth";

describe("wachtwoord-hash", () => {
  it("verifieert het juiste wachtwoord en weigert een fout wachtwoord", () => {
    const h = hashPassword("geheim123");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("geheim123", h)).toBe(true);
    expect(verifyPassword("geheim124", h)).toBe(false);
    expect(verifyPassword("geheim123", "kapot")).toBe(false);
  });

  it("gebruikt per hash een andere salt", () => {
    expect(hashPassword("x")).not.toBe(hashPassword("x"));
  });
});

describe("sessietoken", () => {
  const key = Buffer.alloc(32, 1);

  it("is geldig tot de vervaldatum", () => {
    const t = signToken(key, 1_000_000);
    expect(verifyToken(key, t, 999_999)).toBe(true);
    expect(verifyToken(key, t, 1_000_000)).toBe(false);
  });

  it("weigert een gemanipuleerd token, een andere sleutel en rommel", () => {
    const t = signToken(key, 2_000_000);
    const [, mac] = t.split(".");
    expect(verifyToken(key, `9999999999.${mac}`, 0)).toBe(false);
    expect(verifyToken(Buffer.alloc(32, 2), t, 0)).toBe(false);
    expect(verifyToken(key, "onzin", 0)).toBe(false);
    expect(verifyToken(key, null, 0)).toBe(false);
  });

  it("leidt per wachtwoord-hash een andere sleutel af", () => {
    expect(sessionKey("a").equals(sessionKey("b"))).toBe(false);
  });
});

describe("login met database", () => {
  it("is open zonder wachtwoord en dicht met wachtwoord", () => {
    clearPassword();
    expect(isPasswordSet()).toBe(false);
    expect(isAuthorized(null)).toBe(true);

    setPassword("hallo-wereld");
    expect(isPasswordSet()).toBe(true);
    expect(checkPassword("hallo-wereld")).toBe(true);
    expect(checkPassword("fout")).toBe(false);
    expect(isAuthorized(null)).toBe(false);

    const token = createSessionToken(true);
    expect(isAuthorized(token)).toBe(true);

    // wachtwoord wijzigen → oude sessies ongeldig
    setPassword("nieuw-wachtwoord");
    expect(isAuthorized(token)).toBe(false);
    expect(isAuthorized(createSessionToken(false))).toBe(true);

    clearPassword();
    expect(isAuthorized("wat-dan-ook")).toBe(true);
  });

  it("leest en schrijft de cookie", () => {
    const req = new Request("http://localhost/", { headers: { cookie: "a=1; pm_session=abc.def; b=2" } });
    expect(readSessionCookie(req)).toBe("abc.def");
    expect(readSessionCookie(new Request("http://localhost/"))).toBeNull();

    expect(sessionCookie("t", true, req)).toContain("Max-Age=");
    expect(sessionCookie("t", false, req)).not.toContain("Max-Age=");
    expect(sessionCookie("t", true, req)).not.toContain("Secure");
    const https = new Request("http://localhost/", { headers: { "x-forwarded-proto": "https" } });
    expect(sessionCookie("t", true, https)).toContain("Secure");
  });
});

describe("herstelcode", () => {
  it("heeft het formaat XXXX-XXXX-XXXX-XXXX zonder verwarrende tekens", () => {
    const c = generateRecoveryCode();
    expect(c).toMatch(/^[A-HJ-KM-NP-Z2-9]{4}(-[A-HJ-KM-NP-Z2-9]{4}){3}$/);
    expect(normalizeRecoveryCode(" abcd-efgh 2345_jkmn ")).toBe("ABCDEFGH2345JKMN");
  });

  it("wordt bij elk wachtwoord aangemaakt, werkt één keer per code en verdwijnt met het wachtwoord", () => {
    clearPassword();
    expect(isRecoveryCodeSet()).toBe(false);
    const code = setPassword("hallo-wereld");
    expect(isRecoveryCodeSet()).toBe(true);
    expect(checkRecoveryCode(code.toLowerCase())).toBe(true);
    expect(checkRecoveryCode("AAAA-BBBB-CCCC-DDDD")).toBe(false);

    const fresh = rotateRecoveryCode();
    expect(checkRecoveryCode(code)).toBe(false);
    expect(checkRecoveryCode(fresh)).toBe(true);

    clearPassword();
    expect(isRecoveryCodeSet()).toBe(false);
  });
});

describe("brute-force-rem", () => {
  it("blokkeert na vijf fouten en laat weer los na de wachttijd", () => {
    const ip = "10.0.0.1";
    for (let i = 0; i < 4; i++) registerFailure(ip, 1000);
    expect(lockedFor(ip, 1000)).toBe(0);
    registerFailure(ip, 1000);
    expect(lockedFor(ip, 1000)).toBe(60);
    expect(lockedFor(ip, 1000 + 60_000)).toBe(0);
    registerSuccess(ip);
    expect(lockedFor(ip, 1000)).toBe(0);
  });
});
