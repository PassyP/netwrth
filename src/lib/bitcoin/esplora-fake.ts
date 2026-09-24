/**
 * Nep-node voor tests: simuleert de Esplora/mempool-REST-API (adresstatistieken, adrestransacties met paginering,
 * blokhoogte) op basis van een lijst transacties. Alleen voor tests; wordt niet door de app geïmporteerd.
 */
import type { EsploraAddressStats, EsploraStats, EsploraTx } from "./esplora";

export interface FakeTxInput {
  txid: string;
  /** inputs: adres null = coinbase */
  inputs: { address: string | null; value: number }[];
  outputs: { address: string; value: number }[];
  /** null/undefined = onbevestigd (mempool) */
  height?: number | null;
  /** unix-seconden; standaard afgeleid van de hoogte */
  time?: number;
}

const emptyStats = (): EsploraStats => ({ funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 });

export class FakeEsplora {
  tip = 800000;
  pageSize = 25;
  /** welke vervolgpaginering de node kent: "query" (?after_txid, mempool-backend), "path" (/txs/chain/:txid, Esplora) of beide */
  paging: "query" | "path" | "both" = "both";
  /** aantal mislukte fetches vóór een succesvol antwoord (simuleert time-outs) */
  failFirst = 0;
  /** simuleer een uitgevallen node */
  down = false;
  /** HTTP-status voor adres-endpoints (bijv. 501 zonder Electrs) */
  addressStatus: number | null = null;
  calls: string[] = [];
  txs: EsploraTx[] = [];

  constructor(readonly baseUrl = "http://node.test:3006") {}

  addTx(t: FakeTxInput): EsploraTx {
    const inSum = t.inputs.reduce((s, i) => s + i.value, 0);
    const outSum = t.outputs.reduce((s, o) => s + o.value, 0);
    const coinbase = t.inputs.some((i) => i.address === null);
    const height = t.height ?? null;
    const tx: EsploraTx = {
      txid: t.txid,
      vin: t.inputs.map((i, n) => ({ txid: `${t.txid}-in${n}`, vout: 0, is_coinbase: i.address === null, prevout: i.address === null ? null : { scriptpubkey_address: i.address, value: i.value } })),
      vout: t.outputs.map((o) => ({ scriptpubkey_address: o.address, value: o.value })),
      fee: coinbase ? 0 : inSum - outSum,
      status: height == null ? { confirmed: false } : { confirmed: true, block_height: height, block_time: t.time ?? 1_600_000_000 + height * 600 },
    };
    this.txs.push(tx);
    return tx;
  }

  /** bevestig een mempool-transactie */
  confirm(txid: string, height: number, time?: number) {
    const tx = this.txs.find((t) => t.txid === txid)!;
    tx.status = { confirmed: true, block_height: height, block_time: time ?? 1_600_000_000 + height * 600 };
  }

  private touches(tx: EsploraTx, address: string): boolean {
    return tx.vin.some((v) => v.prevout?.scriptpubkey_address === address) || tx.vout.some((o) => o.scriptpubkey_address === address);
  }

  stats(address: string): EsploraAddressStats {
    const chain = emptyStats();
    const mempool = emptyStats();
    for (const tx of this.txs) {
      if (!this.touches(tx, address)) continue;
      const s = tx.status.confirmed ? chain : mempool;
      s.tx_count++;
      for (const o of tx.vout) {
        if (o.scriptpubkey_address === address) {
          s.funded_txo_count++;
          s.funded_txo_sum += o.value;
        }
      }
      for (const v of tx.vin) {
        if (v.prevout?.scriptpubkey_address === address) {
          s.spent_txo_count++;
          s.spent_txo_sum += v.prevout.value;
        }
      }
    }
    return { address, chain_stats: chain, mempool_stats: mempool };
  }

  /** nieuwste eerst: mempool, dan bevestigd op aflopende hoogte */
  history(address: string): { mempool: EsploraTx[]; chain: EsploraTx[] } {
    const list = this.txs.filter((t) => this.touches(t, address));
    return {
      mempool: list.filter((t) => !t.status.confirmed),
      chain: list.filter((t) => t.status.confirmed).sort((a, b) => (b.status.block_height ?? 0) - (a.status.block_height ?? 0) || a.txid.localeCompare(b.txid)),
    };
  }

  readonly fetch: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : (input as URL).toString());
    this.calls.push(url.pathname + url.search);
    if (this.down || this.failFirst > 0) {
      if (this.failFirst > 0) this.failFirst--;
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = { code: this.down ? "ECONNREFUSED" : "ETIMEDOUT" };
      throw err;
    }
    if (`${url.protocol}//${url.host}` !== this.baseUrl) return new Response("blocked", { status: 403 });
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/blocks/tip/height") return new Response(String(this.tip), { status: 200 });
    const m = url.pathname.match(/^\/api\/address\/([^/]+)(\/txs(?:\/chain(?:\/([^/]+))?)?)?$/);
    if (m) {
      if (this.addressStatus) return new Response("Not implemented", { status: this.addressStatus });
      const address = m[1];
      if (!m[2]) return json(this.stats(address));
      const h = this.history(address);
      const pageAfter = (after: string) => {
        const idx = h.chain.findIndex((t) => t.txid === after);
        return json(idx < 0 ? [] : h.chain.slice(idx + 1, idx + 1 + this.pageSize));
      };
      if (m[2].startsWith("/txs/chain")) {
        if (this.paging === "query") return new Response("not found", { status: 404 });
        return m[3] ? pageAfter(m[3]) : json(h.chain.slice(0, this.pageSize));
      }
      const after = url.searchParams.get("after_txid");
      if (!after || this.paging === "path") return json([...h.mempool, ...h.chain.slice(0, this.pageSize)]); // Esplora negeert de query
      return pageAfter(after);
    }
    return new Response("<html>not found</html>", { status: 404 });
  };
}
