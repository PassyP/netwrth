import { describe, it, expect } from "vitest";
import { addressFor, candidateScriptTypes, makeAddressDeriver, parseExtendedPublicKey, shortAddress } from "./xpub";

import { XPUB86, YPUB, ZPUB } from "./test-vectors";

describe("xpub", () => {
  it("BIP84 zpub: native-segwit-adressen op de ontvangst- en wisselketen", () => {
    const p = parseExtendedPublicKey(ZPUB);
    expect(p.prefix).toBe("zpub");
    expect(p.depth).toBe(3);
    expect(p.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    const derive = makeAddressDeriver(p.key, "p2wpkh");
    expect(derive(0, 0)).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    expect(derive(0, 1)).toBe("bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g");
    expect(derive(1, 0)).toBe("bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el");
  });

  it("BIP49 ypub: nested-segwit-adres", () => {
    const p = parseExtendedPublicKey(YPUB);
    expect(p.prefix).toBe("ypub");
    expect(makeAddressDeriver(p.key, "p2sh-p2wpkh")(0, 0)).toBe("37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf");
  });

  it("BIP86 xpub: taproot-adres; dezelfde key geeft per adrestype een ander adres", () => {
    const p = parseExtendedPublicKey(XPUB86);
    expect(p.prefix).toBe("xpub");
    const child = p.key.deriveChild(0).deriveChild(0).publicKey!;
    expect(addressFor(child, "p2tr")).toBe("bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr");
    expect(addressFor(child, "p2pkh")).toMatch(/^1/);
    expect(addressFor(child, "p2sh-p2wpkh")).toMatch(/^3/);
    expect(addressFor(child, "p2wpkh")).toMatch(/^bc1q/);
  });

  it("weigert private keys, testnet-keys en rommel zonder de invoer te herhalen", () => {
    const xprv = "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi";
    expect(() => parseExtendedPublicKey(xprv)).toThrow(/private key/);
    try {
      parseExtendedPublicKey(xprv);
    } catch (e) {
      expect((e as Error).message).not.toContain(xprv.slice(4, 20));
    }
    expect(() => parseExtendedPublicKey("tpubD6NzVbkrYhZ4XgiXtGrdW5XDAPFCL9h7we1vwNCpn8tGbBcgfVYjXyhWo4E1xkh56hjod1RhGjxbaTLV3X4FyWuejifB9jusQ46QzG87VKp")).toThrow(/testnet/);
    expect(() => parseExtendedPublicKey("hallo")).toThrow(/Geen geldige/);
    expect(() => parseExtendedPublicKey("")).toThrow(/Geen geldige/);
    // laatste teken gewijzigd → checksum klopt niet
    expect(() => parseExtendedPublicKey(ZPUB.slice(0, -1) + "X")).toThrow(/checksum/);
    // spaties eromheen zijn geen probleem
    expect(parseExtendedPublicKey(`  ${ZPUB}\n`).prefix).toBe("zpub");
  });

  it("kandidaat-adrestypes: xpub is dubbelzinnig, ypub/zpub impliceren hun type, allTypes scant alles", () => {
    expect(candidateScriptTypes("xpub")).toEqual(["p2pkh", "p2sh-p2wpkh", "p2wpkh", "p2tr"]);
    expect(candidateScriptTypes("ypub")).toEqual(["p2sh-p2wpkh"]);
    expect(candidateScriptTypes("zpub")).toEqual(["p2wpkh"]);
    expect(candidateScriptTypes("zpub", true)).toHaveLength(4);
  });

  it("hardened afleiding is onmogelijk vanaf een xpub (zuster-accounts zijn niet te bereiken)", () => {
    const p = parseExtendedPublicKey(ZPUB);
    expect(() => p.key.deriveChild(0x80000000)).toThrow();
  });

  it("shortAddress toont begin en eind", () => {
    expect(shortAddress("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu")).toBe("bc1qcr8t…306fyu");
    expect(shortAddress("kort")).toBe("kort");
  });
});
