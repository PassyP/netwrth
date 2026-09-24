import type { AssetCategory, Currency, Provider, ScriptType, TxType } from "../db/schema";

export interface Credentials {
  apiKey: string;
  apiSecret: string; // eToro: x-user-key; Kraken: private key (base64)
}

/** Een transactie zoals een provider hem aanlevert, nog zonder asset-id in de app. */
export interface NormalizedTx {
  externalId: string; // uniek binnen de provider (trade-id, positionId, ledger-id)
  type: TxType;
  symbol: string; // BTC, ETH, AAPL — genormaliseerd
  assetName?: string;
  category?: AssetCategory;
  providerAssetId?: string; // Kraken asset-code (XXBT) of eToro instrumentId
  priceSource?: { source: "etoro" | "yahoo" | "kraken" | "manual"; sourceId: string | null };
  quantity: string;
  price: string; // per stuk (buy/sell/transfer) of totaalbedrag (dividend/fee/deposit/withdrawal)
  currency: Currency;
  fee: string;
  executedAt: string; // ISO
  note?: string;
}

export interface BalanceRow {
  currency: string; // EUR, USD, BTC, ...
  amount: string;
  hold?: string;
}

/** Account van een Bitcoin-wallet met ontsleutelde xpub, zoals de orkestrator hem aan de provider geeft. */
export interface WalletAccountWithKey {
  id: number;
  label: string;
  scriptType: ScriptType;
  enabled: boolean;
  xpub: string;
}

/** Weergavevelden die een wallet-sync per account terugmeldt (geen adressen). */
export interface WalletAccountUpdate {
  id: number;
  receiveUsed: number;
  changeUsed: number;
  txCount: number;
  balanceConfirmed: string;
  balanceUnconfirmed: string;
  lastScanAt: string;
}

export interface SyncOutput {
  transactions: NormalizedTx[];
  balances: BalanceRow[];
  cursor: Record<string, unknown>;
  warnings: string[];
  /** Alleen wallet-providers: per account bijgewerkte saldi en tellers. */
  accounts?: WalletAccountUpdate[];
}

export interface TestOutput {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface ConnectionContext {
  id: number;
  provider: Provider;
  accountType: string; // etoro: real | demo
  cursor: Record<string, unknown>;
  /** Laatst bekende koers per symbool in de app (voor snapshot-verkopen bij eToro). */
  lastPrice: (symbol: string) => { price: string; currency: string } | null;
  /** Is deze externe transactie al geboekt? Zo kan een provider dure lookups (koers op tijdstip) overslaan. */
  hasTransaction: (externalId: string) => boolean;
  /** Alleen wallet-providers: de accounts van deze koppeling, met ontsleutelde xpub. */
  accounts?: WalletAccountWithKey[];
  log: (msg: string) => void;
}

export interface ConnectionProvider {
  id: Provider;
  label: string;
  /** "keys": API-key + secret via de wizard; "none": geen credentials (wallet: de accounts komen uit de database). */
  credentials: "keys" | "none";
  keyLabels?: { apiKey: string; apiSecret: string };
  helpUrl: string;
  test(creds: Credentials, ctx: ConnectionContext): Promise<TestOutput>;
  sync(creds: Credentials, ctx: ConnectionContext): Promise<SyncOutput>;
}
