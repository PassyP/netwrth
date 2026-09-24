import { describe, it, expect } from "vitest";
import { krakenSign, normalizeKrakenAsset, KrakenClient, normalizeKraken, krakenBalances, makeKrakenProvider, krakenPublicClient, krakenPriceHints, type KrakenPairInfo } from "./kraken";

// Testvector uit de Kraken-documentatie (Authentication → API-Sign example)
const SECRET = "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg=="; // gitleaks:allow (publieke testvector)

describe("Kraken signing en assetnamen", () => {
  it("API-Sign komt overeen met het voorbeeld uit de documentatie", () => {
    const sig = krakenSign("/0/private/AddOrder", "1616492376594", "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25", SECRET);
    expect(sig).toBe("4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==");
  });

  it("normaliseert Kraken-codes naar symbolen", () => {
    expect(normalizeKrakenAsset("XXBT")).toBe("BTC");
    expect(normalizeKrakenAsset("XXBT", "XBT")).toBe("BTC");
    expect(normalizeKrakenAsset("ZEUR")).toBe("EUR");
    expect(normalizeKrakenAsset("ZEUR", "EUR")).toBe("EUR");
    expect(normalizeKrakenAsset("ETH2.S", "ETH2.S")).toBe("ETH");
    expect(normalizeKrakenAsset("DOT.S", "DOT.S")).toBe("DOT");
    expect(normalizeKrakenAsset("XETH", "ETH")).toBe("ETH");
    expect(normalizeKrakenAsset("SOL", "SOL")).toBe("SOL");
    expect(normalizeKrakenAsset("XXDG", "XDG")).toBe("DOGE");
  });
});

/** Nep-Kraken: antwoorden per endpoint, met paginering voor TradesHistory. */
function fakeKraken() {
  const trades: Record<string, unknown>[] = [];
  for (let i = 0; i < 60; i++) {
    trades.push({
      id: `T${String(i).padStart(5, "0")}-AAAAA-BBBBBB`,
      ordertxid: `O${i}`,
      pair: i % 2 === 0 ? "XXBTZEUR" : "XETHZEUR",
      time: 1700000000 + i * 3600,
      type: i % 5 === 0 ? "sell" : "buy",
      ordertype: "market",
      price: i % 2 === 0 ? "30000.0" : "2000.0",
      cost: i % 2 === 0 ? "300.0" : "200.0",
      fee: "0.5",
      vol: i % 2 === 0 ? "0.01" : "0.1",
      margin: "0.0",
      misc: "",
    });
  }
  // één crypto-naar-crypto trade: ETH gekocht met BTC
  trades.push({ id: "TCROSS-AAAAA-BBBBBB", ordertxid: "OX", pair: "XETHXXBT", time: 1700300000, type: "buy", ordertype: "limit", price: "0.06", cost: "0.006", fee: "0.00001", vol: "0.1", margin: "0", misc: "" });
  // kosten in de basismunt: 1 BTC gekocht, 0,002 BTC kosten → er komt 0,998 BTC binnen, er gaat 30.000 EUR af
  trades.push({ id: "TFEEBS-AAAAA-BBBBBB", ordertxid: "OF", pair: "XXBTZEUR", time: 1700310000, type: "buy", ordertype: "market", price: "30000.0", cost: "30000.0", fee: "60.0", vol: "1.0", margin: "0", misc: "" });
  // pair dat Kraken heeft geschrapt: staat niet in AssetPairs en is niet uit de naam te splitsen
  trades.push({ id: "TGONE0-AAAAA-BBBBBB", ordertxid: "OG", pair: "OLDUSDC", time: 1700320000, type: "buy", ordertype: "market", price: "1.0", cost: "1000.0", fee: "2.0", vol: "1000.0", margin: "0", misc: "" });
  trades.sort((a, b) => (b.time as number) - (a.time as number)); // Kraken geeft nieuwste eerst

  const ledger: Record<string, Record<string, unknown>> = {
    L00001: { refid: "D1", time: 1699990000, type: "deposit", subtype: "", aclass: "currency", asset: "ZEUR", amount: "1000.00", fee: "0.00", balance: "1000.00" },
    L00002: { refid: "D2", time: 1699995000, type: "deposit", subtype: "", aclass: "currency", asset: "XXBT", amount: "0.05000000", fee: "0", balance: "0.05" },
    L00003: { refid: "S1", time: 1700400000, type: "staking", subtype: "", aclass: "currency", asset: "DOT.S", amount: "0.25000000", fee: "0", balance: "10.25" },
    L00004: { refid: "E1", time: 1700400100, type: "earn", subtype: "reward", aclass: "currency", asset: "SOL", amount: "0.01000000", fee: "0", balance: "1.01" },
    L00005: { refid: "E2", time: 1700400200, type: "earn", subtype: "allocation", aclass: "currency", asset: "SOL", amount: "-1.00000000", fee: "0", balance: "0.01" },
    L00006: { refid: "W1", time: 1700500000, type: "withdrawal", subtype: "", aclass: "currency", asset: "XXBT", amount: "-0.02000000", fee: "0.00002000", balance: "0.03" },
    L00007: { refid: "W2", time: 1700500100, type: "withdrawal", subtype: "", aclass: "currency", asset: "ZEUR", amount: "-100.00", fee: "0.09", balance: "0" },
    L00008: { refid: "IB1", time: 1700600000, type: "spend", subtype: "", aclass: "currency", asset: "ZEUR", amount: "-52.00", fee: "2.00", balance: "0" },
    L00009: { refid: "IB1", time: 1700600000, type: "receive", subtype: "", aclass: "currency", asset: "SOL", amount: "1.00000000", fee: "0", balance: "1" },
    // airdrop en correctie: geen trade, wel een saldomutatie
    L00020: { refid: "TR1", time: 1700700000, type: "transfer", subtype: "", aclass: "currency", asset: "BCH", amount: "0.00002500", fee: "0", balance: "0.00002500" },
    L00021: { refid: "AD1", time: 1700700100, type: "adjustment", subtype: "", aclass: "currency", asset: "XETH", amount: "-0.00000100", fee: "0", balance: "0" },
    // interne verplaatsing spot → staking: twee regels op dezelfde munt, samen nul
    L00022: { refid: "TR2", time: 1700700200, type: "transfer", subtype: "stakingfromspot", aclass: "currency", asset: "DOT", amount: "-1.00000000", fee: "0", balance: "0" },
    L00023: { refid: "TR2", time: 1700700200, type: "transfer", subtype: "stakingfromspot", aclass: "currency", asset: "DOT.S", amount: "1.00000000", fee: "0", balance: "1" },
  };
  // grootboekregels bij elke trade, zoals Kraken die boekt (amount en fee apart). T00002 krijgt er expres géén:
  // dan moet de normalisatie terugvallen op de trade zelf.
  let seq = 100;
  const addTradeLedger = (refid: string, time: number, asset: string, amount: string, fee: string) => {
    ledger[`LT${seq++}`] = { refid, time, type: "trade", subtype: "", aclass: "currency", asset, amount, fee, balance: "0" };
  };
  for (const t of trades) {
    const id = t.id as string;
    const time = t.time as number;
    if (id === "T00002-AAAAA-BBBBBB") continue;
    if (id === "TCROSS-AAAAA-BBBBBB") {
      addTradeLedger(id, time, "XETH", "0.1", "0"); // kosten in BTC (quote)
      addTradeLedger(id, time, "XXBT", "-0.006", "0.00001");
    } else if (id === "TFEEBS-AAAAA-BBBBBB") {
      addTradeLedger(id, time, "XXBT", "1.0", "0.002"); // kosten in de basismunt
      addTradeLedger(id, time, "ZEUR", "-30000.0", "0");
    } else if (id === "TGONE0-AAAAA-BBBBBB") {
      addTradeLedger(id, time, "OLD", "1000.0", "2.0");
      addTradeLedger(id, time, "USDC", "-1000.0", "0");
    } else {
      const sell = t.type === "sell";
      const baseAsset = (t.pair as string) === "XXBTZEUR" ? "XXBT" : "XETH";
      addTradeLedger(id, time, baseAsset, `${sell ? "-" : ""}${t.vol}`, "0");
      addTradeLedger(id, time, "ZEUR", `${sell ? "" : "-"}${t.cost}`, t.fee as string);
    }
  }

  const calls: { path: string; body?: string; headers?: Record<string, string> }[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : (input as URL).toString());
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ path: url.pathname, body, headers: init?.headers as Record<string, string> });
    const params = new URLSearchParams(body ?? "");
    const json = (result: unknown, error: string[] = []) => new Response(JSON.stringify({ error, result }), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/0/public/Assets") return json({ XXBT: { altname: "XBT" }, XETH: { altname: "ETH" }, ZEUR: { altname: "EUR" }, "DOT.S": { altname: "DOT.S" }, DOT: { altname: "DOT" }, SOL: { altname: "SOL" }, ZUSD: { altname: "USD" }, USDC: { altname: "USDC" }, OLD: { altname: "OLD" }, BCH: { altname: "BCH" } });
    if (url.pathname === "/0/public/AssetPairs") {
      return json({
        XXBTZEUR: { altname: "XBTEUR", wsname: "XBT/EUR", aclass_base: "currency", base: "XXBT", aclass_quote: "currency", quote: "ZEUR", status: "online" },
        XXBTZUSD: { altname: "XBTUSD", wsname: "XBT/USD", aclass_base: "currency", base: "XXBT", aclass_quote: "currency", quote: "ZUSD", status: "online" },
        "XXBTZEUR.d": { altname: "XBTEUR.d", wsname: "XBT/EUR", aclass_base: "currency", base: "XXBT", aclass_quote: "currency", quote: "ZEUR", status: "online" }, // dark pool
        XETHZEUR: { altname: "ETHEUR", wsname: "ETH/EUR", aclass_base: "currency", base: "XETH", aclass_quote: "currency", quote: "ZEUR", status: "online" },
        XETHXXBT: { altname: "ETHXBT", wsname: "ETH/XBT", aclass_base: "currency", base: "XETH", aclass_quote: "currency", quote: "XXBT", status: "online" },
        SOLEUR: { altname: "SOLEUR", wsname: "SOL/EUR", aclass_base: "currency", base: "SOL", aclass_quote: "currency", quote: "ZEUR", status: "online" },
        USDCEUR: { altname: "USDCEUR", wsname: "USDC/EUR", aclass_base: "currency", base: "USDC", aclass_quote: "currency", quote: "ZEUR", status: "online" },
        BCHEUR: { altname: "BCHEUR", wsname: "BCH/EUR", aclass_base: "currency", base: "BCH", aclass_quote: "currency", quote: "ZEUR", status: "online" },
        DOTUSDT: { altname: "DOTUSDT", wsname: "DOT/USDT", aclass_base: "currency", base: "DOT", aclass_quote: "currency", quote: "USDT", status: "online" }, // quote is geen app-valuta → geen koersbron
      });
    }
    if (url.pathname === "/0/public/OHLC") {
      // dagslot per paar, rond de gevraagde dag (de app vraagt vanaf drie dagen ervoor)
      const close = { XBTEUR: "30000", ETHEUR: "1800", USDCEUR: "0.95", BCHEUR: "200", SOLEUR: "50" }[url.searchParams.get("pair") ?? ""];
      if (!close) return json(null, ["EQuery:Unknown asset pair"]);
      const day = (Number(url.searchParams.get("since")) + 3 * 86400) - ((Number(url.searchParams.get("since")) + 3 * 86400) % 86400);
      return json({ [url.searchParams.get("pair")!]: [[day - 86400, close, close, close, close, "0", "0", 1], [day, close, close, close, close, "0", "0", 1]], last: day });
    }
    if (url.pathname === "/0/private/Balance") return json({ XXBT: "0.1234", ZEUR: "512.10", "DOT.S": "10.25", DOT: "1.0", SOL: "0.0000000001" });
    if (url.pathname === "/0/private/TradesHistory") {
      const start = Number(params.get("start") ?? 0);
      const ofs = Number(params.get("ofs") ?? 0);
      const filtered = trades.filter((t) => (t.time as number) > start);
      const page = filtered.slice(ofs, ofs + 50);
      const map: Record<string, unknown> = {};
      for (const t of page) {
        const { id, ...rest } = t;
        map[id as string] = rest;
      }
      return json({ count: filtered.length, trades: map });
    }
    if (url.pathname === "/0/private/Ledgers") {
      const start = Number(params.get("start") ?? 0);
      const entries = Object.entries(ledger).filter(([, l]) => (l.time as number) > start);
      return json({ count: entries.length, ledger: Object.fromEntries(entries) });
    }
    return json(null, ["EGeneral:Unknown endpoint"]);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("Kraken-client en normalisatie", () => {
  const creds = { apiKey: "TESTKEY000000000", apiSecret: SECRET };

  it("pagineert TradesHistory, zet headers en een stijgende nonce", async () => {
    const { fetchImpl, calls } = fakeKraken();
    const client = new KrakenClient(creds, { fetchImpl, sleep: async () => undefined });
    const trades = await client.tradesSince(0);
    expect(trades.length).toBe(63);
    expect(trades[0].time).toBeLessThan(trades[trades.length - 1].time);
    const tradeCalls = calls.filter((c) => c.path === "/0/private/TradesHistory");
    expect(tradeCalls.length).toBe(2); // 50 + 13
    const nonces = tradeCalls.map((c) => Number(new URLSearchParams(c.body).get("nonce")));
    expect(nonces[1]).toBeGreaterThan(nonces[0]);
    expect(tradeCalls[0].headers?.["API-Key"]).toBe(creds.apiKey);
    expect(tradeCalls[0].headers?.["API-Sign"]).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("normaliseert trades en ledger naar transacties van de app", async () => {
    const { fetchImpl } = fakeKraken();
    const client = new KrakenClient(creds, { fetchImpl, sleep: async () => undefined });
    const warnings: string[] = [];
    const txs = await normalizeKraken(client, await client.tradesSince(0), await client.ledgerSince(0), warnings);
    const byType = (t: string) => txs.filter((x) => x.type === t);
    // 60 fiat-trades + 1 met kosten in de basismunt + 2 × 2 poten (crypto-naar-crypto en het geschrapte pair) + instant buy
    expect(byType("buy").length + byType("sell").length).toBe(60 + 1 + 4 + 1);
    const btc = txs.find((x) => x.externalId === "kraken:trade:T00000-AAAAA-BBBBBB")!;
    expect(btc.symbol).toBe("BTC");
    expect(btc.type).toBe("sell");
    expect(btc.currency).toBe("EUR");
    expect(btc.quantity).toBe("0.0100000000");
    expect(Number(btc.price)).toBeCloseTo(30000, 8);
    expect(btc.fee).toBe("0.5");
    // koersbron: Kraken-paar in EUR (boven USD, dark pool overgeslagen), provider-id blijft de basiscode
    expect(btc.providerAssetId).toBe("XXBT");
    expect(btc.priceSource).toEqual({ source: "kraken", sourceId: "XXBTZEUR" });
    const eth = txs.find((x) => x.externalId === "kraken:trade:T00001-AAAAA-BBBBBB")!;
    expect(eth.priceSource).toEqual({ source: "kraken", sourceId: "XETHZEUR" });
    // crypto-naar-crypto: ETH gekocht tegen 0,06 BTC bij BTC/EUR 30.000 → 1.800 EUR per ETH; BTC-poot 0,006 BTC + kosten
    const cross = txs.find((x) => x.externalId === "kraken:trade:TCROSS-AAAAA-BBBBBB:base")!;
    expect(cross.symbol).toBe("ETH");
    expect(Number(cross.price)).toBeCloseTo(1800, 6);
    const crossQuote = txs.find((x) => x.externalId === "kraken:trade:TCROSS-AAAAA-BBBBBB:quote")!;
    expect(crossQuote.symbol).toBe("BTC");
    expect(crossQuote.type).toBe("sell");
    expect(crossQuote.quantity).toBe("0.0060100000"); // 0,006 BTC + 0,00001 BTC kosten gingen er werkelijk af
    expect(cross.priceSource).toEqual({ source: "kraken", sourceId: "XETHZEUR" });
    expect(crossQuote.priceSource).toEqual({ source: "kraken", sourceId: "XXBTZEUR" });
    // de twee poten zijn samen kasneutraal: wat de ene poot kost, brengt de andere op
    expect(Number(cross.quantity) * Number(cross.price) + Number(cross.fee)).toBeCloseTo(Number(crossQuote.quantity) * Number(crossQuote.price), 8);
    // ledger
    expect(byType("deposit")[0]).toMatchObject({ currency: "EUR", price: "1000.00000000" });
    const tin = txs.find((x) => x.externalId === "kraken:ledger:L00002")!;
    expect(tin.type).toBe("transfer_in");
    expect(tin.symbol).toBe("BTC");
    expect(tin.quantity).toBe("0.0500000000");
    expect(tin.priceSource).toEqual({ source: "kraken", sourceId: "XXBTZEUR" });
    const tout = txs.find((x) => x.externalId === "kraken:ledger:L00006")!;
    expect(tout.type).toBe("transfer_out");
    expect(tout.quantity).toBe("0.0200200000"); // incl. netwerkkosten
    expect(tout.priceSource).toEqual({ source: "kraken", sourceId: "XXBTZEUR" });
    expect(byType("withdrawal")[0]).toMatchObject({ currency: "EUR", price: "100.00000000", fee: "0.09000000" });
    const staking = byType("staking");
    expect(staking.map((s) => s.symbol).sort()).toEqual(["DOT", "SOL"]);
    // SOL heeft een online EUR-paar; DOT.S alleen een cancel_only-paar → terugvallen op Yahoo
    expect(staking.find((s) => s.symbol === "SOL")!.priceSource).toEqual({ source: "kraken", sourceId: "SOLEUR" });
    expect(staking.find((s) => s.symbol === "DOT")!).toMatchObject({ providerAssetId: "DOT.S", priceSource: { source: "yahoo", sourceId: "DOT-EUR" } });
    const instant = txs.find((x) => x.externalId === "kraken:ledger:IB1")!;
    expect(instant.type).toBe("buy");
    expect(instant.symbol).toBe("SOL");
    expect(instant.price).toBe("52.0000000000"); // er ging 52 + 2 kosten af, dus kostprijs 54 voor 1 SOL
    expect(instant.fee).toBe("2.00000000");
    expect(instant.priceSource).toEqual({ source: "kraken", sourceId: "SOLEUR" });
    // trade-ledgerregels (al uit TradesHistory) en earn-allocaties worden overgeslagen
    expect(warnings.some((w) => w.includes("earn:allocation"))).toBe(true);
  });

  it("boekt het aantal dat Kraken werkelijk bijschreef: kosten in de basismunt gaan van het aantal af", async () => {
    const { fetchImpl } = fakeKraken();
    const client = new KrakenClient(creds, { fetchImpl, sleep: async () => undefined });
    const txs = await normalizeKraken(client, await client.tradesSince(0), await client.ledgerSince(0), []);
    // 1 BTC gekocht met 0,002 BTC kosten: er kwam 0,998 BTC binnen en er ging 30.000 EUR af
    const t = txs.find((x) => x.externalId === "kraken:trade:TFEEBS-AAAAA-BBBBBB")!;
    expect(t.quantity).toBe("0.9980000000");
    expect(Number(t.quantity) * Number(t.price) + Number(t.fee)).toBeCloseTo(30000, 6);
  });

  it("herkent een geschrapt pair aan de grootboekregels in plaats van aan de naam", async () => {
    const { fetchImpl } = fakeKraken();
    const client = new KrakenClient(creds, { fetchImpl, sleep: async () => undefined });
    const warnings: string[] = [];
    const txs = await normalizeKraken(client, await client.tradesSince(0), await client.ledgerSince(0), warnings);
    // OLDUSDC staat niet in AssetPairs en is niet uit de naam te splitsen; het grootboek geeft OLD en USDC
    const base = txs.find((x) => x.externalId === "kraken:trade:TGONE0-AAAAA-BBBBBB:base")!;
    const quote = txs.find((x) => x.externalId === "kraken:trade:TGONE0-AAAAA-BBBBBB:quote")!;
    expect(base).toMatchObject({ symbol: "OLD", type: "buy", quantity: "998.0000000000" }); // 1000 − 2 kosten
    expect(quote).toMatchObject({ symbol: "USDC", type: "sell", quantity: "1000.0000000000" });
    expect(warnings.some((w) => w.includes("OLDUSDC") && w.includes("overgeslagen"))).toBe(false);
  });

  it("boekt overboekingen en correcties uit het grootboek; interne verplaatsingen vallen tegen elkaar weg", async () => {
    const { fetchImpl } = fakeKraken();
    const client = new KrakenClient(creds, { fetchImpl, sleep: async () => undefined });
    const txs = await normalizeKraken(client, await client.tradesSince(0), await client.ledgerSince(0), []);
    expect(txs.find((x) => x.externalId === "kraken:ledger:L00020")).toMatchObject({ type: "transfer_in", symbol: "BCH", quantity: "0.0000250000" });
    expect(txs.find((x) => x.externalId === "kraken:ledger:L00021")).toMatchObject({ type: "transfer_out", symbol: "ETH", quantity: "0.0000010000" });
    // spot → staking: −1 DOT en +1 DOT.S komen allebei op DOT uit en heffen elkaar op
    const dot = txs.filter((x) => x.symbol === "DOT" && x.externalId.startsWith("kraken:ledger:L0002"));
    expect(dot.map((d) => d.type).sort()).toEqual(["transfer_in", "transfer_out"]);
    expect(dot.reduce((s, d) => s + Number(d.quantity) * (d.type === "transfer_in" ? 1 : -1), 0)).toBe(0);
  });

  it("valt voor koersen van vóór het OHLC-venster terug op de publieke tradelijst", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      seen.push(url.pathname);
      const json = (result: unknown, error: string[] = []) => new Response(JSON.stringify({ error, result }));
      if (url.pathname === "/0/public/OHLC") {
        // Kraken geeft altijd alleen de laatste ~720 dagen, ongeacht `since`
        return json({ XBTEUR: [[1758326400, "1", "1", "1", "100000", "0", "0", 1]], last: 1758326400 });
      }
      if (url.pathname === "/0/public/Trades") {
        expect(url.searchParams.get("pair")).toBe("XBTEUR");
        return json({
          XXBTZEUR: [
            ["900.0", "1", 1493510400, "b", "l", "", 1],
            ["1200.5", "1", 1493596700, "b", "l", "", 2], // net vóór het gevraagde moment
            ["9999.0", "1", 1493600000, "b", "l", "", 3], // erna, telt niet mee
          ],
          last: "1",
        });
      }
      return json(null, ["EGeneral:Unknown endpoint"]);
    }) as typeof fetch;
    const client = new KrakenClient(creds, { fetchImpl, sleep: async () => undefined });
    expect(await client.priceInEur("BTC", "2017-05-01T00:00:00.000Z")).toBe(1200.5);
    expect(seen).toContain("/0/public/Trades");
    // binnen het venster blijft OHLC de bron, zonder extra call
    seen.length = 0;
    expect(await client.priceInEur("BTC", "2025-09-22T12:00:00.000Z")).toBe(100000);
    expect(seen).toEqual([]);
  });

  it("zonder AssetPairs-lijst breekt de sync af (niets wordt op Yahoo vastgepind); een enkel onbekend paar valt terug op de naamsplitsing", async () => {
    const { fetchImpl, calls } = fakeKraken();
    const failingPairs = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : (input as URL).toString());
      if (url.pathname === "/0/public/AssetPairs") return new Response(JSON.stringify({ error: ["EService:Unavailable"], result: {} }), { headers: { "content-type": "application/json" } });
      return fetchImpl(input, init);
    }) as typeof fetch;
    // normalisatie: duidelijke fout in plaats van yahoo:<SYM>-EUR als koersbron voor elk nieuw asset
    const client = new KrakenClient(creds, { fetchImpl: failingPairs, sleep: async () => undefined });
    await expect(normalizeKraken(client, await client.tradesSince(0), await client.ledgerSince(0), [])).rejects.toThrow(/pairlijst \(AssetPairs\) niet beschikbaar — Kraken: EService:Unavailable.*probeer later opnieuw/);
    // provider.sync: faalt vóór de private calls (cursor schuift niet op, trades worden de volgende keer opnieuw opgehaald)
    calls.length = 0;
    const provider = makeKrakenProvider({ fetchImpl: failingPairs, sleep: async () => undefined });
    await expect(provider.sync(creds, { id: 1, provider: "kraken", accountType: "real", cursor: {}, lastPrice: () => null, hasTransaction: () => false, log: () => undefined })).rejects.toThrow("AssetPairs");
    expect(calls.map((c) => c.path)).toEqual([]); // de nep-server zag alleen de (onderschepte) AssetPairs-call

    // een paar dat in de lijst ontbreekt (bijv. delisted) blijft via de naamsplitsing herkend; de koersbron komt uit de lijst
    const partialPairs = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : (input as URL).toString());
      if (url.pathname !== "/0/public/AssetPairs") return fetchImpl(input, init);
      const res = await fetchImpl(input, init);
      const body = (await res.json()) as { error: string[]; result: Record<string, unknown> };
      delete body.result.XETHXXBT;
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client2 = new KrakenClient(creds, { fetchImpl: partialPairs, sleep: async () => undefined });
    const txs = await normalizeKraken(client2, await client2.tradesSince(0), await client2.ledgerSince(0), []);
    const cross = txs.find((x) => x.externalId === "kraken:trade:TCROSS-AAAAA-BBBBBB:base")!;
    expect(cross).toMatchObject({ symbol: "ETH", providerAssetId: "XETH", priceSource: { source: "kraken", sourceId: "XETHZEUR" } }); // XETHXXBT → XETH + XXBT
    expect(txs.find((x) => x.externalId === "kraken:trade:TCROSS-AAAAA-BBBBBB:quote")!).toMatchObject({ symbol: "BTC", providerAssetId: "XXBT", priceSource: { source: "kraken", sourceId: "XXBTZEUR" } });
  });

  it("krakenPriceHints kiest per basisasset het online paar met de beste quote-munt", () => {
    const pair = (key: string, base: string, quote: string, status = "online"): [string, KrakenPairInfo] => [key, { key, altname: key, base, quote, status }];
    const pairs = Object.fromEntries([
      pair("XXBTZUSD", "XXBT", "ZUSD"),
      pair("XXBTZEUR", "XXBT", "ZEUR"),
      pair("XXBTZEUR.d", "XXBT", "ZEUR"),
      pair("ADACHF", "ADA", "CHF"),
      pair("ADAGBP", "ADA", "ZGBP"),
      pair("ADAJPY", "ADA", "ZJPY"),
      pair("DOTEUR", "DOT", "ZEUR", "cancel_only"),
      pair("ADAEUR", "ADA", "ZEUR", "maintenance"),
      pair("XETHXXBT", "XETH", "XXBT"),
      pair("XETHZGBP", "XETH", "ZGBP"),
    ]);
    // altname-alias zoals client.pairs() die aanmaakt: zelfde object onder een andere sleutel, telt niet dubbel
    pairs.XBTEUR = pairs.XXBTZEUR;
    // tokenized asset (xStock): de koersbron kent zo'n paar niet, dus ook geen hint (valt terug op Yahoo)
    pairs.AAPLxEUR = { key: "AAPLxEUR", altname: "AAPLxEUR", base: "AAPLx", quote: "ZEUR", status: "online", aclass_base: "tokenized_asset" };
    const hints = krakenPriceHints(pairs, { XXBT: { altname: "XBT" }, XETH: { altname: "ETH" } });
    expect(hints.byCode.get("AAPLx")).toBeUndefined();
    expect(hints.bySymbol.get("AAPLX")).toBeUndefined();
    expect(hints.byCode.get("XXBT")).toBe("XXBTZEUR"); // EUR boven USD, dark pool genegeerd
    expect(hints.bySymbol.get("BTC")).toBe("XXBTZEUR");
    expect(hints.byCode.get("ADA")).toBe("ADAEUR"); // EUR boven GBP en CHF, ook als het pair gepauzeerd is; JPY telt niet mee
    // een gepauzeerd pair blijft de koersbron: Kraken blijft er koersen voor geven en anders zou het asset blijvend
    // op een Yahoo-feed belanden die de munt vaak niet kent
    expect(hints.byCode.get("DOT")).toBe("DOTEUR");
    expect(hints.byCode.get("XETH")).toBe("XETHZGBP"); // crypto-quote (XBT) telt niet mee
    expect(hints.bySymbol.get("ETH")).toBe("XETHZGBP");
    expect(hints.byCode.get("XBTEUR")).toBeUndefined();
  });

  it("saldi worden genormaliseerd en gestakete varianten opgeteld", async () => {
    const { fetchImpl } = fakeKraken();
    const client = new KrakenClient(creds, { fetchImpl, sleep: async () => undefined });
    const bal = await krakenBalances(client);
    const map = Object.fromEntries(bal.map((b) => [b.currency, b.amount]));
    expect(map.BTC).toBe("0.12340000");
    expect(map.EUR).toBe("512.10000000");
    expect(map.DOT).toBe("11.25000000");
    expect(map.SOL).toBeUndefined(); // stof
  });

  it("provider.sync levert transacties, saldi en een cursor; tweede sync is leeg", async () => {
    const { fetchImpl } = fakeKraken();
    const provider = makeKrakenProvider({ fetchImpl, sleep: async () => undefined });
    const ctx = { id: 1, provider: "kraken" as const, accountType: "real", cursor: {}, lastPrice: () => null, hasTransaction: () => false, log: () => undefined };
    const r1 = await provider.sync(creds, ctx);
    expect(r1.transactions.length).toBeGreaterThan(60);
    expect(r1.balances.length).toBe(3);
    expect(r1.cursor.lastTradeTime).toBe(1700320000);
    const r2 = await provider.sync(creds, { ...ctx, cursor: r1.cursor });
    expect(r2.transactions.length).toBe(0);
    expect(r2.cursor.lastTradeTime).toBe(1700320000);
  });

  it("test() meldt ontbrekende rechten begrijpelijk", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: ["EGeneral:Permission denied"], result: null }))) as typeof fetch;
    const provider = makeKrakenProvider({ fetchImpl, sleep: async () => undefined });
    const r = await provider.test(creds, { id: 1, provider: "kraken", accountType: "real", cursor: {}, lastPrice: () => null, hasTransaction: () => false, log: () => undefined });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("leesrechten");
  });
});

describe("Kraken publieke client", () => {
  it("krakenPublicClient geeft koersen op een tijdstip zonder key; privé-endpoints weigeren", async () => {
    const fetchImpl = (async (input: URL | RequestInfo) => {
      const url = new URL(typeof input === "string" ? input : (input as URL).toString());
      if (url.pathname === "/0/public/OHLC") {
        const since = Number(url.searchParams.get("since"));
        const start = since - (since % 86400);
        return new Response(JSON.stringify({ error: [], result: { XXBTZEUR: Array.from({ length: 10 }, (_, i) => [start + i * 86400, "31000.0", "31000.0", "31000.0", "31000.0", "31000.0", "1.0", 1]), last: start } }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: ["EQuery:Unknown asset pair"], result: {} }), { status: 200 });
    }) as typeof fetch;
    const client = krakenPublicClient({ fetchImpl });
    expect(await client.priceInEur("BTC", "2024-05-01T12:00:00Z")).toBe(31000);
    expect(await client.priceInEur("EUR", "2024-05-01T12:00:00Z")).toBe(1);
    expect(client.lastNonceValue).toBe(0);
    await expect(client.privatePost("Balance")).rejects.toThrow(/zonder API-key/);
    expect(() => client.nextNonce()).toThrow(/zonder API-key/);
  });
});
