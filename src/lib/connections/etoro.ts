import crypto from "node:crypto";
import Decimal from "decimal.js";
import type { AssetCategory } from "../db/schema";
import type { ConnectionProvider, Credentials, NormalizedTx, SyncOutput, TestOutput } from "./types";

/**
 * eToro Public API — portfolio-endpoints (zelfde keys als de koersen; rechten Read).
 *   GET /api/v1/trading/info/portfolio        (demo: /api/v1/trading/info/demo/portfolio)
 *   GET /api/v1/trading/info/real/pnl         (demo: /api/v1/trading/info/demo/pnl)
 *   GET /api/v1/market-data/instruments?instrumentIds=…  (naam, symbool, type)
 * eToro geeft een momentopname van open posities; verkopen leiden we af uit posities die verdwijnen.
 */
const BASE = process.env.ETORO_BASE_URL || "https://public-api.etoro.com";
type FetchImpl = typeof fetch;

export interface EtoroPosition {
  positionId: string;
  instrumentId: number;
  openRate: number;
  units: number;
  amount: number; // ingelegd bedrag (USD)
  openDateTime: string;
  isBuy: boolean;
  leverage: number;
  mirrorId?: number | null;
  unrealizedPnL?: number | null;
}

interface RawObj {
  [k: string]: unknown;
}

function num(o: RawObj, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number") return v;
    if (typeof v === "string" && v !== "" && !isNaN(Number(v))) return Number(v);
  }
  return null;
}
function str(o: RawObj, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** Vindt alle positie-objecten in een eToro-antwoord, ongeacht de exacte vorm (tolerant voor veldnamen/casing). */
export function extractPositions(raw: unknown): EtoroPosition[] {
  const out: EtoroPosition[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown, mirrorId: number | null) => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n, mirrorId);
      return;
    }
    if (!node || typeof node !== "object") return;
    const o = node as RawObj;
    const pid = str(o, "positionId", "positionID", "PositionID", "id");
    const iid = num(o, "instrumentId", "instrumentID", "InstrumentID");
    const units = num(o, "units", "Units");
    const openRate = num(o, "openRate", "OpenRate", "openPrice");
    if (pid && iid != null && units != null && openRate != null) {
      if (!seen.has(pid)) {
        seen.add(pid);
        out.push({
          positionId: pid,
          instrumentId: iid,
          openRate,
          units,
          amount: num(o, "amount", "Amount") ?? units * openRate,
          openDateTime: str(o, "openDateTime", "OpenDateTime", "openDate") ?? new Date().toISOString(),
          isBuy: (o.isBuy ?? o.IsBuy ?? true) as boolean,
          leverage: num(o, "leverage", "Leverage") ?? 1,
          mirrorId,
          unrealizedPnL: (() => {
            const u = o.unrealizedPnL ?? o.unrealizedPnl;
            if (typeof u === "number") return u;
            if (u && typeof u === "object") return num(u as RawObj, "pnL", "pnl", "PnL");
            return null;
          })(),
        });
      }
      return;
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === "mirrors" && Array.isArray(v)) {
        for (const m of v as RawObj[]) visit(m, num(m, "mirrorId", "mirrorID", "MirrorID") ?? -1);
      } else if (v && typeof v === "object") visit(v, mirrorId);
    }
  };
  visit(raw, null);
  return out;
}

export interface EtoroClientOptions {
  fetchImpl?: FetchImpl;
}

export class EtoroPortfolioClient {
  private fetchImpl: FetchImpl;
  private typeNames: Map<number, string> | null = null;
  constructor(private creds: Credentials, private accountType: "real" | "demo", opts: EtoroClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async get<T>(path: string, params?: Record<string, string>, attempt = 0): Promise<T> {
    const url = new URL(path, BASE);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url, {
      headers: { accept: "application/json", "x-api-key": this.creds.apiKey, "x-user-key": this.creds.apiSecret, "x-request-id": crypto.randomUUID() },
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return this.get<T>(path, params, attempt + 1);
    }
    if (res.status === 401 || res.status === 403) throw new Error(`eToro ${res.status}: keys ongeldig of onvoldoende rechten (Read nodig).`);
    if (!res.ok) throw new Error(`eToro ${res.status} bij ${path}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  portfolioPath(): string {
    return this.accountType === "demo" ? "/api/v1/trading/info/demo/portfolio" : "/api/v1/trading/info/portfolio";
  }
  pnlPath(): string {
    return `/api/v1/trading/info/${this.accountType === "demo" ? "demo" : "real"}/pnl`;
  }

  async portfolio(): Promise<{ positions: EtoroPosition[]; raw: unknown }> {
    const raw = await this.get<unknown>(this.portfolioPath());
    return { positions: extractPositions(raw), raw };
  }

  async pnl(): Promise<{ credit: number | null; positions: EtoroPosition[]; raw: unknown }> {
    const raw = await this.get<RawObj>(this.pnlPath());
    const credit = num(raw, "credit", "Credit", "availableCash");
    return { credit, positions: extractPositions(raw), raw };
  }

  /** instrumentTypeID → omschrijving, éénmalig opgehaald (valt terug op een vaste tabel). */
  async instrumentTypes(): Promise<Map<number, string>> {
    if (this.typeNames) return this.typeNames;
    const m = new Map<number, string>();
    try {
      const r = await this.get<{ instrumentTypes?: RawObj[] } | RawObj[]>("/api/v1/market-data/instrument-types");
      const list = Array.isArray(r) ? r : (r.instrumentTypes ?? []);
      for (const t of list as RawObj[]) {
        const id = num(t, "instrumentTypeID", "instrumentTypeId");
        const name = str(t, "instrumentTypeDescription", "description", "name");
        if (id != null && name) m.set(id, name);
      }
    } catch {
      /* terugvallen op de vaste tabel */
    }
    this.typeNames = m;
    return m;
  }

  /** Naam, symbool en type per instrumentId (display data + instrument-types voor de categorie). */
  async instruments(ids: number[]): Promise<Map<number, { symbol: string; name: string; type: string | null; logoUrl: string | null }>> {
    const out = new Map<number, { symbol: string; name: string; type: string | null; logoUrl: string | null }>();
    const types = await this.instrumentTypes();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      try {
        const r = await this.get<{ instrumentDisplayDatas?: RawObj[] }>("/api/v1/market-data/instruments", { instrumentIds: chunk.join(",") });
        for (const d of r.instrumentDisplayDatas ?? []) {
          const id = num(d, "instrumentID", "instrumentId");
          if (id == null) continue;
          const images = Array.isArray(d.images) ? (d.images as RawObj[]) : [];
          out.set(id, {
            symbol: (str(d, "symbolFull", "symbol") ?? `ETORO${id}`).toUpperCase(),
            name: str(d, "instrumentDisplayName", "displayName") ?? `eToro ${id}`,
            type: (() => {
              const tid = num(d, "instrumentTypeID", "instrumentTypeId");
              return tid == null ? null : types.get(tid) ?? typeNameFromId(tid);
            })(),
            logoUrl: (images.find((im) => num(im, "width") === 50 || num(im, "width") === 35) ?? images[0])?.uri as string | null ?? null,
          });
        }
      } catch {
        /* per instrument terugvallen op zoeken */
      }
    }
    return out;
  }
}

/** Vaste terugvaltabel voor instrumentTypeID (vermoedelijke waarden; de echte lijst komt van /market-data/instrument-types). */
function typeNameFromId(id: number | null): string | null {
  switch (id) {
    case 1:
      return "currencies";
    case 2:
      return "commodities";
    case 4:
      return "indices";
    case 5:
      return "stocks";
    case 6:
      return "etf";
    case 10:
      return "crypto";
    default:
      return null;
  }
}

export function categoryFromType(type: string | null, symbol: string): AssetCategory {
  const t = (type ?? "").toLowerCase();
  if (t.includes("crypto")) return "crypto";
  if (t.includes("etf")) return "etf";
  if (t.includes("commod")) return "commodity";
  if (t.includes("stock")) return "stock";
  if (/^(BTC|ETH|SOL|ADA|XRP|DOGE|LTC|DOT|AVAX|LINK|BNB|MATIC|TRX|XLM)$/.test(symbol)) return "crypto";
  return "stock";
}

type Snapshot = Record<string, { units: number; instrumentId: number; openRate: number }>;

export function makeEtoroProvider(opts: EtoroClientOptions = {}): ConnectionProvider {
  return {
    id: "etoro",
  credentials: "keys",
    label: "eToro",
    keyLabels: { apiKey: "x-api-key (Public API Key)", apiSecret: "x-user-key (User Key)" },
    helpUrl: "https://api-portal.etoro.com/",
    async test(creds, ctx): Promise<TestOutput> {
      const client = new EtoroPortfolioClient(creds, ctx.accountType === "demo" ? "demo" : "real", opts);
      try {
        const p = await client.portfolio();
        let credit: number | null = null;
        try {
          credit = (await client.pnl()).credit;
        } catch {
          /* pnl optioneel */
        }
        return { ok: true, message: `Verbinding OK: ${p.positions.length} open posities${credit != null ? `, kas $${credit.toFixed(2)}` : ""}`, details: { positions: p.positions.length, credit } };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
    async sync(creds, ctx): Promise<SyncOutput> {
      const client = new EtoroPortfolioClient(creds, ctx.accountType === "demo" ? "demo" : "real", opts);
      const warnings: string[] = [];
      const { positions } = await client.portfolio();
      let credit: number | null = null;
      try {
        credit = (await client.pnl()).credit;
      } catch (e) {
        warnings.push(`PnL/kas niet gelezen: ${e instanceof Error ? e.message : String(e)}`);
      }
      const prev = (ctx.cursor.positions ?? {}) as Snapshot;
      const ids = [...new Set(positions.map((p) => p.instrumentId).concat(Object.values(prev).map((p) => p.instrumentId)))];
      const info = await client.instruments(ids);
      const meta = (instrumentId: number) => {
        const m = info.get(instrumentId);
        const symbol = m?.symbol ?? `ETORO${instrumentId}`;
        return { symbol, name: m?.name ?? symbol, category: categoryFromType(m?.type ?? null, symbol), logoUrl: m?.logoUrl ?? null };
      };
      const txs: NormalizedTx[] = [];
      const now = new Date().toISOString();

      // nieuwe posities en deelverkopen
      const nextSnapshot: Snapshot = {};
      for (const p of positions) {
        nextSnapshot[p.positionId] = { units: p.units, instrumentId: p.instrumentId, openRate: p.openRate };
        const m = meta(p.instrumentId);
        const before = prev[p.positionId];
        if (!before) {
          txs.push({
            externalId: `etoro:pos:${p.positionId}`,
            type: p.isBuy ? "buy" : "sell",
            symbol: m.symbol,
            assetName: m.name,
            category: m.category,
            providerAssetId: String(p.instrumentId),
            priceSource: { source: "etoro", sourceId: String(p.instrumentId) },
            quantity: new Decimal(p.units).toFixed(8),
            price: new Decimal(p.openRate).toFixed(6),
            currency: "USD",
            fee: "0",
            executedAt: new Date(p.openDateTime).toISOString(),
            note: `eToro positie ${p.positionId}${p.leverage > 1 ? ` (hefboom ×${p.leverage})` : ""}${p.mirrorId ? ` via copy ${p.mirrorId}` : ""}`,
          });
          if (!p.isBuy) warnings.push(`Positie ${p.positionId} (${m.symbol}) is een short/CFD-verkoop; de app toont hem als verkoop.`);
        } else if (before.units > p.units + 1e-9) {
          const sold = new Decimal(before.units).minus(p.units);
          const last = ctx.lastPrice(m.symbol);
          txs.push({
            externalId: `etoro:partial:${p.positionId}:${now.slice(0, 10)}`,
            type: "sell",
            symbol: m.symbol,
            category: m.category,
            providerAssetId: String(p.instrumentId),
            priceSource: { source: "etoro", sourceId: String(p.instrumentId) },
            quantity: sold.toFixed(8),
            price: last ? last.price : new Decimal(p.openRate).toFixed(6),
            currency: "USD",
            fee: "0",
            executedAt: now,
            note: `eToro deelverkoop positie ${p.positionId} (koers = laatst bekend${last ? "" : ", openingsprijs"})`,
          });
          if (!last) warnings.push(`Deelverkoop ${p.positionId}: geen koers bekend, openingsprijs gebruikt.`);
        }
      }
      // verdwenen posities = gesloten
      for (const [pid, before] of Object.entries(prev)) {
        if (nextSnapshot[pid]) continue;
        const m = meta(before.instrumentId);
        const last = ctx.lastPrice(m.symbol);
        txs.push({
          externalId: `etoro:close:${pid}`,
          type: "sell",
          symbol: m.symbol,
          category: m.category,
          providerAssetId: String(before.instrumentId),
          priceSource: { source: "etoro", sourceId: String(before.instrumentId) },
          quantity: new Decimal(before.units).toFixed(8),
          price: last ? last.price : new Decimal(before.openRate).toFixed(6),
          currency: "USD",
          fee: "0",
          executedAt: now,
          note: `eToro positie ${pid} gesloten (koers = laatst bekend${last ? "" : ", openingsprijs"}); controleer de werkelijke sluitingskoers in eToro`,
        });
        if (!last) warnings.push(`Gesloten positie ${pid}: geen koers bekend, openingsprijs gebruikt.`);
      }

      const balances = credit != null ? [{ currency: "USD", amount: new Decimal(credit).toFixed(2) }] : [];
      return { transactions: txs, balances, cursor: { positions: nextSnapshot, syncedAt: now }, warnings };
    },
  };
}

export const etoroProvider = makeEtoroProvider();
