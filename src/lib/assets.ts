import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "./db";
import { ASSET_CATEGORIES, CURRENCIES, PRICE_SOURCES, type Asset, type AssetCategory, type PriceSource } from "./db/schema";
import * as etoro from "./prices/etoro";
import * as yahoo from "./prices/yahoo";
import { krakenMarket, krakenPairIssue, type KrakenPair } from "@/lib/prices/kraken";
import { saveQuote, backfillHistory } from "./prices/quotes";
import { CATEGORY_LABELS } from "@/lib/format";

export const assetInput = z.object({
  symbol: z.string().trim().min(1).max(30).transform((s) => s.toUpperCase()),
  name: z.string().trim().min(1).max(200),
  category: z.enum(ASSET_CATEGORIES),
  currency: z.enum(CURRENCIES),
  priceSource: z.enum(PRICE_SOURCES).default("manual"),
  sourceId: z.string().trim().max(100).nullable().optional(),
  isin: z.string().trim().max(20).nullable().optional(),
  exchange: z.string().trim().max(50).nullable().optional(),
  logoUrl: z.string().trim().max(500).nullable().optional(),
});
export type AssetInput = z.infer<typeof assetInput>;

/** Patch-schema zonder de default op priceSource: een PATCH die de bron weglaat mag hem niet stilzwijgend op "manual" zetten. */
const assetPatch = z.object({ ...assetInput.shape, priceSource: z.enum(PRICE_SOURCES) }).partial();

/** Toevoegen vanuit de UI: optioneel het bestaande crypto-asset dat de gekozen koersbron moet krijgen (zie AssetCandidate.existingAssetId). */
const addAssetInput = assetInput.extend({ existingAssetId: z.number().int().positive().optional() });

/** Bronnen met een echte koersfeed: alleen die kunnen op een bestaand crypto-asset worden gezet. */
const FEED_SOURCES = new Set<PriceSource>(["etoro", "yahoo", "kraken"]);
const APP_CURRENCIES = new Set<string>(CURRENCIES);

export function findAsset(symbol: string, currency: string): Asset | null {
  return getDb().select().from(schema.assets).where(and(eq(schema.assets.symbol, symbol.toUpperCase()), eq(schema.assets.currency, currency as Asset["currency"]))).get() ?? null;
}

/** Identiteitsregel crypto: één asset per symbool, ongeacht valuta (BTC blijft BTC over eToro, Kraken en import). */
export function findCryptoBySymbol(symbol: string): Asset | null {
  const s = symbol.toUpperCase();
  return getDb().select().from(schema.assets).all().find((a) => a.symbol === s && a.category === "crypto") ?? null;
}

/**
 * Niet-crypto-asset op symbool+valuta (met `anyCurrency` desnoods op symbool alleen), zonder ooit een crypto-rij te
 * raken: het aandeel AMP/USD (Ameriprise) is niet de munt AMP, ook al delen ze symbool en valuta. Tussen de
 * niet-crypto-categorieën onderling (aandeel/ETF/grondstof, vaak een gok van de bron) wordt niet onderscheiden.
 */
export function findNonCryptoAsset(symbol: string, currency: string, anyCurrency = false): Asset | null {
  const s = symbol.toUpperCase();
  const rows = getDb().select().from(schema.assets).all().filter((a) => a.symbol === s && a.category !== "crypto");
  return rows.find((a) => a.currency === currency) ?? (anyCurrency ? (rows[0] ?? null) : null);
}

/**
 * Rij op symbool+valuta aan de andere kant van de grens crypto/niet-crypto dan `category` (LINK, AMP, APE, COMP: munt én
 * aandeel). upsertAsset zou die rij stilzwijgend van categorie, bron en naam laten wisselen en de bestaande transacties
 * tegen de verkeerde koers waarderen; sync en import slaan de transactie daarom over met categoryClashMessage.
 */
export function findCategoryClash(symbol: string, currency: string, category: AssetCategory): Asset | null {
  const hit = findAsset(symbol, currency);
  return hit && (hit.category === "crypto") !== (category === "crypto") ? hit : null;
}

export function categoryClashMessage(clash: Asset): string {
  return `Er bestaat al een asset ${clash.symbol}/${clash.currency} in de categorie ${CATEGORY_LABELS[clash.category] ?? clash.category}; kies een ander symbool of bewerk dat asset.`;
}

export function findAssetByIsin(isin: string): Asset | null {
  return getDb().select().from(schema.assets).where(eq(schema.assets.isin, isin)).get() ?? null;
}

/** Maakt een asset aan of werkt een bestaand asset (zelfde symbool+valuta) bij. */
export function upsertAsset(raw: AssetInput): Asset {
  const input = assetInput.parse(raw);
  const db = getDb();
  const existing = findAsset(input.symbol, input.currency);
  if (existing) {
    db.update(schema.assets)
      .set({
        name: input.name,
        category: input.category,
        priceSource: input.priceSource,
        sourceId: input.sourceId ?? existing.sourceId,
        isin: input.isin ?? existing.isin,
        exchange: input.exchange ?? existing.exchange,
        logoUrl: input.logoUrl ?? existing.logoUrl,
      })
      .where(eq(schema.assets.id, existing.id))
      .run();
    return db.select().from(schema.assets).where(eq(schema.assets.id, existing.id)).get()!;
  }
  const inserted = db
    .insert(schema.assets)
    .values({ ...input, sourceId: input.sourceId ?? null, isin: input.isin ?? null, exchange: input.exchange ?? null, logoUrl: input.logoUrl ?? null, createdAt: new Date().toISOString() })
    .returning()
    .get();
  return inserted;
}

/**
 * Asset bijwerken (PATCH): alleen meegegeven velden. Raakt de wijziging een Kraken-bron (bron, paar of symbool), dan wordt
 * het paar gecontroleerd (bestaand, bruikbaar en van dit symbool) en providerIds.kraken aangevuld. Wisselt de bron naar
 * eToro of Yahoo (of verandert het bron-id), dan wordt het id gecontroleerd: het bewerkvenster vult het huidige id voor,
 * zodat een achtergebleven Kraken-paar (XXBTZEUR) of eToro-id anders als NaN in de eToro-batch of als onbekend
 * Yahoo-symbool zou belanden en het asset elke verversronde zou laten mislukken.
 */
export async function updateAsset(id: number, patch: Partial<AssetInput>): Promise<Asset> {
  const db = getDb();
  const current = db.select().from(schema.assets).where(eq(schema.assets.id, id)).get();
  if (!current) throw new Error("Asset niet gevonden.");
  const data: Partial<typeof schema.assets.$inferInsert> = Object.fromEntries(Object.entries(assetPatch.parse(patch)).filter(([, v]) => v !== undefined));
  const source = data.priceSource ?? current.priceSource;
  const nextSourceId = data.sourceId !== undefined ? data.sourceId : current.sourceId;
  const feedChanged = source !== current.priceSource || (data.sourceId !== undefined && (data.sourceId ?? null) !== current.sourceId);
  if (source === "kraken" && (data.priceSource !== undefined || data.sourceId !== undefined || data.symbol !== undefined)) {
    const { pair } = await checkKrakenSource(nextSourceId, data.symbol ?? current.symbol);
    const providerIds = withKrakenProviderId(current.providerIds, pair);
    if (providerIds) data.providerIds = providerIds;
  } else if (source === "etoro" && feedChanged) {
    checkEtoroSource(nextSourceId);
  } else if (source === "yahoo" && feedChanged) {
    checkYahooSource(nextSourceId, current);
    if ((data.category ?? current.category) === "crypto") checkYahooCryptoTicker(nextSourceId!, data.symbol ?? current.symbol);
  }
  if (Object.keys(data).length > 0) db.update(schema.assets).set(data).where(eq(schema.assets.id, id)).run();
  return db.select().from(schema.assets).where(eq(schema.assets.id, id)).get()!;
}

/** eToro-bron: het instrumentId is numeriek. refreshAll stuurt Number(sourceId) in één rates-call voor álle eToro-assets; één NaN kan die hele batch laten mislukken. */
function checkEtoroSource(sourceId: string | null | undefined): string {
  if (!sourceId) throw new Error("eToro als koersbron vereist een numeriek instrumentId (bijv. 100000); kies het asset via zoeken.");
  if (!/^\d+$/.test(sourceId)) throw new Error(`eToro-id ${sourceId} is geen instrumentId (een getal, bijv. 100000); vervang het id van de vorige bron of kies het asset via zoeken.`);
  return sourceId;
}

/** Yahoo-bron: een symbool (AAPL, VWRL.L, BTC-EUR), dus geen achtergebleven eToro-id (cijfers) of het Kraken-paar van de vorige bron. */
function checkYahooSource(sourceId: string | null | undefined, previous: Pick<Asset, "priceSource" | "sourceId">): string {
  if (!sourceId) throw new Error("Yahoo als koersbron vereist een symbool (bijv. AAPL, VWRL.L of BTC-EUR).");
  if (/^\d+$/.test(sourceId)) throw new Error(`Yahoo-symbool ${sourceId} lijkt een eToro-instrumentId; vul het Yahoo-symbool in (bijv. AAPL, VWRL.L of BTC-EUR).`);
  if (previous.priceSource === "kraken" && previous.sourceId && sourceId.toUpperCase() === previous.sourceId.toUpperCase()) {
    throw new Error(`${sourceId} is het Kraken-paar van de vorige bron; vul het Yahoo-symbool in (bijv. BTC-EUR).`);
  }
  return sourceId;
}

/**
 * Yahoo-crypto-ticker (BTC-EUR): dezelfde bescherming als bij een Kraken-paar. De noteringsvaluta moet een app-valuta
 * zijn (ETH-BTC zou de positie op 0 waarderen) en de munt moet bij het symbool horen (SOL-EUR op het BTC-asset zou BTC
 * tegen SOL-koersen waarderen). Een ticker zonder die vorm wordt niet gecontroleerd.
 */
function checkYahooCryptoTicker(sourceId: string, symbol: string): void {
  const t = yahoo.parseCryptoTicker(sourceId);
  if (!t) return;
  if (!APP_CURRENCIES.has(t.quote)) throw new Error(`Yahoo-ticker ${sourceId} noteert in ${t.quote}; kies een ticker in ${CURRENCIES.join(", ")} (bijv. ${t.base}-EUR).`);
  if (t.base !== symbol.toUpperCase()) throw new Error(`Yahoo-ticker ${sourceId} hoort bij ${t.base}, niet bij ${symbol.toUpperCase()}.`);
}

/**
 * Yahoo noteert crypto als <munt>-<valuta>. Komt zo'n ticker als symbool binnen (BTC-USD), dan wordt het symbool de munt
 * (BTC), blijft de ticker het bron-id en verliest de naam de valuta ("Bitcoin USD" → "Bitcoin"). Zonder deze stap
 * ontstond naast het Kraken-/eToro-asset BTC een tweede asset BTC-USD, buiten de identiteitsregel om.
 */
function normalizeYahooCrypto<T extends AssetInput>(input: T): T {
  if (input.category !== "crypto" || input.priceSource !== "yahoo") return input;
  const ticker = yahoo.parseCryptoTicker(input.symbol);
  if (!ticker) return input;
  return { ...input, symbol: ticker.base, name: yahoo.stripQuoteFromName(input.name, ticker.quote), sourceId: input.sourceId ?? input.symbol };
}

function parseProviderIds(json: string | null): Record<string, string> {
  try {
    return json ? (JSON.parse(json) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Kraken-bron van een asset controleren. Het paar moet bestaan (sleutel, altname of wsname), bruikbaar zijn als koersbron
 * (quote in EUR/USD/GBP/CHF en geen valutapaar — anders waardeert de app de positie op 0) en bij het symbool van het
 * asset horen: SOL/EUR op het BTC-asset zou BTC tegen SOL-koersen waarderen en via providerIds.kraken de SOL-trades
 * van een sync op BTC boeken. Een onbekend paar (bijv. een achtergebleven eToro-id na een bronwissel) wordt geweigerd;
 * alleen als Kraken niet bereikbaar is en er nog nooit een pairlijst is opgehaald, is de controle best effort (pair null).
 */
async function checkKrakenSource(sourceId: string | null | undefined, symbol: string): Promise<{ sourceId: string; pair: KrakenPair | null }> {
  if (!sourceId) throw new Error("Kraken als koersbron vereist een paar, bijv. XXBTZEUR of SOLEUR.");
  let pair: KrakenPair | null;
  try {
    pair = await krakenMarket.resolvePair(sourceId);
  } catch {
    return { sourceId, pair: null };
  }
  if (!pair) throw new Error(`Kraken-paar ${sourceId} is onbekend; gebruik de paarsleutel (bijv. XXBTZEUR, SOLEUR) of kies het asset via zoeken.`);
  const issue = krakenPairIssue(pair);
  if (issue) throw new Error(`Kraken-paar ${sourceId}: ${issue}.`);
  if (pair.symbol !== symbol.toUpperCase()) throw new Error(`Kraken-paar ${pair.wsname} hoort bij ${pair.symbol}, niet bij ${symbol.toUpperCase()}.`);
  return { sourceId, pair };
}

/** providerIds-JSON met { kraken: <base-code van het pair> }; null als er niets te wijzigen is (dan blijft het veld ongemoeid). */
function withKrakenProviderId(json: string | null, pair: KrakenPair | null): string | null {
  if (!pair) return null;
  const ids = parseProviderIds(json);
  if (ids.kraken === pair.base) return null;
  return JSON.stringify({ ...ids, kraken: pair.base });
}

/**
 * Asset toevoegen vanuit de UI/API. Voor crypto geldt — voor elke bron — dezelfde identiteitsregel als bij de koppelingen
 * en de import: één crypto-asset per symbool, ongeacht valuta. Bestaat er al zo'n asset (bijv. BTC/USD via eToro, of
 * BTC/EUR uit een CSV-import), dan krijgt dát asset de gekozen koersfeed (bron + bron-id) — valuta, naam en categorie
 * blijven staan, er komt geen tweede BTC bij. Een bron zonder feed (handmatig/geen) op een bestaand crypto-asset wordt
 * geweigerd in plaats van de bestaande feed stilzwijgend te overschrijven. Geeft de client `existingAssetId` mee (de
 * badge "bestaand asset"), dan wordt dat afgedwongen, wat de categorie ook is. Anders gewone upsert; nieuwe crypto-assets
 * worden net als bij de koppelingen en de import in USD genoteerd (de koers bepaalt de waarderingsvaluta), zodat elke
 * latere weg naar hetzelfde symbool hetzelfde asset vindt. Voor Kraken wordt het pair gecontroleerd (bestaand, bruikbaar,
 * van dit symbool) en providerIds.kraken (base-code) aangevuld. Bestaat er op symbool+valuta al een asset in een ándere
 * categorie (het aandeel LINK/USD naast de munt LINK, idem AMP, APE, COMP), dan wordt geweigerd: upsertAsset zou die rij
 * anders stilzwijgend van categorie, bron en naam laten wisselen en de bestaande transacties tegen de verkeerde koers waarderen.
 */
export async function addAssetFromInput(raw: AssetInput & { existingAssetId?: number }): Promise<Asset> {
  const input = normalizeYahooCrypto(addAssetInput.parse(raw));
  const db = getDb();
  let existing: Asset | null = null;
  if (input.existingAssetId != null) {
    existing = db.select().from(schema.assets).where(eq(schema.assets.id, input.existingAssetId)).get() ?? null;
    if (!existing || existing.symbol !== input.symbol || existing.category !== "crypto") throw new Error("Bestaand asset niet gevonden of geen crypto-asset met dit symbool.");
  } else if (input.category === "crypto") {
    existing = findCryptoBySymbol(input.symbol);
  }
  const kraken = input.priceSource === "kraken" ? await checkKrakenSource(input.sourceId, input.symbol) : null;
  if (input.priceSource === "etoro") checkEtoroSource(input.sourceId);
  if (input.priceSource === "yahoo") {
    checkYahooSource(input.sourceId, existing ?? { priceSource: "manual", sourceId: null });
    if ((existing?.category ?? input.category) === "crypto") checkYahooCryptoTicker(input.sourceId!, input.symbol);
  }
  if (existing) {
    if (!FEED_SOURCES.has(input.priceSource) || !input.sourceId) throw new Error(`Er bestaat al een crypto-asset ${existing.symbol}; alleen een koersfeed (Kraken, eToro of Yahoo) kan daarop worden gezet.`);
    const providerIds = withKrakenProviderId(existing.providerIds, kraken?.pair ?? null);
    db.update(schema.assets)
      .set({ priceSource: input.priceSource, sourceId: input.sourceId, ...(providerIds ? { providerIds } : {}) })
      .where(eq(schema.assets.id, existing.id))
      .run();
    return db.select().from(schema.assets).where(eq(schema.assets.id, existing.id)).get()!;
  }
  const currency = input.category === "crypto" ? "USD" : input.currency;
  const clash = findAsset(input.symbol, currency);
  if (clash && clash.category !== input.category) throw new Error(categoryClashMessage(clash));
  const asset = upsertAsset({ ...input, currency }); // assetInput.parse laat existingAssetId weg
  const providerIds = withKrakenProviderId(asset.providerIds, kraken?.pair ?? null);
  if (!providerIds) return asset;
  db.update(schema.assets).set({ providerIds }).where(eq(schema.assets.id, asset.id)).run();
  return db.select().from(schema.assets).where(eq(schema.assets.id, asset.id)).get()!;
}

export interface AssetCandidate {
  source: "local" | "etoro" | "yahoo" | "kraken";
  symbol: string;
  name: string;
  currency: string;
  sourceId: string | null;
  exchange: string | null;
  type: string | null;
  logoUrl: string | null;
  categoryGuess: (typeof ASSET_CATEGORIES)[number];
  assetId?: number;
  /** Crypto-kandidaat (Kraken, eToro of Yahoo): id van het bestaande crypto-asset met dit symbool dat deze bron zou krijgen. */
  existingAssetId?: number;
  /** Het bestaande asset volgt deze bron (zelfde bron-id) al: kiezen selecteert het asset, er verandert niets. */
  current?: boolean;
}

function guessCategory(type: string | null | undefined, symbol: string): (typeof ASSET_CATEGORIES)[number] {
  const t = (type ?? "").toLowerCase();
  if (t.includes("crypto")) return "crypto";
  if (t.includes("etf")) return "etf";
  if (t.includes("commod")) return "commodity";
  if (t.includes("stock") || t.includes("equity")) return "stock";
  if (/^(BTC|ETH|SOL|ADA|XRP|DOGE|LTC|DOT|AVAX|LINK)/.test(symbol)) return "crypto";
  return "stock";
}

/**
 * Zoekt eerst lokaal, dan eToro (als de keys er zijn), dan Yahoo, dan Kraken (publiek, alleen crypto). Elke bron blijft
 * altijd zichtbaar — ook de bron die het bestaande crypto-asset al volgt (gemarkeerd als `current`) — zodat je per asset
 * kunt kiezen welke koers je volgt. Wijst een kandidaat naar een bestaand asset dat niet in de lokale treffers zit (zoeken
 * op "bitcoin" terwijl het asset alleen als BTC bekend is), dan komt dat asset er als lokale rij bij.
 */
export async function searchAssetCandidates(query: string): Promise<{ candidates: AssetCandidate[]; errors: string[] }> {
  const q = query.trim();
  const candidates: AssetCandidate[] = [];
  const errors: string[] = [];
  if (!q) return { candidates, errors };
  const db = getDb();
  const all = db.select().from(schema.assets).all();
  const local = all
    .filter((a) => a.symbol.toLowerCase().includes(q.toLowerCase()) || a.name.toLowerCase().includes(q.toLowerCase()) || (a.isin ?? "").toLowerCase() === q.toLowerCase())
    .slice(0, 10);
  for (const a of local) {
    candidates.push({ source: "local", symbol: a.symbol, name: a.name, currency: a.currency, sourceId: a.sourceId, exchange: a.exchange, type: a.category, logoUrl: a.logoUrl, categoryGuess: a.category, assetId: a.id });
  }
  if (etoro.etoroConfigured()) {
    try {
      const r = await etoro.searchInstruments(q, 10);
      for (const i of r) {
        candidates.push({
          source: "etoro",
          symbol: i.symbol,
          name: i.displayName,
          currency: "USD",
          sourceId: String(i.instrumentId),
          exchange: i.exchangeId != null ? `eToro exchange ${i.exchangeId}` : null,
          type: i.type,
          logoUrl: i.image?.uri ?? null,
          categoryGuess: guessCategory(i.type, i.symbol),
        });
      }
    } catch (e) {
      errors.push(`eToro: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    const r = await yahoo.search(q);
    for (const i of r) {
      const categoryGuess = guessCategory(i.type, i.symbol);
      // Yahoo noteert crypto als munt-valuta (BTC-USD, BTC-EUR): het symbool in de app is de munt, zodat de identiteitsregel
      // ook voor deze bron geldt; de ticker blijft het bron-id. Een ticker in een andere munt (ETH-BTC) is geen bruikbare
      // koersbron (de waardering kent alleen de app-valuta's) en valt af.
      const crypto = categoryGuess === "crypto" ? yahoo.parseCryptoTicker(i.symbol) : null;
      if (crypto && !APP_CURRENCIES.has(crypto.quote)) continue;
      candidates.push({
        source: "yahoo",
        symbol: crypto?.base ?? i.symbol,
        name: crypto ? yahoo.stripQuoteFromName(i.name, crypto.quote) : i.name,
        currency: crypto?.quote ?? "USD",
        sourceId: i.symbol,
        exchange: i.exchange,
        type: i.type,
        logoUrl: null,
        categoryGuess,
      });
    }
  } catch (e) {
    errors.push(`Yahoo: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Kraken: één kandidaat per munt in de voorkeursvaluta; naam en logo komen van het bestaande asset of van een eerdere
  // crypto-kandidaat met hetzelfde symbool. Bestaat er al een crypto-asset met dit symbool, dan wijst de kandidaat daarnaar.
  // Kraken kent geen namen (zoeken op "bitcoin" vindt bij Kraken niets): daarom wordt ook het pair opgezocht van elke munt
  // die de lokale lijst of de andere bronnen voor deze zoekterm vonden, zodat de Kraken-optie altijd naast de rest staat.
  try {
    const r = await krakenMarket.search(q);
    const found = new Set(r.map((i) => i.symbol));
    const bySymbol = [...new Set(candidates.filter((c) => c.categoryGuess === "crypto").map((c) => c.symbol))].filter((sym) => !found.has(sym)).slice(0, 10);
    for (const sym of bySymbol) {
      const hit = (await krakenMarket.search(sym)).find((i) => i.symbol === sym);
      if (hit) r.push(hit);
    }
    for (const i of r) {
      const existing = all.find((a) => a.symbol === i.symbol && a.category === "crypto");
      const twins = candidates.filter((c) => c.source !== "kraken" && c.source !== "local" && c.symbol === i.symbol && c.categoryGuess === "crypto");
      candidates.push({
        source: "kraken",
        symbol: i.symbol,
        name: (existing && existing.name !== existing.symbol ? existing.name : twins[0]?.name) ?? i.symbol,
        currency: i.currency,
        sourceId: i.pairKey,
        exchange: "Kraken",
        type: "crypto",
        logoUrl: existing?.logoUrl ?? twins.find((c) => c.logoUrl)?.logoUrl ?? null,
        categoryGuess: "crypto",
      });
    }
  } catch (e) {
    errors.push(`Kraken: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Identiteitsregel voor alle bronnen: een crypto-kandidaat (Kraken, eToro of Yahoo) wijst naar het bestaande crypto-asset
  // met dat symbool (bronwissel, geen tweede asset). Volgt dat asset precies deze bron al, dan blijft de kandidaat staan als
  // "huidige bron": zo zie je per asset alle koersbronnen naast elkaar.
  const localIds = new Set(candidates.filter((c) => c.source === "local").map((c) => c.assetId));
  const extraLocal: AssetCandidate[] = [];
  for (const c of candidates) {
    if (c.source === "local" || c.categoryGuess !== "crypto") continue;
    const existing = all.find((a) => a.symbol === c.symbol && a.category === "crypto");
    if (!existing) continue;
    c.existingAssetId = existing.id;
    if (existing.priceSource === c.source && existing.sourceId === c.sourceId) c.current = true;
    if (!localIds.has(existing.id)) {
      localIds.add(existing.id);
      extraLocal.push({ source: "local", symbol: existing.symbol, name: existing.name, currency: existing.currency, sourceId: existing.sourceId, exchange: existing.exchange, type: existing.category, logoUrl: existing.logoUrl, categoryGuess: existing.category, assetId: existing.id });
    }
  }
  candidates.splice(local.length, 0, ...extraLocal); // achter de gewone lokale treffers, in volgorde van de bronnen
  return { candidates, errors };
}

/**
 * eToro noteert alle koersen in USD (de kandidaten en de eToro-sync gaan daar ook van uit). De koersrij krijgt daarom
 * altijd USD, óók als asset.currency na een feed-upgrade nog EUR is (legacy BTC/EUR): anders wordt een USD-koers als
 * EUR gewaardeerd en zit de waardering er ~8% naast.
 */
const ETORO_QUOTE_CURRENCY = "USD";

/** Koers van een asset eenmalig ophalen na aanmaken/wijzigen van de bron (best effort). */
export async function primeAssetPrice(asset: Asset): Promise<void> {
  try {
    if (asset.priceSource === "yahoo" && asset.sourceId) {
      const q = await yahoo.getQuote(asset.sourceId);
      saveQuote(asset.id, new Date().toISOString(), q.price, q.currency, "yahoo", q.previousClose);
      // Niet-crypto volgt de noteringsvaluta van Yahoo, mits die een app-valuta is (EUR/USD/CHF/GBP): SEK, DKK, JPY …
      // horen niet in assets.currency (transactieformulier en alerts leiden hun valuta daarvan af en weigeren dan), de
      // koersrij zelf houdt wel de echte valuta. Crypto blijft in USD genoteerd (één asset per symbool; de koers bepaalt
      // de waarderingsvaluta), anders wordt XYZ/USD via een Yahoo-EUR-ticker XYZ/EUR. Botst de nieuwe valuta met een
      // bestaande rij (unieke index symbool+valuta), dan blijft de valuta staan en loopt de backfill gewoon door.
      if (asset.category !== "crypto" && q.currency !== asset.currency) {
        if (!(CURRENCIES as readonly string[]).includes(q.currency)) {
          console.warn(`Valuta van ${asset.symbol} niet bijgewerkt naar ${q.currency}: geen app-valuta (${CURRENCIES.join(", ")}); het asset blijft in ${asset.currency}.`);
        } else {
          try {
            getDb().update(schema.assets).set({ currency: q.currency as Asset["currency"] }).where(eq(schema.assets.id, asset.id)).run();
          } catch (e) {
            console.warn(`Valuta van ${asset.symbol} niet bijgewerkt naar ${q.currency}:`, e instanceof Error ? e.message : e);
          }
        }
      }
    } else if (asset.priceSource === "etoro" && asset.sourceId) {
      const r = await etoro.getRates([Number(asset.sourceId)]);
      if (r[0]) saveQuote(asset.id, new Date().toISOString(), (r[0].bid + r[0].ask) / 2, ETORO_QUOTE_CURRENCY, "etoro");
    } else if (asset.priceSource === "kraken" && asset.sourceId) {
      // koers in de quote-valuta van het pair; asset.currency blijft staan (waardering rekent met de valuta van de quote)
      const q = (await krakenMarket.getQuotes([asset.sourceId])).get(asset.sourceId);
      if (q) saveQuote(asset.id, new Date().toISOString(), q.price, q.currency, "kraken", q.previousClose);
    }
    await backfillHistory(asset, 365);
  } catch (e) {
    console.warn(`Koers ophalen voor ${asset.symbol} mislukt:`, e instanceof Error ? e.message : e);
  }
}

export const valuationInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  value: z.string().regex(/^-?\d+(\.\d+)?$/),
  currency: z.enum(CURRENCIES),
  debt: z.string().regex(/^-?\d+(\.\d+)?$/).default("0"),
  note: z.string().max(500).nullable().optional(),
});

/** Handmatige waardering (vastgoed) — schrijft ook een handmatige koers voor die dag. */
export function addValuation(assetId: number, raw: z.infer<typeof valuationInput>) {
  const input = valuationInput.parse(raw);
  const db = getDb();
  db.insert(schema.valuations).values({ assetId, date: input.date, value: input.value, currency: input.currency, debt: input.debt, note: input.note ?? null }).run();
  saveQuote(assetId, `${input.date}T12:00:00.000Z`, input.value, input.currency, "manual");
}

export function setManualPrice(assetId: number, price: string, currency: string, date?: string) {
  const ts = date ? `${date}T12:00:00.000Z` : new Date().toISOString();
  saveQuote(assetId, ts, price, currency, "manual");
}
