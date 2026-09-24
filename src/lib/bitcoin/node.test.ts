import { describe, it, expect } from "vitest";
import { connectBitcoinNode } from "./node";
import { FakeEsplora } from "./esplora-fake";

/** twee nep-nodes achter één fetch: de eigen node en de publieke */
function twoNodes() {
  const own = new FakeEsplora("http://umbrel.local:3006");
  own.tip = 800000;
  const pub = new FakeEsplora("https://mempool.space");
  pub.tip = 800001;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as URL).toString());
    return url.host === "umbrel.local:3006" ? own.fetch(input, init) : pub.fetch(input, init);
  };
  return { own, pub, fetchImpl };
}

describe("bitcoin-node keuze", () => {
  it("eigen node bereikbaar → eigen node, zonder melding", async () => {
    const { fetchImpl } = twoNodes();
    const n = await connectBitcoinNode({ bitcoinApiUrl: "http://umbrel.local:3006/", bitcoinFallbackEnabled: true, bitcoinFallbackUrl: "https://mempool.space" }, fetchImpl);
    expect(n).toMatchObject({ source: "own", tipHeight: 800000, warnings: [] });
    expect(n.client.baseUrl).toBe("http://umbrel.local:3006");
  });

  it("eigen node onbereikbaar → publieke node als de terugval aan staat, met een duidelijke melding", async () => {
    const { own, pub, fetchImpl } = twoNodes();
    own.down = true;
    const n = await connectBitcoinNode({ bitcoinApiUrl: "http://umbrel.local:3006", bitcoinFallbackEnabled: true, bitcoinFallbackUrl: "https://mempool.space/" }, fetchImpl);
    expect(n).toMatchObject({ source: "fallback", tipHeight: 800001 });
    // een .local-naam in een container krijgt de uitleg met het Umbrel-IP mee; daarna de terugvalmelding
    expect(n.warnings[0]).toMatch(/^Eigen node onbereikbaar \(Bitcoin-node umbrel.local:3006 niet bereikbaar \(ECONNREFUSED\).*10\.21\.21\.26:3006\.\); teruggevallen op de publieke node mempool.space/);
    expect(n.warnings[0]).toContain("ziet de adressen van je wallet");
    expect(pub.calls).toContain("/api/blocks/tip/height");
  });

  it("eigen node onbereikbaar en terugval uit → fout van de eigen node", async () => {
    const { own, pub, fetchImpl } = twoNodes();
    own.down = true;
    await expect(connectBitcoinNode({ bitcoinApiUrl: "http://umbrel.local:3006", bitcoinFallbackEnabled: false, bitcoinFallbackUrl: "https://mempool.space" }, fetchImpl)).rejects.toThrow(/umbrel.local:3006 niet bereikbaar \(ECONNREFUSED\).*Umbrel-app/);
    expect(pub.calls).toEqual([]);
  });

  it("geen eigen node ingesteld: fout, of de publieke node als de terugval aan staat", async () => {
    const { pub, fetchImpl } = twoNodes();
    await expect(connectBitcoinNode({ bitcoinApiUrl: "", bitcoinFallbackEnabled: false, bitcoinFallbackUrl: "https://mempool.space" }, fetchImpl)).rejects.toThrow(/Geen Bitcoin-node ingesteld/);
    const n = await connectBitcoinNode({ bitcoinApiUrl: "  ", bitcoinFallbackEnabled: true, bitcoinFallbackUrl: "https://mempool.space" }, fetchImpl);
    expect(n.source).toBe("fallback");
    expect(n.warnings[0]).toMatch(/^Geen eigen node ingesteld; teruggevallen op de publieke node mempool.space/);
    expect(pub.calls.length).toBe(1);
  });

  it("beide onbereikbaar → één melding met beide oorzaken; lege terugval-URL is een instellingsfout", async () => {
    const { own, pub, fetchImpl } = twoNodes();
    own.down = true;
    pub.down = true;
    await expect(connectBitcoinNode({ bitcoinApiUrl: "http://umbrel.local:3006", bitcoinFallbackEnabled: true, bitcoinFallbackUrl: "https://mempool.space" }, fetchImpl)).rejects.toThrow(/Eigen node: .*Publieke node ook niet bereikbaar/);
    await expect(connectBitcoinNode({ bitcoinApiUrl: "http://umbrel.local:3006", bitcoinFallbackEnabled: true, bitcoinFallbackUrl: "" }, fetchImpl)).rejects.toThrow(/Geen Bitcoin-node ingesteld/);
  });
});
