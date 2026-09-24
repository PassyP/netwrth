import { describe, it, expect } from "vitest";
import { Address, NETWORK } from "@scure/btc-signer";
import { makeEsploraClient, normalizeBitcoinApiUrl, probeNode, requireBitcoinApiUrl, EsploraError, PROBE_ADDRESS } from "./esplora";
import { FakeEsplora } from "./esplora-fake";

const A = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

describe("esplora-client", () => {
  it("normaliseert de node-URL en eist een http(s)-URL", () => {
    expect(normalizeBitcoinApiUrl("http://umbrel.local:3006/")).toBe("http://umbrel.local:3006");
    expect(normalizeBitcoinApiUrl(" http://10.21.21.26:3006/api/ ")).toBe("http://10.21.21.26:3006");
    expect(() => requireBitcoinApiUrl("")).toThrow(/Geen Bitcoin-node ingesteld/);
    expect(() => requireBitcoinApiUrl(undefined)).toThrow(/Geen Bitcoin-node ingesteld/);
    expect(() => requireBitcoinApiUrl("umbrel.local:3006")).toThrow(/http/);
    expect(requireBitcoinApiUrl("https://node/")).toBe("https://node");
  });

  it("pagineert adrestransacties tot een lege pagina, ongeacht de paginagrootte", async () => {
    for (const [pageSize, expectedCalls] of [
      [2, 21],
      [10, 5],
      [25, 3],
    ] as const) {
      const node = new FakeEsplora();
      node.pageSize = pageSize;
      for (let i = 0; i < 40; i++) node.addTx({ txid: `t${String(i).padStart(3, "0")}`, inputs: [{ address: "1ext", value: 1000 }], outputs: [{ address: A, value: 900 }], height: 700000 + i });
      node.addTx({ txid: "mem1", inputs: [{ address: "1ext", value: 1000 }], outputs: [{ address: A, value: 900 }], height: null });
      const client = makeEsploraClient({ baseUrl: node.baseUrl, fetchImpl: node.fetch });
      const txs = await client.addressTxs(A);
      expect(txs).toHaveLength(41);
      expect(new Set(txs.map((t) => t.txid)).size).toBe(41);
      // per vervolgpagina één call (?after_txid werkt meteen), plus de eerste pagina en de lege slotpagina
      expect(node.calls.filter((c) => c.includes("/txs")).length).toBe(expectedCalls);
    }
  });

  it("paginering werkt ook op een node die alleen /txs/chain/:txid kent (Blockstream) of alleen ?after_txid (mempool-backend)", async () => {
    for (const paging of ["path", "query"] as const) {
      const node = new FakeEsplora();
      node.paging = paging;
      node.pageSize = 10;
      for (let i = 0; i < 35; i++) node.addTx({ txid: `t${String(i).padStart(3, "0")}`, inputs: [{ address: "1ext", value: 1000 }], outputs: [{ address: A, value: 900 }], height: 700000 + i });
      const client = makeEsploraClient({ baseUrl: node.baseUrl, fetchImpl: node.fetch });
      const txs = await client.addressTxs(A);
      expect(txs.map((t) => t.txid).sort()).toEqual(Array.from({ length: 35 }, (_, i) => `t${String(i).padStart(3, "0")}`));
      const calls = node.calls.filter((c) => c.includes("/txs"));
      // path-only: de query-stijl levert bij de eerste vervolgpagina niets nieuws (Esplora geeft pagina 1 terug) en wordt daarna niet meer geprobeerd
      // query-only: de query-stijl slaat meteen aan; /txs/chain wordt nooit aangeroepen
      expect(calls.filter((c) => c.includes("/txs/chain/")).length).toBe(paging === "path" ? 4 : 0);
      expect(calls.filter((c) => c.includes("after_txid")).length).toBe(paging === "path" ? 1 : 4);
    }
  });

  it("een netwerkfout of time-out wordt herhaald; daarna een nette fout", async () => {
    const node = new FakeEsplora();
    node.failFirst = 2;
    const waits: number[] = [];
    const client = makeEsploraClient({ baseUrl: node.baseUrl, fetchImpl: node.fetch, retryDelayMs: 10, sleep: async (ms) => { waits.push(ms); } });
    expect(await client.tipHeight()).toBe(800000);
    expect(waits).toEqual([10, 20]);
    node.failFirst = 5;
    await expect(client.tipHeight()).rejects.toThrow(/niet bereikbaar.*ETIMEDOUT/);
  });

  it("adresstatistieken en blokhoogte", async () => {
    const node = new FakeEsplora();
    node.tip = 812345;
    node.addTx({ txid: "a", inputs: [{ address: "1ext", value: 5000 }], outputs: [{ address: A, value: 4000 }], height: 812000 });
    node.addTx({ txid: "b", inputs: [{ address: A, value: 4000 }], outputs: [{ address: "1ext", value: 3500 }], height: 812100 });
    node.addTx({ txid: "c", inputs: [{ address: "1ext", value: 800 }], outputs: [{ address: A, value: 700 }], height: null });
    const client = makeEsploraClient({ baseUrl: node.baseUrl, fetchImpl: node.fetch });
    expect(await client.tipHeight()).toBe(812345);
    const s = await client.addressStats(A);
    expect(s.chain_stats).toMatchObject({ tx_count: 2, funded_txo_sum: 4000, spent_txo_sum: 4000 });
    expect(s.mempool_stats).toMatchObject({ tx_count: 1, funded_txo_sum: 700, spent_txo_sum: 0 });
  });

  it("foutmeldingen noemen host en status, nooit het adres", async () => {
    const node = new FakeEsplora();
    node.addressStatus = 500;
    const client = makeEsploraClient({ baseUrl: node.baseUrl, fetchImpl: node.fetch });
    await expect(client.addressStats(A)).rejects.toThrow(/HTTP 500/);
    try {
      await client.addressStats(A);
    } catch (e) {
      expect(e).toBeInstanceOf(EsploraError);
      expect((e as Error).message).not.toContain(A);
      expect((e as Error).message).toContain("node.test:3006");
    }
    node.addressStatus = null;
    node.down = true;
    await expect(client.tipHeight()).rejects.toThrow(/niet bereikbaar.*ECONNREFUSED/);
    // .local-naam in een container: uitleg met het Umbrel-IP, zowel bij onbekende host als bij geweigerde verbinding
    for (const code of ["ENOTFOUND", "ECONNREFUSED"]) {
      const local = makeEsploraClient({ baseUrl: "http://umbrel.local:3006", fetchImpl: async () => { const e = new TypeError("fetch failed"); (e as { cause?: unknown }).cause = { code }; throw e; } });
      await expect(local.tipHeight()).rejects.toThrow(/Umbrel-app.*10\.21\.21\.26:3006/);
    }
    // time-out: aparte, uitlegbare melding (geen herhaling in deze test: retries 0)
    const slow = makeEsploraClient({ baseUrl: "http://slow.test", fetchImpl: async () => { const e = new DOMException("The operation was aborted due to timeout", "TimeoutError"); throw e; }, retries: 0 });
    await expect(slow.tipHeight()).rejects.toThrow(/antwoordt niet binnen 15 s.*remt dit IP af/);
    // een webpagina in plaats van de API
    const html = makeEsploraClient({ baseUrl: "http://other.test", fetchImpl: async () => new Response("<html>", { status: 200 }) });
    await expect(html.tipHeight()).rejects.toThrow(/geen blokhoogte/);
    await expect(html.addressStats(A)).rejects.toThrow(/geen JSON/);
  });

  it("probeNode: OK, node onbereikbaar, en adresindex uit (geen Electrs)", async () => {
    const node = new FakeEsplora();
    const client = makeEsploraClient({ baseUrl: node.baseUrl, fetchImpl: node.fetch });
    expect(await probeNode(client)).toMatchObject({ ok: true, height: 800000 });
    expect((await probeNode(client)).message).toContain("blokhoogte 800000");
    node.addressStatus = 501;
    const r = await probeNode(client);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Electrs");
    node.down = true;
    expect((await probeNode(client)).message).toContain("niet bereikbaar");
  });

  it("probeNode vraagt een ongebruikt adres op, nooit het genesis-adres (dat legt Electrs minutenlang vast)", async () => {
    const node = new FakeEsplora();
    await probeNode(makeEsploraClient({ baseUrl: node.baseUrl, fetchImpl: node.fetch }));
    expect(node.calls.some((c) => c.includes(`/api/address/${PROBE_ADDRESS}`))).toBe(true);
    expect(node.calls.some((c) => c.includes("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"))).toBe(false);
    // geldig mainnet-adres, anders weigert de node het met HTTP 400
    expect(Address(NETWORK).decode(PROBE_ADDRESS)).toMatchObject({ type: "wpkh" });
  });

  it("probeNode: blokhoogte OK maar de adreslookup hangt (Electrs bezet) → melding over Electrs, geen IP-afremming", async () => {
    const node = new FakeEsplora();
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).includes("/api/address/")) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return node.fetch(input, init);
    };
    const r = await probeNode(makeEsploraClient({ baseUrl: node.baseUrl, fetchImpl, retries: 0 }));
    expect(r).toMatchObject({ ok: false, height: 800000 });
    expect(r.message).toContain("Herstart de Electrs-app");
    expect(r.message).not.toContain("remt dit IP af");
  });

  it("HTTP 429 (publieke node) wordt met verdubbelende wachttijd herhaald, Retry-After gaat voor; daarna een fout", async () => {
    let n = 0;
    const waits: number[] = [];
    const flaky = makeEsploraClient({
      baseUrl: "https://mempool.space",
      fetchImpl: async () => (++n <= 3 ? new Response("slow down", { status: 429, headers: n === 2 ? { "retry-after": "7" } : {} }) : new Response("800000", { status: 200 })),
      retryDelayMs: 100,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(await flaky.tipHeight()).toBe(800000);
    expect(n).toBe(4);
    expect(waits).toEqual([100, 7000, 400]);
    let tries = 0;
    const always = makeEsploraClient({ baseUrl: "https://mempool.space", fetchImpl: async () => (tries++, new Response("slow down", { status: 429 })), retryDelayMs: 1, sleep: async () => undefined });
    await expect(always.tipHeight()).rejects.toThrow(/HTTP 429/);
    expect(tries).toBe(6);
  });

  it("minIntervalMs verdeelt de verzoeken in de tijd, ook over parallelle workers", async () => {
    const waits: number[] = [];
    const client = makeEsploraClient({ baseUrl: "http://x.test", fetchImpl: async () => new Response("800000", { status: 200 }), minIntervalMs: 100, now: () => 0, sleep: async (ms) => { waits.push(ms); } });
    await client.mapLimit([1, 2, 3, 4], () => client.tipHeight());
    expect(waits).toEqual([100, 200, 300]); // de eerste mag meteen, de rest telkens 100 ms later
  });

  it("stuurt een herkenbare User-Agent mee (publieke nodes weigeren de standaard-UA van Node)", async () => {
    let headers: Record<string, string> | undefined;
    const client = makeEsploraClient({ baseUrl: "http://x.test", fetchImpl: (async (_u: unknown, init?: RequestInit) => { headers = init?.headers as Record<string, string>; return new Response("800000", { status: 200 }); }) as typeof fetch });
    await client.tipHeight();
    expect(headers?.["user-agent"]).toMatch(/^Netwrth\//);
    expect(headers?.accept).toBe("application/json");
  });

  it("mapLimit houdt de volgorde en beperkt de gelijktijdigheid", async () => {
    const client = makeEsploraClient({ baseUrl: "http://x.test", fetchImpl: fetch, concurrency: 3 });
    let running = 0;
    let max = 0;
    const out = await client.mapLimit([1, 2, 3, 4, 5, 6, 7], async (n) => {
      running++;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(max).toBe(3);
  });
});
