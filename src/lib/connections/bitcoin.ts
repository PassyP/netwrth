/**
 * Bitcoin-wallet als koppeling (watch-only, xpub): saldo en on-chain transacties van de eigen node (Umbrel mempool-app,
 * Esplora-API). Geen credentials; de accounts komen via ctx.accounts uit de database.
 *
 * Boekingsregels (per koppeling, niet per account — een overboeking tussen twee eigen accounts is dan alleen de fee):
 * - netto = Σ eigen outputs − Σ eigen inputs van een transactie;
 * - pas boeken bij ≥ BTC_MIN_CONFIRMATIONS bevestigingen (RBF-vervangingen worden nooit geboekt, een reorg van een
 *   geboekte transactie is dan praktisch uitgesloten); daaronder telt de transactie als "in afwachting" (hold);
 * - netto > 0 → transfer_in tegen de Kraken BTC/EUR-koers op bloktijd (kostprijs, zoals bij Kraken-stortingen);
 * - netto < 0 → transfer_out van |netto| (inclusief minerfee, zodat positie == saldo), prijs 0 (haalt weg tegen
 *   boekwaarde, geen resultaat), plus een aparte fee-transactie in EUR als alle inputs van ons zijn;
 * - de koers wordt alleen opgevraagd voor transacties die nog niet geboekt zijn (ctx.hasTransaction).
 * Meldingen en notities bevatten txid's en accountlabels, nooit adressen.
 */
import Decimal from "decimal.js";
import { getSettings } from "../settings";
import { makeEsploraClient, probeNode, type EsploraClient, type EsploraTx } from "../bitcoin/esplora";
import { connectBitcoinNode, type BitcoinNodeChoice } from "../bitcoin/node";
import { parseExtendedPublicKey } from "../bitcoin/xpub";
import { DEFAULT_GAP_LIMIT, satsToBtc, scanAccount, type AccountScan } from "../bitcoin/discover";
import { krakenPublicClient, type KrakenClient } from "./kraken";
import type { ConnectionProvider, NormalizedTx, SyncOutput, TestOutput, WalletAccountUpdate, WalletAccountWithKey } from "./types";

export const BTC_MIN_CONFIRMATIONS = 6;
export const BTC_PRICE_SOURCE = { source: "kraken" as const, sourceId: "XXBTZEUR" };

export interface BitcoinProviderOptions {
  fetchImpl?: typeof fetch;
  /** Vaste node-URL zonder terugval (tests); anders de instellingen (eigen node, optioneel publieke terugval). */
  baseUrl?: string;
  gapLimit?: number;
  minConfirmations?: number;
  /** Fabriek voor de koersclient (tests); standaard de publieke Kraken-client. */
  kraken?: () => KrakenClient;
  now?: () => Date;
}

export interface BookInput {
  connectionId: number;
  tipHeight: number;
  minConfirmations: number;
  /** adres → accountlabel, voor alle ingeschakelde accounts samen */
  own: Map<string, string>;
  txs: EsploraTx[];
  hasTransaction: (externalId: string) => boolean;
  /** BTC/EUR op een ISO-tijdstip; null als er geen koers is */
  priceInEur: (iso: string) => Promise<number | null>;
}

export interface BookOutput {
  transactions: NormalizedTx[];
  confirmedSats: number; // netto van alle transacties met genoeg bevestigingen (ook de al geboekte)
  pendingSats: number; // netto van transacties in afwachting
  booked: number; // nieuw aangeleverd (fee-transacties niet meegeteld)
  known: number; // al geboekt, overgeslagen
  pending: number;
  warnings: string[];
}

const shortTxid = (txid: string) => `${txid.slice(0, 8)}…`;

/** Puur: van Esplora-transacties naar NormalizedTx-boekingen. */
export async function bookBitcoinTxs(input: BookInput): Promise<BookOutput> {
  const { connectionId, tipHeight, minConfirmations, own, hasTransaction, priceInEur } = input;
  const warnings: string[] = [];
  const transactions: NormalizedTx[] = [];
  let confirmedSats = 0;
  let pendingSats = 0;
  let booked = 0;
  let known = 0;
  let pending = 0;

  const analysed = input.txs.map((tx) => {
    let inOwn = 0;
    let outOwn = 0;
    let allInputsOwn = true;
    let allOutputsOwn = true;
    const labels = new Set<string>();
    for (const v of tx.vin) {
      if (v.is_coinbase) {
        allInputsOwn = false;
        continue;
      }
      const address = v.prevout?.scriptpubkey_address;
      const label = address ? own.get(address) : undefined;
      if (label !== undefined) {
        outOwn += v.prevout?.value ?? 0;
        labels.add(label);
      } else allInputsOwn = false;
    }
    for (const o of tx.vout) {
      const label = o.scriptpubkey_address ? own.get(o.scriptpubkey_address) : undefined;
      if (label !== undefined) {
        inOwn += o.value;
        labels.add(label);
      } else allOutputsOwn = false;
    }
    const height = tx.status.confirmed && tx.status.block_height != null ? tx.status.block_height : null;
    return { tx, net: inOwn - outOwn, allInputsOwn, allOutputsOwn, labels: [...labels].sort(), height };
  });
  // oudste eerst; binnen één blok eerst ontvangsten, dan verzendingen (anders kan een uitgave vóór zijn ontvangst landen)
  analysed.sort((a, b) => (a.height ?? Number.MAX_SAFE_INTEGER) - (b.height ?? Number.MAX_SAFE_INTEGER) || (a.net > 0 ? 0 : 1) - (b.net > 0 ? 0 : 1) || a.tx.txid.localeCompare(b.tx.txid));

  for (const a of analysed) {
    if (a.net === 0) continue;
    const confirmations = a.height == null ? 0 : tipHeight - a.height + 1;
    if (a.height == null || confirmations < minConfirmations) {
      pendingSats += a.net;
      pending++;
      continue;
    }
    confirmedSats += a.net;
    const externalId = `btc:${connectionId}:${a.tx.txid}`;
    if (hasTransaction(externalId)) {
      known++;
      continue;
    }
    const executedAt = new Date((a.tx.status.block_time ?? 0) * 1000).toISOString();
    const day = executedAt.slice(0, 10);
    const who = a.labels.join(", ");
    const base = { symbol: "BTC", assetName: "Bitcoin", category: "crypto" as const, priceSource: BTC_PRICE_SOURCE, currency: "EUR" as const, fee: "0", executedAt };
    if (a.net > 0) {
      const px = await priceInEur(executedAt);
      if (px == null) warnings.push(`Ontvangst ${shortTxid(a.tx.txid)}: geen EUR-koers voor BTC op ${day}; kostprijs op 0 gezet.`);
      transactions.push({ ...base, externalId, type: "transfer_in", quantity: satsToBtc(a.net), price: String(px ?? 0), note: `Bitcoin ontvangst · ${who} · blok ${a.height} · tx ${shortTxid(a.tx.txid)}` });
    } else {
      const feeBtc = satsToBtc(a.tx.fee);
      const internal = a.allInputsOwn && a.allOutputsOwn;
      const note = internal
        ? `Bitcoin interne overboeking · ${who} · blok ${a.height} · tx ${shortTxid(a.tx.txid)} (${feeBtc} BTC kosten)`
        : a.allInputsOwn
          ? `Bitcoin verzending · ${who} · blok ${a.height} · tx ${shortTxid(a.tx.txid)} (incl. ${feeBtc} BTC kosten)`
          : `Bitcoin verzending · ${who} · blok ${a.height} · tx ${shortTxid(a.tx.txid)} (gedeelde transactie, kosten niet geboekt)`;
      transactions.push({ ...base, externalId, type: "transfer_out", quantity: satsToBtc(-a.net), price: "0", note });
      if (a.allInputsOwn && a.tx.fee > 0) {
        const px = await priceInEur(executedAt);
        if (px == null) warnings.push(`Minerfee ${shortTxid(a.tx.txid)}: geen EUR-koers voor BTC op ${day}; kosten op 0 gezet.`);
        transactions.push({
          externalId: `${externalId}:fee`,
          type: "fee",
          symbol: "",
          quantity: "0",
          price: new Decimal(a.tx.fee).div(1e8).mul(px ?? 0).toFixed(8),
          currency: "EUR",
          fee: "0",
          executedAt,
          note: `Minerfee ${feeBtc} BTC · ${who} · tx ${shortTxid(a.tx.txid)}`,
        });
      }
    }
    booked++;
  }
  return { transactions, confirmedSats, pendingSats, booked, known, pending, warnings };
}

export function makeBitcoinProvider(opts: BitcoinProviderOptions = {}): ConnectionProvider {
  const gapLimit = opts.gapLimit ?? DEFAULT_GAP_LIMIT;
  const minConfirmations = opts.minConfirmations ?? BTC_MIN_CONFIRMATIONS;
  const now = opts.now ?? (() => new Date());
  /** Node volgens de opties of de instellingen; controleert meteen de bereikbaarheid (blokhoogte). */
  const connect = async (): Promise<BitcoinNodeChoice> => {
    if (opts.baseUrl) {
      const client: EsploraClient = makeEsploraClient({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });
      return { client, source: "own", tipHeight: await client.tipHeight(), warnings: [] };
    }
    return connectBitcoinNode(getSettings(), opts.fetchImpl);
  };

  return {
    id: "bitcoin",
    label: "Bitcoin wallet",
    credentials: "none",
    helpUrl: "https://support.ledger.com/article/360011069619-zd",
    async test(): Promise<TestOutput> {
      try {
        const node = await connect();
        const r = await probeNode(node.client);
        const message = node.source === "fallback" ? `${node.warnings[0]} ${r.message}` : r.message;
        return { ok: r.ok, message, details: { source: node.source, ...(r.height != null ? { height: r.height } : {}) } };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    async sync(_creds, ctx): Promise<SyncOutput> {
      const warnings: string[] = [];
      const accounts = (ctx.accounts ?? []).filter((a) => a.enabled);
      const empty = (msg: string): SyncOutput => ({ transactions: [], balances: [{ currency: "BTC", amount: "0.00000000", hold: "0.00000000" }], cursor: ctx.cursor, warnings: [msg] });
      if (!accounts.length) return empty("Geen ingeschakelde accounts; zet minstens één account aan.");

      const node = await connect();
      const { client, tipHeight } = node;
      warnings.push(...node.warnings);

      const scans: { account: WalletAccountWithKey; scan: AccountScan }[] = [];
      for (const account of accounts) {
        let key;
        try {
          key = parseExtendedPublicKey(account.xpub).key;
        } catch (e) {
          warnings.push(`Account ${account.label}: ${e instanceof Error ? e.message : String(e)} Overgeslagen.`);
          continue;
        }
        scans.push({ account, scan: await scanAccount(client, key, account.scriptType, { gapLimit }) });
      }
      if (!scans.length) return empty(warnings[0] ?? "Geen bruikbare accounts.");

      const own = new Map<string, string>();
      const accountOf = new Map<string, number>();
      for (const { account, scan } of scans) {
        for (const address of scan.own) {
          own.set(address, account.label);
          accountOf.set(address, account.id);
        }
      }
      const used = scans.flatMap(({ scan }) => [...scan.receive.usedAddresses, ...scan.change.usedAddresses].map((u) => u.address));
      const lists = await client.mapLimit(used, (address) => client.addressTxs(address));
      const txs = new Map<string, EsploraTx>();
      for (const list of lists) for (const tx of list) txs.set(tx.txid, tx);

      let kraken: KrakenClient | null = null;
      const priceInEur = async (iso: string) => {
        kraken ??= (opts.kraken ?? (() => krakenPublicClient({ fetchImpl: opts.fetchImpl })))();
        return kraken.priceInEur("BTC", iso);
      };
      const book = await bookBitcoinTxs({ connectionId: ctx.id, tipHeight, minConfirmations, own, txs: [...txs.values()], hasTransaction: ctx.hasTransaction, priceInEur });
      warnings.push(...book.warnings);
      ctx.log(`Bitcoin: ${scans.length} account(s), ${used.length} gebruikte adressen, ${txs.size} transacties, ${book.booked} nieuw, ${book.known} bekend, ${book.pending} in afwachting`);

      // per account: unieke transacties die een adres van dat account raken
      const txidsPerAccount = new Map<number, Set<string>>();
      for (const tx of txs.values()) {
        const touched = new Set<number>();
        for (const v of tx.vin) {
          const id = v.prevout?.scriptpubkey_address ? accountOf.get(v.prevout.scriptpubkey_address) : undefined;
          if (id != null) touched.add(id);
        }
        for (const o of tx.vout) {
          const id = o.scriptpubkey_address ? accountOf.get(o.scriptpubkey_address) : undefined;
          if (id != null) touched.add(id);
        }
        for (const id of touched) {
          if (!txidsPerAccount.has(id)) txidsPerAccount.set(id, new Set());
          txidsPerAccount.get(id)!.add(tx.txid);
        }
      }
      const scannedAt = now().toISOString();
      const accountUpdates: WalletAccountUpdate[] = scans.map(({ account, scan }) => ({
        id: account.id,
        receiveUsed: scan.receive.used,
        changeUsed: scan.change.used,
        txCount: txidsPerAccount.get(account.id)?.size ?? 0,
        balanceConfirmed: satsToBtc(scan.confirmedSats),
        balanceUnconfirmed: satsToBtc(scan.unconfirmedSats),
        lastScanAt: scannedAt,
      }));

      return {
        transactions: book.transactions,
        balances: [{ currency: "BTC", amount: satsToBtc(book.confirmedSats), hold: satsToBtc(book.pendingSats) }],
        cursor: { tipHeight, syncedAt: scannedAt, source: node.source },
        warnings,
        accounts: accountUpdates,
      };
    },
  };
}

export const bitcoinProvider = makeBitcoinProvider();
