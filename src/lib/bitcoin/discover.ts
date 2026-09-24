/**
 * Adresscan en accountontdekking (Ledger Live-model): per account-key en adrestype worden de ontvangstketen m/0/i en
 * de wisselketen m/1/i afgeleid en op de eigen node opgezocht tot `gapLimit` opeenvolgende adressen zonder transacties
 * (mempool meegeteld). Stateless: elke sync begint bij index 0, zodat late betalingen op oude adressen ook gezien
 * worden. Adressen worden niet bewaard of gelogd.
 */
import type { HDKey } from "@scure/bip32";
import Decimal from "decimal.js";
import type { ScriptType } from "../db/schema";
import type { EsploraAddressStats, EsploraClient } from "./esplora";
import { candidateScriptTypes, makeAddressDeriver, parseExtendedPublicKey, PREFIX_DEFAULT_TYPE, SCRIPT_TYPE_SHORT, shortAddress, type KeyPrefix } from "./xpub";

export const DEFAULT_GAP_LIMIT = 20;
export const MAX_ADDRESS_INDEX = 10000;

export function satsToBtc(sats: number | Decimal): string {
  return new Decimal(sats).div(1e8).toFixed(8);
}

export interface UsedAddress {
  chain: 0 | 1;
  index: number;
  address: string;
  stats: EsploraAddressStats;
}

export interface ChainScan {
  used: number; // hoogste gebruikte index + 1 (0 = keten ongebruikt)
  usedAddresses: UsedAddress[];
  all: string[]; // alle afgeleide adressen, inclusief het gap-venster
}

export interface AccountScan {
  receive: ChainScan;
  change: ChainScan;
  own: Set<string>;
  confirmedSats: number; // Σ (funded − spent) on-chain
  unconfirmedSats: number; // Σ (funded − spent) in de mempool; kan negatief zijn
  txCountApprox: number; // Σ tx_count per adres: bovengrens, een tx kan meerdere adressen raken
}

export interface ScanOptions {
  gapLimit?: number;
  maxIndex?: number;
}

function isUsed(s: EsploraAddressStats): boolean {
  return s.chain_stats.tx_count + s.mempool_stats.tx_count > 0;
}

async function scanChain(client: EsploraClient, derive: (chain: 0 | 1, index: number) => string, chain: 0 | 1, gapLimit: number, maxIndex: number): Promise<ChainScan> {
  const usedAddresses: UsedAddress[] = [];
  const all: string[] = [];
  let lastUsed = -1;
  let index = 0;
  while (index < maxIndex) {
    const batch = Array.from({ length: gapLimit }, (_, i) => ({ index: index + i, address: derive(chain, index + i) }));
    const stats = await client.mapLimit(batch, (b) => client.addressStats(b.address));
    batch.forEach((b, i) => {
      all.push(b.address);
      if (isUsed(stats[i])) {
        lastUsed = b.index;
        usedAddresses.push({ chain, index: b.index, address: b.address, stats: stats[i] });
      }
    });
    index += gapLimit;
    if (index - lastUsed - 1 >= gapLimit) break; // ≥ gapLimit opeenvolgende ongebruikte adressen na het laatste gebruikte
  }
  return { used: lastUsed + 1, usedAddresses, all };
}

export async function scanAccount(client: EsploraClient, key: HDKey, scriptType: ScriptType, opts: ScanOptions = {}): Promise<AccountScan> {
  const gapLimit = opts.gapLimit ?? DEFAULT_GAP_LIMIT;
  const maxIndex = opts.maxIndex ?? MAX_ADDRESS_INDEX;
  const derive = makeAddressDeriver(key, scriptType);
  const [receive, change] = await Promise.all([scanChain(client, derive, 0, gapLimit, maxIndex), scanChain(client, derive, 1, gapLimit, maxIndex)]);
  const own = new Set<string>([...receive.all, ...change.all]);
  let confirmedSats = 0;
  let unconfirmedSats = 0;
  let txCountApprox = 0;
  for (const u of [...receive.usedAddresses, ...change.usedAddresses]) {
    confirmedSats += u.stats.chain_stats.funded_txo_sum - u.stats.chain_stats.spent_txo_sum;
    unconfirmedSats += u.stats.mempool_stats.funded_txo_sum - u.stats.mempool_stats.spent_txo_sum;
    txCountApprox += u.stats.chain_stats.tx_count + u.stats.mempool_stats.tx_count;
  }
  return { receive, change, own, confirmedSats, unconfirmedSats, txCountApprox };
}

export interface DiscoverCandidate {
  keyIndex: number; // regelnummer (0-based) in de invoer; de xpub zelf gaat niet terug naar de client
  fingerprint: string;
  prefix: KeyPrefix;
  depth: number;
  scriptType: ScriptType;
  label: string;
  firstAddress: string; // verkort eerste ontvangstadres, ter controle tegen de wallet
  txCount: number; // bovengrens (±)
  balanceConfirmed: string; // BTC
  balanceUnconfirmed: string; // BTC
  receiveUsed: number;
  changeUsed: number;
  active: boolean; // minstens één gebruikt adres
  defaultType: boolean; // het adrestype dat het prefix impliceert
}

export interface DiscoverOptions {
  client: EsploraClient;
  allTypes?: boolean;
  gapLimit?: number;
}

export interface DiscoverResult {
  candidates: DiscoverCandidate[];
  warnings: string[];
}

/** Ontdekt per ingevoerde sleutel de kandidaat-accounts (adrestypes) met saldo en activiteit; bewaart en logt niets. */
export async function discoverAccounts(keys: string[], opts: DiscoverOptions): Promise<DiscoverResult> {
  const warnings: string[] = [];
  const candidates: DiscoverCandidate[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < keys.length; i++) {
    const raw = keys[i].trim();
    const line = i + 1;
    if (!raw) continue;
    const dup = seen.get(raw);
    if (dup != null) {
      warnings.push(`Regel ${line} is een duplicaat van regel ${dup}; overgeslagen.`);
      continue;
    }
    seen.set(raw, line);
    let parsed;
    try {
      parsed = parseExtendedPublicKey(raw);
    } catch (e) {
      warnings.push(`Regel ${line}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (parsed.depth !== 3) warnings.push(`Regel ${line}: geen account-key (diepte ${parsed.depth} in plaats van 3); de adressen kunnen afwijken van je wallet.`);
    for (const scriptType of candidateScriptTypes(parsed.prefix, opts.allTypes)) {
      const scan = await scanAccount(opts.client, parsed.key, scriptType, { gapLimit: opts.gapLimit });
      const n = seen.size;
      candidates.push({
        keyIndex: i,
        fingerprint: parsed.fingerprint,
        prefix: parsed.prefix,
        depth: parsed.depth,
        scriptType,
        label: `Bitcoin ${n} · ${SCRIPT_TYPE_SHORT[scriptType]}`,
        firstAddress: shortAddress(scan.receive.all[0]),
        txCount: scan.txCountApprox,
        balanceConfirmed: satsToBtc(scan.confirmedSats),
        balanceUnconfirmed: satsToBtc(scan.unconfirmedSats),
        receiveUsed: scan.receive.used,
        changeUsed: scan.change.used,
        active: scan.receive.used > 0 || scan.change.used > 0,
        defaultType: PREFIX_DEFAULT_TYPE[parsed.prefix] === scriptType,
      });
    }
  }
  return { candidates, warnings };
}
