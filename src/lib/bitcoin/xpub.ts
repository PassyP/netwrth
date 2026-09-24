/**
 * Extended public keys (xpub/ypub/zpub; BIP32 met SLIP-132-prefixen) en adresafleiding voor een watch-only
 * Bitcoin-account. Alleen mainnet, alleen public keys. Uit een account-key (diepte 3, bijv. m/84'/0'/0') zijn de
 * ontvangstketen m/0/i en de wisselketen m/1/i af te leiden; zuster-accounts (m/84'/0'/1') niet, want dat is
 * hardened en vereist de private key. Ledger Live exporteert élk account met het generieke prefix "xpub", ook
 * SegWit- en Native-SegWit-accounts: het adrestype is dan niet uit het prefix af te leiden en wordt gescand.
 * Foutmeldingen bevatten nooit de ingevoerde sleutel.
 */
import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";
import { SCRIPT_TYPES, type ScriptType } from "../db/schema";

export type KeyPrefix = "xpub" | "ypub" | "zpub";

/** SLIP-132 versiebytes (mainnet); het prefix bepaalt het standaard-adrestype. */
const VERSIONS: Record<KeyPrefix, { public: number; private: number }> = {
  xpub: { public: 0x0488b21e, private: 0x0488ade4 },
  ypub: { public: 0x049d7cb2, private: 0x049d7878 },
  zpub: { public: 0x04b24746, private: 0x04b2430c },
};

export const PREFIX_DEFAULT_TYPE: Record<KeyPrefix, ScriptType> = { xpub: "p2pkh", ypub: "p2sh-p2wpkh", zpub: "p2wpkh" };

export const SCRIPT_TYPE_LABELS: Record<ScriptType, string> = {
  p2pkh: "Legacy (1…)",
  "p2sh-p2wpkh": "SegWit (3…)",
  p2wpkh: "Native SegWit (bc1q…)",
  p2tr: "Taproot (bc1p…)",
};

export const SCRIPT_TYPE_SHORT: Record<ScriptType, string> = { p2pkh: "Legacy", "p2sh-p2wpkh": "SegWit", p2wpkh: "Native SegWit", p2tr: "Taproot" };

export interface ParsedXpub {
  prefix: KeyPrefix;
  key: HDKey;
  fingerprint: string; // 8 hex
  depth: number; // 3 bij een account-key
}

export function fingerprintHex(key: HDKey): string {
  return key.fingerprint.toString(16).padStart(8, "0");
}

/** Leest en valideert een xpub/ypub/zpub; gooit een melding zonder de sleutel te herhalen. */
export function parseExtendedPublicKey(raw: string): ParsedXpub {
  const s = raw.trim();
  const prefix = s.slice(0, 4);
  if (/^[xyz]prv$/i.test(prefix)) throw new Error("Dit is een private key (xprv/yprv/zprv); voer nooit een private key in, alleen de xpub.");
  if (/^[tuv]pub$/i.test(prefix)) throw new Error("Dit is een testnet-key (tpub/upub/vpub); alleen mainnet wordt ondersteund.");
  if (prefix !== "xpub" && prefix !== "ypub" && prefix !== "zpub") throw new Error("Geen geldige xpub, ypub of zpub.");
  let key: HDKey;
  try {
    key = HDKey.fromExtendedKey(s, VERSIONS[prefix]);
  } catch {
    throw new Error("Geen geldige xpub, ypub of zpub (checksum of formaat klopt niet).");
  }
  if (key.privateKey || !key.publicKey) throw new Error("Geen geldige public key.");
  return { prefix, key, fingerprint: fingerprintHex(key), depth: key.depth };
}

/** Welke adrestypes een sleutel kan voorstellen: een xpub is dubbelzinnig, ypub/zpub impliceren hun type. */
export function candidateScriptTypes(prefix: KeyPrefix, allTypes = false): ScriptType[] {
  if (allTypes || prefix === "xpub") return [...SCRIPT_TYPES];
  return [PREFIX_DEFAULT_TYPE[prefix]];
}

/** Adres van een gecomprimeerde public key (33 bytes) voor een adrestype. */
export function addressFor(publicKey: Uint8Array, scriptType: ScriptType): string {
  let address: string | undefined;
  switch (scriptType) {
    case "p2pkh":
      address = btc.p2pkh(publicKey).address;
      break;
    case "p2sh-p2wpkh":
      address = btc.p2sh(btc.p2wpkh(publicKey)).address;
      break;
    case "p2wpkh":
      address = btc.p2wpkh(publicKey).address;
      break;
    case "p2tr":
      address = btc.p2tr(publicKey.slice(1)).address; // x-only interne sleutel (BIP86)
      break;
  }
  if (!address) throw new Error("Adres niet af te leiden.");
  return address;
}

export type AddressDeriver = (chain: 0 | 1, index: number) => string;

/** Afleider voor m/<chain>/<index> onder een account-key; de ketensleutel wordt één keer afgeleid. */
export function makeAddressDeriver(key: HDKey, scriptType: ScriptType): AddressDeriver {
  const chains = new Map<number, HDKey>();
  return (chain, index) => {
    if (!chains.has(chain)) chains.set(chain, key.deriveChild(chain));
    const child = chains.get(chain)!.deriveChild(index);
    if (!child.publicKey) throw new Error("Geen public key af te leiden.");
    return addressFor(child.publicKey, scriptType);
  };
}

/** Verkorte weergave van een adres (begin en eind), voor lijsten en meldingen. */
export function shortAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}
