import { describe, it, expect } from "vitest";
import { krakenPairIssue, makeKrakenMarket } from "./kraken";

const NOW = new Date("2026-09-22T10:00:00Z");
const TODAY_SEC = Math.floor(Date.UTC(2026, 8, 22) / 1000);

/** Nep-Kraken (publieke endpoints): AssetPairs, Assets, Ticker en OHLC; registreert alle aanroepen. */
function fakeKraken(opts: { extraPairs?: number } = {}) {
  const pair = (altname: string, wsname: string, base: string, quote: string, extra: Record<string, unknown> = {}) => ({ altname, wsname, aclass_base: "currency", base, aclass_quote: "currency", quote, status: "online", pair_decimals: 1, lot_decimals: 8, ...extra });
  const pairs: Record<string, Record<string, unknown>> = {
    XXBTZEUR: pair("XBTEUR", "XBT/EUR", "XXBT", "ZEUR"),
    XXBTZUSD: pair("XBTUSD", "XBT/USD", "XXBT", "ZUSD"),
    XETHZEUR: pair("ETHEUR", "ETH/EUR", "XETH", "ZEUR"),
    XETHXXBT: pair("ETHXBT", "ETH/XBT", "XETH", "XXBT"), // crypto-quoted: wel in pairs(), niet in search()
    SOLEUR: pair("SOLEUR", "SOL/EUR", "SOL", "ZEUR"),
    SOLUSD: pair("SOLUSD", "SOL/USD", "SOL", "ZUSD"),
    ETHFIEUR: pair("ETHFIEUR", "ETHFI/EUR", "ETHFI", "ZEUR"),
    LUNAEUR: pair("LUNAEUR", "LUNA/EUR", "LUNA", "ZEUR", { status: "cancel_only" }), // gepauzeerd: wel in pairs() en te waarderen, niet in search()
    "XXBTZEUR.d": pair("XBTEUR.d", "XBT/EUR", "XXBT", "ZEUR"), // dark pool
    AAPLxEUR: pair("AAPLxEUR", "AAPLx/EUR", "AAPLx", "ZEUR", { aclass_base: "tokenized_asset" }),
    XBTUSDT: pair("XBTUSDT", "XBT/USDT", "XXBT", "USDT"), // stablecoin-quoted: wel in pairs(), niet bruikbaar als bron
    USDTZUSD: pair("USDTUSD", "USDT/USD", "USDT", "ZUSD"), // stablecoin als base: gewoon crypto
    ZEURZUSD: pair("EURUSD", "EUR/USD", "ZEUR", "ZUSD"), // valutaparen: geen crypto
    ZGBPZUSD: pair("GBPUSD", "GBP/USD", "ZGBP", "ZUSD"),
    USDCHF: pair("USDCHF", "USD/CHF", "USD", "CHF"),
  };
  for (let i = 0; i < (opts.extraPairs ?? 0); i++) pairs[`C${i}EUR`] = pair(`C${i}EUR`, `C${i}/EUR`, `C${i}`, "ZEUR");
  const tickers: Record<string, { c: string; o: string }> = {
    XXBTZEUR: { c: "60000.5", o: "59000.0" },
    XXBTZUSD: { c: "70000.0", o: "0" },
    XETHZEUR: { c: "3000.0", o: "2950.0" },
    SOLEUR: { c: "150.25", o: "149.0" },
    SOLUSD: { c: "175.0", o: "174.0" },
    LUNAEUR: { c: "0.12", o: "0.11" }, // Kraken blijft een gepauzeerd pair gewoon quoteren
  };
  const assets = { XXBT: { altname: "XBT", aclass: "currency", decimals: 10, status: "enabled" }, XETH: { altname: "ETH" }, ZEUR: { altname: "EUR" }, ZUSD: { altname: "USD" }, ZGBP: { altname: "GBP" }, SOL: { altname: "SOL" }, ETHFI: { altname: "ETHFI" }, LUNA: { altname: "LUNA" }, USDT: { altname: "USDT" } };

  const calls: { path: string; params: URLSearchParams }[] = [];
  const state = { failPairs: false, emptyPairs: false };
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = new URL(typeof input === "string" ? input : (input as URL).toString());
    calls.push({ path: url.pathname, params: url.searchParams });
    const json = (result: unknown, error: string[] = []) => new Response(JSON.stringify({ error, result }), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/0/public/AssetPairs") {
      if (state.failPairs) return new Response("<html>502 Bad Gateway</html>", { status: 502 });
      return json(state.emptyPairs ? {} : pairs); // leeg: geldig JSON zonder error, maar zonder één pair
    }
    if (url.pathname === "/0/public/Assets") return json(assets);
    if (url.pathname === "/0/public/Ticker") {
      const result: Record<string, unknown> = {};
      for (const p of (url.searchParams.get("pair") ?? "").split(",")) {
        const t = tickers[p] ?? (pairs[p] ? { c: "1.5", o: "1.4" } : null);
        if (!t) return json({}, ["EQuery:Unknown asset pair"]);
        result[p] = { a: [t.c, "1", "1.000"], b: [t.c, "1", "1.000"], c: [t.c, "0.10000000"], v: ["10", "20"], p: [t.c, t.c], t: [5, 10], l: [t.o, t.o], h: [t.c, t.c], o: t.o };
      }
      return json(result);
    }
    if (url.pathname === "/0/public/OHLC") {
      const p = url.searchParams.get("pair") ?? "";
      if (p === "XETHZEUR") return json({}, ["EQuery:Unknown asset pair"]);
      const candle = (t: number, close: string) => [t, close, close, close, close, close, "1.0", 1];
      return json({ [p]: [candle(TODAY_SEC - 2 * 86400, "58000.0"), candle(TODAY_SEC - 86400, "59000.0"), candle(TODAY_SEC, "60000.0")], last: TODAY_SEC });
    }
    return json({}, ["EGeneral:Unknown endpoint"]);
  }) as typeof fetch;
  return { fetchImpl, calls, state };
}

const noSleep = async () => undefined;
/** Laat een achtergrondverversing van de pairlijst (alleen microtaken met de nep-fetch) afronden. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("Kraken koersbron: pairs en zoeken", () => {
  it("pairs() laat dark pool en tokenized pairs weg, houdt gepauzeerde pairs en normaliseert symbool en valuta", async () => {
    const { fetchImpl, calls } = fakeKraken();
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => NOW });
    const pairs = await market.pairs();
    expect([...pairs.keys()].sort()).toEqual(["ETHFIEUR", "LUNAEUR", "SOLEUR", "SOLUSD", "USDCHF", "USDTZUSD", "XBTUSDT", "XETHXXBT", "XETHZEUR", "XXBTZEUR", "XXBTZUSD", "ZEURZUSD", "ZGBPZUSD"]);
    expect(pairs.get("XXBTZEUR")).toEqual({ key: "XXBTZEUR", altname: "XBTEUR", wsname: "XBT/EUR", base: "XXBT", quote: "ZEUR", symbol: "BTC", currency: "EUR", status: "online" });
    expect(pairs.get("LUNAEUR")).toMatchObject({ symbol: "LUNA", currency: "EUR", status: "cancel_only" }); // status blijft zichtbaar, maar is geen filter
    expect(pairs.get("SOLUSD")).toMatchObject({ symbol: "SOL", currency: "USD" });
    expect(pairs.get("XETHXXBT")).toMatchObject({ symbol: "ETH", currency: "BTC" });
    expect(pairs.get("ZGBPZUSD")).toMatchObject({ symbol: "GBP", currency: "USD" });
    expect(calls.map((c) => c.path).sort()).toEqual(["/0/public/AssetPairs", "/0/public/Assets"]);
  });

  it("krakenPairIssue: alleen app-valuta als quote en geen valutaparen", async () => {
    const { fetchImpl } = fakeKraken();
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => NOW });
    expect(krakenPairIssue((await market.resolvePair("XXBTZEUR"))!)).toBeNull();
    expect(krakenPairIssue((await market.resolvePair("USDTUSD"))!)).toBeNull(); // stablecoin als base is gewoon crypto
    expect(krakenPairIssue((await market.resolvePair("XBTUSDT"))!)).toBe("XBT/USDT noteert in USDT; kies een paar in EUR, USD, CHF, GBP");
    expect(krakenPairIssue((await market.resolvePair("ETHXBT"))!)).toMatch(/noteert in BTC/);
    expect(krakenPairIssue((await market.resolvePair("EURUSD"))!)).toBe("EUR/USD is een valutapaar, geen crypto");
    expect(krakenPairIssue((await market.resolvePair("USDCHF"))!)).toMatch(/valutapaar/);
  });

  it("resolvePair vindt op sleutel, altname en wsname, hoofdletterongevoelig", async () => {
    const { fetchImpl } = fakeKraken();
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => NOW });
    expect((await market.resolvePair("XXBTZEUR"))?.key).toBe("XXBTZEUR");
    expect((await market.resolvePair("XBTEUR"))?.key).toBe("XXBTZEUR");
    expect((await market.resolvePair("xbt/eur"))?.key).toBe("XXBTZEUR");
    expect((await market.resolvePair("xxbtzeur"))?.key).toBe("XXBTZEUR");
    expect((await market.resolvePair("SOL/USD"))?.key).toBe("SOLUSD");
    expect(await market.resolvePair("NOPE")).toBeNull();
  });

  it("search geeft één resultaat per asset met voorkeur EUR > USD", async () => {
    const { fetchImpl } = fakeKraken();
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => NOW });
    expect(await market.search("btc")).toEqual([{ symbol: "BTC", pairKey: "XXBTZEUR", wsname: "XBT/EUR", currency: "EUR", baseCode: "XXBT" }]);
    expect(await market.search("sol")).toEqual([{ symbol: "SOL", pairKey: "SOLEUR", wsname: "SOL/EUR", currency: "EUR", baseCode: "SOL" }]);
    // via wsname/base-code (Kraken noemt BTC "XBT")
    expect((await market.search("xbt")).map((r) => r.pairKey)).toEqual(["XXBTZEUR"]);
    // expliciet gevraagde valuta wint van de voorkeur
    expect((await market.search("btcusd")).map((r) => r.pairKey)).toEqual(["XXBTZUSD"]);
    expect((await market.search("xbt/usd")).map((r) => r.pairKey)).toEqual(["XXBTZUSD"]);
    // exacte match eerst, dan prefix
    expect((await market.search("ETH")).map((r) => `${r.symbol}/${r.pairKey}`)).toEqual(["ETH/XETHZEUR", "ETHFI/ETHFIEUR"]);
  });

  it("search slaat gepauzeerde, dark pool, tokenized en crypto-quoted pairs over en eist 2 tekens", async () => {
    const { fetchImpl } = fakeKraken();
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => NOW });
    expect(await market.search("luna")).toEqual([]);
    expect(await market.search("lunaeur")).toEqual([]); // ook als exact pair gevraagd: geen nieuwe bron op een gepauzeerd pair
    expect(await market.search("aapl")).toEqual([]);
    expect(await market.search("b")).toEqual([]);
    expect(await market.search("  ")).toEqual([]);
    const pairs = await market.pairs();
    expect([...pairs.keys()].some((k) => k.includes("."))).toBe(false);
  });

  it("een gepauzeerd pair (cancel_only) blijft via resolvePair, getQuotes en getDailyHistory werken: bestaande bronnen vallen niet uit", async () => {
    const { fetchImpl, calls } = fakeKraken();
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => NOW });
    const pair = await market.resolvePair("LUNA/EUR");
    expect(pair).toMatchObject({ key: "LUNAEUR", symbol: "LUNA", currency: "EUR", status: "cancel_only" });
    expect(krakenPairIssue(pair!)).toBeNull(); // status hoort niet in krakenPairIssue: checkKrakenSource mag een gepauzeerd pair niet weigeren
    const q = await market.getQuotes(["LUNAEUR", "XXBTZEUR"]);
    expect(q.get("LUNAEUR")).toMatchObject({ pairKey: "LUNAEUR", price: 0.12, previousClose: 0.11, currency: "EUR" });
    expect(q.get("XXBTZEUR")).toMatchObject({ price: 60000.5 });
    expect(calls.filter((c) => c.path === "/0/public/Ticker")[0].params.get("pair")).toBe("LUNAEUR,XXBTZEUR");
    const h = await market.getDailyHistory("LUNAEUR", 30);
    expect(h.currency).toBe("EUR");
    expect(h.candles.map((c) => c.date)).toEqual(["2026-09-20", "2026-09-21"]);
    expect(calls.filter((c) => c.path === "/0/public/OHLC")[0].params.get("pair")).toBe("LUNAEUR");
  });

  it("search laat valutaparen en stablecoin-gequoteerde pairs weg, maar stablecoins als munt niet", async () => {
    const { fetchImpl } = fakeKraken();
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => NOW });
    expect(await market.search("eur")).toEqual([]);
    expect(await market.search("gbp")).toEqual([]);
    expect(await market.search("eurusd")).toEqual([]); // ook als exact pair gevraagd
    expect((await market.search("us")).map((r) => r.symbol)).toEqual(["USDT"]); // geen "USD" uit USD/CHF
    expect(await market.search("usdt")).toEqual([{ symbol: "USDT", pairKey: "USDTZUSD", wsname: "USDT/USD", currency: "USD", baseCode: "USDT" }]);
    expect(await market.search("xbtusdt")).toEqual([]); // XBT/USDT is onbruikbaar, ook als exact pair gevraagd
    expect((await market.search("btc")).map((r) => r.pairKey)).toEqual(["XXBTZEUR"]); // de munt zelf blijft via EUR vindbaar
  });

  it("search levert maximaal 10 resultaten, alfabetisch binnen een tier", async () => {
    const { fetchImpl } = fakeKraken({ extraPairs: 120 });
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => NOW });
    const r = await market.search("c1"); // C1 exact, daarna C10..C19 en C100..C119 als prefix
    expect(r.length).toBe(10);
    expect(r[0].symbol).toBe("C1");
    expect(r.slice(1).map((x) => x.symbol)).toEqual(["C10", "C100", "C101", "C102", "C103", "C104", "C105", "C106", "C107"]);
  });
});

describe("Kraken koersbron: koersen en historie", () => {
  it("getQuotes mapt koers, previousClose en valuta; altname resolveert; onbekend pair ontbreekt", async () => {
    const { fetchImpl, calls } = fakeKraken();
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => NOW });
    const q = await market.getQuotes(["XXBTZEUR", "SOLEUR", "XBTUSD", "NOPE"]);
    expect(q.size).toBe(3);
    expect(q.get("XXBTZEUR")).toEqual({ pairKey: "XXBTZEUR", price: 60000.5, previousClose: 59000, currency: "EUR", time: NOW.toISOString() });
    expect(q.get("SOLEUR")).toMatchObject({ pairKey: "SOLEUR", price: 150.25, previousClose: 149, currency: "EUR" });
    expect(q.get("XBTUSD")).toMatchObject({ pairKey: "XXBTZUSD", price: 70000, previousClose: null, currency: "USD" }); // o = "0" → geen previousClose
    expect(q.has("NOPE")).toBe(false);
    const ticker = calls.filter((c) => c.path === "/0/public/Ticker");
    expect(ticker.length).toBe(1);
    expect(ticker[0].params.get("pair")).toBe("XXBTZEUR,SOLEUR,XXBTZUSD");
  });

  it("getQuotes vraagt onbruikbare pairs niet op; getDailyHistory weigert ze", async () => {
    const { fetchImpl, calls } = fakeKraken();
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => NOW });
    const q = await market.getQuotes(["XXBTZEUR", "XBTUSDT", "ETHXBT", "EURUSD"]);
    expect([...q.keys()]).toEqual(["XXBTZEUR"]);
    const ticker = calls.filter((c) => c.path === "/0/public/Ticker");
    expect(ticker).toHaveLength(1);
    expect(ticker[0].params.get("pair")).toBe("XXBTZEUR");
    await expect(market.getDailyHistory("XBTUSDT", 10)).rejects.toThrow("Kraken: XBT/USDT noteert in USDT; kies een paar in EUR, USD, CHF, GBP");
    await expect(market.getDailyHistory("ETHXBT", 10)).rejects.toThrow(/noteert in BTC/);
    await expect(market.getDailyHistory("EURUSD", 10)).rejects.toThrow("Kraken: EUR/USD is een valutapaar, geen crypto");
    expect(calls.filter((c) => c.path === "/0/public/OHLC")).toHaveLength(0);
  });

  it("getQuotes deelt op in blokken van 50 en geeft een lege map zonder aanroepen bij een lege lijst", async () => {
    const { fetchImpl, calls } = fakeKraken({ extraPairs: 120 });
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => NOW });
    expect((await market.getQuotes([])).size).toBe(0);
    expect(calls.length).toBe(0);
    const keys = Array.from({ length: 120 }, (_, i) => `C${i}EUR`);
    const q = await market.getQuotes(keys);
    expect(q.size).toBe(120);
    expect(q.get("C7EUR")).toMatchObject({ price: 1.5, previousClose: 1.4, currency: "EUR" });
    const ticker = calls.filter((c) => c.path === "/0/public/Ticker");
    expect(ticker.map((c) => (c.params.get("pair") ?? "").split(",").length)).toEqual([50, 50, 20]);
  });

  it("getDailyHistory geeft oplopende dagcandles zonder vandaag, met valuta en since", async () => {
    const { fetchImpl, calls } = fakeKraken();
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => NOW });
    const h = await market.getDailyHistory("XBTEUR", 30);
    expect(h.currency).toBe("EUR");
    expect(h.candles).toEqual([
      { date: "2026-09-20", close: 58000 },
      { date: "2026-09-21", close: 59000 },
    ]);
    const ohlc = calls.filter((c) => c.path === "/0/public/OHLC");
    expect(ohlc[0].params.get("pair")).toBe("XXBTZEUR");
    expect(ohlc[0].params.get("interval")).toBe("1440");
    expect(ohlc[0].params.get("since")).toBe(String(Math.floor(NOW.getTime() / 1000) - 30 * 86400));
  });

  it("getDailyHistory begrenst since op 720 dagen", async () => {
    const { fetchImpl, calls } = fakeKraken();
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => NOW });
    await market.getDailyHistory("XXBTZEUR", 5000);
    const ohlc = calls.filter((c) => c.path === "/0/public/OHLC");
    expect(ohlc[0].params.get("since")).toBe(String(Math.floor(NOW.getTime() / 1000) - 720 * 86400));
  });

  it("geeft Kraken-fouten door als Error('Kraken: …')", async () => {
    const { fetchImpl } = fakeKraken();
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => NOW });
    await expect(market.getDailyHistory("XETHZEUR", 10)).rejects.toThrow("Kraken: EQuery:Unknown asset pair");
    await expect(market.getDailyHistory("NOPE", 10)).rejects.toThrow("Kraken: onbekend pair NOPE");
  });

  it("meldt een HTTP-fout zonder JSON begrijpelijk", async () => {
    const { fetchImpl, state } = fakeKraken();
    state.failPairs = true;
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => NOW });
    await expect(market.pairs()).rejects.toThrow("Kraken AssetPairs: HTTP 502");
  });
});

describe("Kraken koersbron: cache en rate limit", () => {
  it("pairs() cachet binnen de TTL, geeft daarna meteen de oude lijst terug en ververst op de achtergrond; bij een fout blijft de oude lijst en wacht een nieuwe poging het herkansingsvenster af", async () => {
    const { fetchImpl, calls, state } = fakeKraken();
    let now = NOW;
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => now, pairsRetryMs: 60_000 });
    const assetPairsCalls = () => calls.filter((c) => c.path === "/0/public/AssetPairs").length;
    await market.pairs();
    await market.pairs();
    await market.resolvePair("XBTEUR");
    expect(assetPairsCalls()).toBe(1);
    now = new Date(NOW.getTime() + 3_600_000 - 1);
    await market.pairs();
    expect(assetPairsCalls()).toBe(1);
    // verlopen: de aanroeper krijgt de oude lijst zonder op Kraken te wachten (stale-while-revalidate)
    now = new Date(NOW.getTime() + 3_600_000);
    let blocked = true;
    const slowFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const res = await fetchImpl(input, init);
      while (blocked) await flush();
      return res;
    }) as typeof fetch;
    const slow = makeKrakenMarket({ fetchImpl: slowFetch, sleep: noSleep, now: () => now });
    blocked = false;
    await slow.pairs(); // eerste lijst
    blocked = true;
    now = new Date(now.getTime() + 3_600_000);
    expect((await slow.pairs()).get("XXBTZEUR")?.symbol).toBe("BTC"); // komt terug terwijl de verversing nog hangt
    expect((await slow.resolvePair("SOLEUR"))?.symbol).toBe("SOL");
    blocked = false;
    await flush();
    // de verversing van de eerste instantie is op de achtergrond gedaan; binnen de nieuwe TTL geen nieuwe aanroep
    expect((await market.pairs()).get("XXBTZEUR")?.symbol).toBe("BTC");
    await flush();
    expect(assetPairsCalls()).toBe(4); // 1 + 2 (slow) + 1 achtergrond
    await market.pairs();
    await flush();
    expect(assetPairsCalls()).toBe(4);
    // na de TTL faalt Kraken: de oude lijst blijft bruikbaar, en een nieuwe poging volgt pas na het herkansingsvenster
    now = new Date(NOW.getTime() + 3 * 3_600_000);
    state.failPairs = true;
    expect((await market.pairs()).get("XXBTZEUR")?.symbol).toBe("BTC");
    await flush();
    expect(assetPairsCalls()).toBe(5);
    await market.pairs();
    await market.search("btc");
    await flush();
    expect(assetPairsCalls()).toBe(5); // binnen het venster geen nieuwe poging
    now = new Date(now.getTime() + 60_000);
    expect((await market.pairs()).get("XXBTZEUR")?.symbol).toBe("BTC");
    await flush();
    expect(assetPairsCalls()).toBe(6);
    // Kraken is terug: de volgende poging (na het venster) slaagt en herstelt de TTL
    state.failPairs = false;
    now = new Date(now.getTime() + 60_000);
    await market.pairs();
    await flush();
    expect(assetPairsCalls()).toBe(7);
    now = new Date(now.getTime() + 3_600_000 - 1);
    await market.pairs();
    await flush();
    expect(assetPairsCalls()).toBe(7);
  });

  it("zonder cache geeft een mislukte ophaalactie een fout en wordt binnen het herkansingsvenster niet opnieuw geprobeerd", async () => {
    const { fetchImpl, calls, state } = fakeKraken();
    state.failPairs = true;
    let now = NOW;
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => now, pairsRetryMs: 30_000 });
    const assetPairsCalls = () => calls.filter((c) => c.path === "/0/public/AssetPairs").length;
    await expect(market.pairs()).rejects.toThrow("Kraken AssetPairs: HTTP 502");
    await expect(market.search("btc")).rejects.toThrow("Kraken AssetPairs: HTTP 502");
    await expect(market.getQuotes(["XXBTZEUR"])).rejects.toThrow("Kraken AssetPairs: HTTP 502");
    expect(assetPairsCalls()).toBe(1);
    state.failPairs = false;
    now = new Date(NOW.getTime() + 30_000 - 1);
    await expect(market.pairs()).rejects.toThrow("Kraken AssetPairs: HTTP 502");
    expect(assetPairsCalls()).toBe(1);
    now = new Date(NOW.getTime() + 30_000);
    expect((await market.pairs()).get("XXBTZEUR")?.symbol).toBe("BTC");
    expect(assetPairsCalls()).toBe(2);
  });

  it("een lege pairlijst na een goede vervangt de oude index niet en telt als mislukking met herkansingsvenster", async () => {
    const { fetchImpl, calls, state } = fakeKraken();
    let now = NOW;
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => now, pairsRetryMs: 60_000 });
    const assetPairsCalls = () => calls.filter((c) => c.path === "/0/public/AssetPairs").length;
    const first = await market.pairs();
    expect(first.size).toBeGreaterThan(0);
    // na de TTL antwoordt Kraken met een lege lijst: de oude index blijft (zelfde map), ook na de achtergrondverversing
    now = new Date(NOW.getTime() + 3_600_000);
    state.emptyPairs = true;
    expect(await market.pairs()).toBe(first);
    await flush();
    expect(assetPairsCalls()).toBe(2);
    const second = await market.pairs();
    expect(second).toBe(first);
    expect(second.get("XXBTZEUR")?.symbol).toBe("BTC");
    expect((await market.resolvePair("XBTEUR"))?.key).toBe("XXBTZEUR");
    expect((await market.getQuotes(["XXBTZEUR"])).get("XXBTZEUR")?.price).toBe(60000.5);
    await flush();
    expect(assetPairsCalls()).toBe(2); // binnen het herkansingsvenster geen nieuwe poging
    now = new Date(now.getTime() + 60_000);
    expect(await market.pairs()).toBe(first);
    await flush();
    expect(assetPairsCalls()).toBe(3);
    // Kraken levert weer een lijst: de volgende poging vervangt de index en herstelt de TTL
    state.emptyPairs = false;
    now = new Date(now.getTime() + 60_000);
    await market.pairs();
    await flush();
    expect(assetPairsCalls()).toBe(4);
    const fresh = await market.pairs();
    expect(fresh).not.toBe(first);
    expect(fresh.get("XXBTZEUR")?.symbol).toBe("BTC");
    now = new Date(now.getTime() + 3_600_000 - 1);
    await market.pairs();
    await flush();
    expect(assetPairsCalls()).toBe(4);
  });

  it("zonder cache is een lege pairlijst een fout ('Kraken: lege pairlijst') die binnen het herkansingsvenster niet opnieuw wordt geprobeerd", async () => {
    const { fetchImpl, calls, state } = fakeKraken();
    state.emptyPairs = true;
    let now = NOW;
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => now, pairsRetryMs: 30_000 });
    const assetPairsCalls = () => calls.filter((c) => c.path === "/0/public/AssetPairs").length;
    await expect(market.pairs()).rejects.toThrow("Kraken: lege pairlijst");
    await expect(market.search("btc")).rejects.toThrow("Kraken: lege pairlijst");
    expect(assetPairsCalls()).toBe(1);
    state.emptyPairs = false;
    now = new Date(NOW.getTime() + 30_000);
    expect((await market.pairs()).get("XXBTZEUR")?.symbol).toBe("BTC");
    expect(assetPairsCalls()).toBe(2);
  });

  it("respecteert een eigen pairsTtlMs en dedupliceert gelijktijdige ophaalacties", async () => {
    const { fetchImpl, calls } = fakeKraken();
    let now = NOW;
    const market = makeKrakenMarket({ fetchImpl, sleep: noSleep, now: () => now, pairsTtlMs: 1000 });
    await Promise.all([market.pairs(), market.search("btc"), market.getQuotes(["SOLEUR"])]);
    expect(calls.filter((c) => c.path === "/0/public/AssetPairs").length).toBe(1);
    now = new Date(NOW.getTime() + 1000);
    await Promise.all([market.pairs(), market.resolvePair("SOLEUR")]); // beide krijgen de oude lijst; één achtergrondverversing
    await flush();
    expect(calls.filter((c) => c.path === "/0/public/AssetPairs").length).toBe(2);
  });

  it("de limiter laat 3 verzoeken direct door en laat daarna wachten (1/s)", async () => {
    const { fetchImpl, calls } = fakeKraken();
    const sleeps: number[] = [];
    const market = makeKrakenMarket({ fetchImpl, sleep: async (ms) => void sleeps.push(ms), now: () => NOW });
    for (let i = 0; i < 5; i++) await market.getDailyHistory("XXBTZEUR", 7);
    expect(calls.length).toBe(7); // AssetPairs + Assets + 5× OHLC
    expect(sleeps).toEqual([1000, 2000, 3000, 4000]); // vaste klok: de wachtrij loopt op per verzoek
  });

  it("de limiter vult bij met de klok", async () => {
    const { fetchImpl } = fakeKraken();
    const sleeps: number[] = [];
    let now = NOW;
    const market = makeKrakenMarket({ fetchImpl, sleep: async (ms) => void sleeps.push(ms), now: () => now });
    await market.pairs(); // 2 verzoeken
    await market.getDailyHistory("XXBTZEUR", 7); // 3e verzoek: nog binnen de burst
    expect(sleeps).toEqual([]);
    now = new Date(NOW.getTime() + 2000);
    await market.getDailyHistory("XXBTZEUR", 7); // 2 s later: 2 tokens bijgevuld
    await market.getDailyHistory("XXBTZEUR", 7);
    expect(sleeps).toEqual([]);
    await market.getDailyHistory("XXBTZEUR", 7);
    expect(sleeps).toEqual([1000]);
  });
});
