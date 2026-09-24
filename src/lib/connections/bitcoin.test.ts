import { describe, it, expect } from "vitest";
import { makeBitcoinProvider } from "./bitcoin";
import { krakenPublicClient } from "./kraken";
import type { ConnectionContext, WalletAccountWithKey } from "./types";
import { FakeEsplora } from "../bitcoin/esplora-fake";
import { makeAddressDeriver, parseExtendedPublicKey } from "../bitcoin/xpub";
import { discoverAccounts } from "../bitcoin/discover";
import { makeEsploraClient } from "../bitcoin/esplora";
import { YPUB, ZPUB } from "../bitcoin/test-vectors";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** Nep-Kraken: alleen OHLC, dagslot 30 000 EUR vanaf `since`; logt de paden. */
function fakeKrakenFetch(log: string[]): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(typeof input === "string" ? input : (input as URL).toString());
    log.push(url.pathname);
    if (url.pathname === "/0/public/OHLC") {
      const since = Number(url.searchParams.get("since"));
      const start = since - (since % 86400);
      return json({ error: [], result: { XXBTZEUR: Array.from({ length: 10 }, (_, i) => [start + i * 86400, "30000.0", "30000.0", "30000.0", "30000.0", "30000.0", "1.0", 1]), last: start } });
    }
    return json({ error: ["EQuery:Unknown asset pair"], result: {} });
  }) as typeof fetch;
}

const CREDS = { apiKey: "", apiSecret: "" };
const T = 1700000000; // 2023-11-14
const zpub = parseExtendedPublicKey(ZPUB);
const dz = makeAddressDeriver(zpub.key, "p2wpkh");
const dy = makeAddressDeriver(parseExtendedPublicKey(YPUB).key, "p2sh-p2wpkh");
const accA: WalletAccountWithKey = { id: 1, label: "Bitcoin 1", scriptType: "p2wpkh", enabled: true, xpub: ZPUB };
const accB: WalletAccountWithKey = { id: 2, label: "Bitcoin 2", scriptType: "p2sh-p2wpkh", enabled: true, xpub: YPUB };

const ctx = (accounts: WalletAccountWithKey[], known = new Set<string>()): ConnectionContext => ({ id: 7, provider: "bitcoin", accountType: "real", cursor: {}, lastPrice: () => null, hasTransaction: (e) => known.has(e), accounts, log: () => undefined });

function setup() {
  const node = new FakeEsplora();
  node.tip = 800000;
  const klog: string[] = [];
  const provider = makeBitcoinProvider({ fetchImpl: node.fetch, baseUrl: node.baseUrl, kraken: () => krakenPublicClient({ fetchImpl: fakeKrakenFetch(klog) }) });
  return { node, klog, provider };
}

describe("bitcoin-provider", () => {
  it("ontvangst met genoeg bevestigingen → transfer_in tegen de dagkoers; saldo en accountvelden", async () => {
    const { node, provider, klog } = setup();
    node.addTx({ txid: "rx1", inputs: [{ address: "1ext", value: 200000 }], outputs: [{ address: dz(0, 0), value: 100000 }, { address: "1ext2", value: 99000 }], height: 799991, time: T });
    const out = await provider.sync(CREDS, ctx([accA]));
    expect(out.transactions).toHaveLength(1);
    expect(out.transactions[0]).toMatchObject({ externalId: "btc:7:rx1", type: "transfer_in", symbol: "BTC", assetName: "Bitcoin", category: "crypto", quantity: "0.00100000", price: "30000", currency: "EUR", fee: "0", executedAt: new Date(T * 1000).toISOString(), priceSource: { source: "kraken", sourceId: "XXBTZEUR" } });
    expect(out.transactions[0].note).toContain("Bitcoin 1");
    expect(out.transactions[0].note).not.toContain("bc1q");
    expect(out.balances).toEqual([{ currency: "BTC", amount: "0.00100000", hold: "0.00000000" }]);
    expect(out.accounts).toEqual([{ id: 1, receiveUsed: 1, changeUsed: 0, txCount: 1, balanceConfirmed: "0.00100000", balanceUnconfirmed: "0.00000000", lastScanAt: expect.any(String) }]);
    expect(out.cursor).toMatchObject({ tipHeight: 800000 });
    expect(out.warnings).toEqual([]);
    expect(klog.filter((p) => p.endsWith("OHLC"))).toHaveLength(1);
  });

  it("verzending → transfer_out inclusief fee plus een aparte fee-transactie in EUR; wisselgeld blijft eigen", async () => {
    const { node, provider } = setup();
    node.addTx({ txid: "rx1", inputs: [{ address: "1ext", value: 200000 }], outputs: [{ address: dz(0, 0), value: 100000 }], height: 799990, time: T });
    node.addTx({ txid: "sp1", inputs: [{ address: dz(0, 0), value: 100000 }], outputs: [{ address: "1ext3", value: 60000 }, { address: dz(1, 0), value: 39000 }], height: 799992, time: T + 1200 });
    const out = await provider.sync(CREDS, ctx([accA]));
    expect(out.transactions.map((t) => t.type)).toEqual(["transfer_in", "transfer_out", "fee"]);
    const [, sp, fee] = out.transactions;
    expect(sp).toMatchObject({ externalId: "btc:7:sp1", quantity: "0.00061000", price: "0", currency: "EUR" });
    expect(sp.note).toContain("incl. 0.00001000 BTC kosten");
    expect(fee).toMatchObject({ externalId: "btc:7:sp1:fee", type: "fee", symbol: "", quantity: "0", price: "0.30000000", currency: "EUR", executedAt: new Date((T + 1200) * 1000).toISOString() });
    expect(out.balances).toEqual([{ currency: "BTC", amount: "0.00039000", hold: "0.00000000" }]);
    expect(out.accounts![0]).toMatchObject({ receiveUsed: 1, changeUsed: 1, txCount: 2, balanceConfirmed: "0.00039000" });
  });

  it("in afwachting: onbevestigd of < 6 bevestigingen wordt niet geboekt maar telt in hold; na bevestiging wel", async () => {
    const { node, provider } = setup();
    node.addTx({ txid: "rx1", inputs: [{ address: "1ext", value: 200000 }], outputs: [{ address: dz(0, 0), value: 100000 }], height: 799990, time: T });
    node.addTx({ txid: "mem1", inputs: [{ address: "1ext", value: 60000 }], outputs: [{ address: dz(0, 1), value: 50000 }], height: null });
    node.addTx({ txid: "young", inputs: [{ address: "1ext", value: 30000 }], outputs: [{ address: dz(0, 2), value: 20000 }], height: 799998, time: T + 4800 }); // 3 bevestigingen
    const out1 = await provider.sync(CREDS, ctx([accA]));
    expect(out1.transactions.map((t) => t.externalId)).toEqual(["btc:7:rx1"]);
    expect(out1.balances).toEqual([{ currency: "BTC", amount: "0.00100000", hold: "0.00070000" }]);
    // accountvelden volgen de node: on-chain (≥ 1 bevestiging) en mempool apart
    expect(out1.accounts![0]).toMatchObject({ receiveUsed: 3, balanceConfirmed: "0.00120000", balanceUnconfirmed: "0.00050000", txCount: 3 });

    node.tip = 800010;
    node.confirm("mem1", 800000, T + 6000);
    const known = new Set(out1.transactions.map((t) => t.externalId));
    const out2 = await provider.sync(CREDS, ctx([accA], known));
    expect(out2.transactions.map((t) => t.externalId).sort()).toEqual(["btc:7:mem1", "btc:7:young"]);
    expect(out2.balances).toEqual([{ currency: "BTC", amount: "0.00170000", hold: "0.00000000" }]);
  });

  it("interne overboeking tussen twee accounts: alleen de fee verlaat de positie", async () => {
    const { node, provider } = setup();
    node.addTx({ txid: "rx1", inputs: [{ address: "1ext", value: 200000 }], outputs: [{ address: dz(0, 0), value: 100000 }], height: 799980, time: T });
    node.addTx({ txid: "int1", inputs: [{ address: dz(0, 0), value: 100000 }], outputs: [{ address: dy(0, 0), value: 99000 }], height: 799985, time: T + 3000 });
    const out = await provider.sync(CREDS, ctx([accA, accB]));
    expect(out.transactions.map((t) => t.type)).toEqual(["transfer_in", "transfer_out", "fee"]);
    expect(out.transactions[1]).toMatchObject({ quantity: "0.00001000", price: "0" });
    expect(out.transactions[1].note).toContain("interne overboeking");
    expect(out.transactions[1].note).toContain("Bitcoin 1, Bitcoin 2");
    expect(out.transactions[2]).toMatchObject({ type: "fee", price: "0.30000000" });
    expect(out.balances).toEqual([{ currency: "BTC", amount: "0.00099000", hold: "0.00000000" }]);
    expect(out.accounts).toEqual([
      expect.objectContaining({ id: 1, balanceConfirmed: "0.00000000", txCount: 2 }),
      expect.objectContaining({ id: 2, balanceConfirmed: "0.00099000", txCount: 1, receiveUsed: 1 }),
    ]);
  });

  it("gedeelde transactie (niet alle inputs eigen) en coinbase: netto geboekt, geen fee-transactie", async () => {
    const { node, provider } = setup();
    node.addTx({ txid: "cb1", inputs: [{ address: null, value: 0 }], outputs: [{ address: dz(0, 0), value: 625000000 }], height: 799900, time: T });
    node.addTx({ txid: "cj1", inputs: [{ address: dz(0, 0), value: 625000000 }, { address: "1ext", value: 100000 }], outputs: [{ address: "1ext2", value: 624000000 }, { address: dz(1, 0), value: 1090000 }], height: 799950, time: T + 30000 });
    const out = await provider.sync(CREDS, ctx([accA]));
    expect(out.transactions.map((t) => t.type)).toEqual(["transfer_in", "transfer_out"]);
    expect(out.transactions[0].quantity).toBe("6.25000000");
    expect(out.transactions[1].quantity).toBe("6.23910000");
    expect(out.transactions[1].note).toContain("gedeelde transactie");
    expect(out.balances[0].amount).toBe("0.01090000");
  });

  it("al geboekte transacties worden overgeslagen zonder koersopvraag", async () => {
    const { node, provider, klog } = setup();
    node.addTx({ txid: "rx1", inputs: [{ address: "1ext", value: 200000 }], outputs: [{ address: dz(0, 0), value: 100000 }], height: 799990, time: T });
    const out1 = await provider.sync(CREDS, ctx([accA]));
    expect(out1.transactions).toHaveLength(1);
    const calls = klog.length;
    expect(calls).toBeGreaterThan(0);
    const out2 = await provider.sync(CREDS, ctx([accA], new Set(["btc:7:rx1"])));
    expect(out2.transactions).toHaveLength(0);
    expect(out2.balances[0].amount).toBe("0.00100000");
    expect(klog.length).toBe(calls);
  });

  it("geen ingeschakelde accounts of een ongeldige xpub geeft een lege sync met waarschuwing", async () => {
    const { provider } = setup();
    const none = await provider.sync(CREDS, ctx([]));
    expect(none.transactions).toEqual([]);
    expect(none.balances[0].amount).toBe("0.00000000");
    expect(none.warnings[0]).toContain("Geen ingeschakelde");
    const off = await provider.sync(CREDS, ctx([{ ...accA, enabled: false }]));
    expect(off.warnings[0]).toContain("Geen ingeschakelde");
    const bad = await provider.sync(CREDS, ctx([{ ...accA, xpub: "hallo" }]));
    expect(bad.transactions).toEqual([]);
    expect(bad.warnings[0]).toMatch(/Bitcoin 1: Geen geldige/);
  });

  it("test(): node bereikbaar of niet", async () => {
    const { node, provider } = setup();
    const ok = await provider.test(CREDS, ctx([]));
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain("blokhoogte 800000");
    node.down = true;
    const down = await provider.test(CREDS, ctx([]));
    expect(down.ok).toBe(false);
    expect(down.message).toContain("niet bereikbaar");
  });

  it("node onbereikbaar tijdens een sync → fout zonder adressen", async () => {
    const { node, provider } = setup();
    node.down = true;
    await expect(provider.sync(CREDS, ctx([accA]))).rejects.toThrow(/niet bereikbaar/);
  });
});

describe("bitcoin-discovery", () => {
  it("zpub: één actieve kandidaat; gap limit 20 op de ontvangstketen; allTypes voegt inactieve typen toe", async () => {
    const node = new FakeEsplora();
    node.addTx({ txid: "a", inputs: [{ address: "1ext", value: 200000 }], outputs: [{ address: dz(0, 0), value: 100000 }], height: 799990, time: T });
    node.addTx({ txid: "b", inputs: [{ address: "1ext", value: 6000 }], outputs: [{ address: dz(0, 19), value: 5000 }], height: 799991, time: T });
    node.addTx({ txid: "c", inputs: [{ address: "1ext", value: 8000 }], outputs: [{ address: dz(0, 45), value: 7000 }], height: 799992, time: T }); // 25 lege adressen ervoor: buiten de gap limit
    const client = makeEsploraClient({ baseUrl: node.baseUrl, fetchImpl: node.fetch });
    const r = await discoverAccounts([ZPUB], { client });
    expect(r.warnings).toEqual([]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ keyIndex: 0, prefix: "zpub", depth: 3, scriptType: "p2wpkh", label: "Bitcoin 1 · Native SegWit", firstAddress: "bc1qcr8t…306fyu", txCount: 2, balanceConfirmed: "0.00105000", balanceUnconfirmed: "0.00000000", receiveUsed: 20, changeUsed: 0, active: true, defaultType: true });
    expect(r.candidates[0].fingerprint).toBe(zpub.fingerprint);
    expect(node.calls.some((c) => c.includes(dz(0, 45)))).toBe(false); // nooit opgevraagd
    expect(node.calls.some((c) => c.includes(dz(0, 39)))).toBe(true); // wel tot en met het venster na index 19

    const all = await discoverAccounts([ZPUB], { client, allTypes: true });
    expect(all.candidates.map((c) => c.scriptType)).toEqual(["p2pkh", "p2sh-p2wpkh", "p2wpkh", "p2tr"]);
    expect(all.candidates.filter((c) => c.active).map((c) => c.scriptType)).toEqual(["p2wpkh"]);
    expect(all.candidates.filter((c) => !c.active).every((c) => c.balanceConfirmed === "0.00000000" && c.txCount === 0)).toBe(true);
  });

  it("xpub (Ledger Live-stijl) scant alle vier adrestypes; duplicaten, lege regels en private keys geven waarschuwingen op regelnummer", async () => {
    const node = new FakeEsplora();
    node.addTx({ txid: "a", inputs: [{ address: "1ext", value: 200000 }], outputs: [{ address: dy(0, 0), value: 100000 }], height: 799990, time: T });
    const client = makeEsploraClient({ baseUrl: node.baseUrl, fetchImpl: node.fetch });
    const xprv = "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi";
    const r = await discoverAccounts(["", YPUB, YPUB, xprv, "rommel"], { client });
    expect(r.warnings).toEqual(["Regel 3 is een duplicaat van regel 2; overgeslagen.", "Regel 4: Dit is een private key (xprv/yprv/zprv); voer nooit een private key in, alleen de xpub.", "Regel 5: Geen geldige xpub, ypub of zpub."]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ keyIndex: 1, scriptType: "p2sh-p2wpkh", active: true, balanceConfirmed: "0.00100000", label: "Bitcoin 1 · SegWit" });
    // xpub is dubbelzinnig: vier kandidaten, geen ervan actief op deze node
    const x = await discoverAccounts(["xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ"], { client });
    expect(x.candidates.map((c) => [c.scriptType, c.active, c.defaultType])).toEqual([
      ["p2pkh", false, true],
      ["p2sh-p2wpkh", false, false],
      ["p2wpkh", false, false],
      ["p2tr", false, false],
    ]);
    expect(JSON.stringify(x)).not.toContain("xpub6"); // de sleutel gaat nooit terug
  });
});
