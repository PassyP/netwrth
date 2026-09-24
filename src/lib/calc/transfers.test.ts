import { describe, it, expect } from "vitest";
import { processTransactions, type EngineTx } from "./engine";
import { linkInternalTransfers, matchInternalTransfers, type TransferGroup } from "./transfers";

const tx = (p: Partial<EngineTx> & Pick<EngineTx, "id" | "type" | "quantity" | "executedAt">): EngineTx => ({ price: "0", fee: "0", currency: "EUR", fxEur: "1", fxUsd: "1.1", fxBtc: null, ...p });

// Kraken: 2 BTC gekocht à 20 000, 0,5004 BTC opgenomen (incl. 0,0004 opnamekosten); wallet: 0,5 BTC ontvangen à dagkoers 50 000
const kraken: TransferGroup = {
  key: "1-10",
  assetId: 1,
  platformId: 10,
  txs: [tx({ id: 1, type: "buy", quantity: "2", price: "20000", executedAt: "2024-01-01T10:00:00Z" }), tx({ id: 2, type: "transfer_out", quantity: "0.5004", executedAt: "2024-02-01T10:00:00Z" })],
};
const wallet: TransferGroup = { key: "1-20", assetId: 1, platformId: 20, txs: [tx({ id: 3, type: "transfer_in", quantity: "0.5", price: "50000", executedAt: "2024-02-01T10:15:00Z" })] };

describe("engine: transfer_out meldt de meegenomen kostprijs", () => {
  it("gemiddeld en FIFO", () => {
    const avg = processTransactions(kraken.txs, "average");
    expect(avg.transfers).toHaveLength(1);
    expect(avg.transfers[0]).toMatchObject({ txId: 2 });
    expect(avg.transfers[0].quantity.toFixed(4)).toBe("0.5004");
    expect(avg.transfers[0].cost.toFixed(2)).toBe("10008.00");
    expect(avg.transfers[0].costUsd.toFixed(2)).toBe("11008.80");
    expect(avg.cost.toFixed(2)).toBe("29992.00");
    const fifo = processTransactions(kraken.txs, "fifo");
    expect(fifo.transfers[0].cost.toFixed(2)).toBe("10008.00");
  });

  it("een interne transfer_in telt niet mee in de totale inleg, een gewone wel", () => {
    const plain = processTransactions([tx({ id: 3, type: "transfer_in", quantity: "0.5", price: "50000", executedAt: "2024-02-01T10:15:00Z" })], "average");
    expect(plain.totalBuyCost.toFixed(2)).toBe("25000.00");
    const internal = processTransactions([tx({ id: 3, type: "transfer_in", quantity: "0.5", price: "20016", executedAt: "2024-02-01T10:15:00Z", internal: true })], "average");
    expect(internal.totalBuyCost.toFixed(2)).toBe("0.00");
    expect(internal.cost.toFixed(2)).toBe("10008.00");
    expect(internal.lots[0].internal).toBe(true);
  });
});

describe("interne overboekingen koppelen", () => {
  it("matcht een ontvangst aan de opname op een ander platform (hoeveelheid op de kosten na gelijk, binnen het venster)", () => {
    expect(matchInternalTransfers([kraken, wallet])).toEqual([{ assetId: 1, inKey: "1-20", inTxId: 3, outKey: "1-10", outTxId: 2 }]);
  });

  it("geen match: zelfde platform, ander asset, buiten het venster, of te groot verschil in hoeveelheid", () => {
    const samePlatform: TransferGroup = { ...wallet, platformId: 10, key: "1-10b" };
    expect(matchInternalTransfers([kraken, samePlatform])).toEqual([]);
    const otherAsset: TransferGroup = { ...wallet, assetId: 2, key: "2-20" };
    expect(matchInternalTransfers([kraken, otherAsset])).toEqual([]);
    const late: TransferGroup = { ...wallet, txs: [tx({ id: 3, type: "transfer_in", quantity: "0.5", price: "50000", executedAt: "2024-02-05T10:00:01Z" })] };
    expect(matchInternalTransfers([kraken, late])).toEqual([]);
    const early: TransferGroup = { ...wallet, txs: [tx({ id: 3, type: "transfer_in", quantity: "0.5", price: "50000", executedAt: "2024-02-01T07:00:00Z" })] };
    expect(matchInternalTransfers([kraken, early])).toEqual([]);
    const tooSmall: TransferGroup = { ...wallet, txs: [tx({ id: 3, type: "transfer_in", quantity: "0.45", price: "50000", executedAt: "2024-02-01T10:15:00Z" })] };
    expect(matchInternalTransfers([kraken, tooSmall])).toEqual([]);
    const tooBig: TransferGroup = { ...wallet, txs: [tx({ id: 3, type: "transfer_in", quantity: "0.501", price: "50000", executedAt: "2024-02-01T10:15:00Z" })] };
    expect(matchInternalTransfers([kraken, tooBig])).toEqual([]);
  });

  it("elke opname hoogstens één keer; de dichtstbijzijnde in tijd wint", () => {
    const k: TransferGroup = {
      ...kraken,
      txs: [
        tx({ id: 1, type: "buy", quantity: "3", price: "20000", executedAt: "2024-01-01T10:00:00Z" }),
        tx({ id: 2, type: "transfer_out", quantity: "0.5004", executedAt: "2024-02-01T10:00:00Z" }),
        tx({ id: 4, type: "transfer_out", quantity: "0.5004", executedAt: "2024-02-01T12:00:00Z" }),
      ],
    };
    const w: TransferGroup = { ...wallet, txs: [tx({ id: 3, type: "transfer_in", quantity: "0.5", price: "50000", executedAt: "2024-02-01T12:10:00Z" }), tx({ id: 5, type: "transfer_in", quantity: "0.5", price: "50000", executedAt: "2024-02-01T10:20:00Z" })] };
    const m = matchInternalTransfers([k, w]);
    expect(m.map((x) => [x.inTxId, x.outTxId]).sort()).toEqual([
      [3, 4],
      [5, 2],
    ]);
  });

  it("de ontvangst krijgt de kostprijs van de zender (inclusief het fee-deel) en telt niet als nieuwe inleg", () => {
    const { txs, matches } = linkInternalTransfers([kraken, wallet], "average");
    expect(matches).toHaveLength(1);
    const w = processTransactions(txs.get("1-20")!, "average");
    expect(w.cost.toFixed(2)).toBe("10008.00"); // niet 25 000
    expect(w.costUsd.toFixed(2)).toBe("11008.80"); // historische wisselkoers van de aankoop, niet die van de ontvangst
    expect(w.totalBuyCost.toFixed(2)).toBe("0.00");
    expect(w.lots[0].internal).toBe(true);
    const k = processTransactions(txs.get("1-10")!, "average");
    expect(k.cost.toFixed(2)).toBe("29992.00");
    expect(k.cost.plus(w.cost).toFixed(2)).toBe("40000.00"); // totale inleg = de oorspronkelijke aankoop
    expect(txs.get("1-10")).toBe(kraken.txs); // zender ongewijzigd
  });

  it("ketting A → B → C: de kostprijs reist door", () => {
    const a: TransferGroup = { key: "1-1", assetId: 1, platformId: 1, txs: [tx({ id: 1, type: "buy", quantity: "1", price: "10000", executedAt: "2023-01-01T00:00:00Z" }), tx({ id: 2, type: "transfer_out", quantity: "1", executedAt: "2023-06-01T00:00:00Z" })] };
    const b: TransferGroup = {
      key: "1-2",
      assetId: 1,
      platformId: 2,
      txs: [tx({ id: 3, type: "transfer_in", quantity: "1", price: "30000", executedAt: "2023-06-01T01:00:00Z" }), tx({ id: 4, type: "transfer_out", quantity: "1", executedAt: "2024-01-01T00:00:00Z" })],
    };
    const c: TransferGroup = { key: "1-3", assetId: 1, platformId: 3, txs: [tx({ id: 5, type: "transfer_in", quantity: "1", price: "60000", executedAt: "2024-01-01T02:00:00Z" })] };
    const { txs } = linkInternalTransfers([c, b, a], "fifo");
    expect(processTransactions(txs.get("1-3")!, "fifo").cost.toFixed(2)).toBe("10000.00");
    expect(processTransactions(txs.get("1-2")!, "fifo").cost.toFixed(2)).toBe("0.00");
  });

  it("zeroCostIds: een ongematchte ontvangst krijgt kostprijs 0 en telt niet als inleg; een gematchte houdt de meegenomen kostprijs", () => {
    const w: TransferGroup = { ...wallet, txs: [...wallet.txs, tx({ id: 6, type: "transfer_in", quantity: "0.5", price: "60000", executedAt: "2024-03-01T10:00:00Z" })] };
    const { txs } = linkInternalTransfers([kraken, w], "average", { zeroCostIds: new Set([3, 6]) });
    const r = processTransactions(txs.get("1-20")!, "average");
    expect(r.cost.toFixed(2)).toBe("10008.00"); // alleen de meegenomen kostprijs; de externe ontvangst telt 0
    expect(r.totalBuyCost.toFixed(2)).toBe("0.00");
    expect(r.lots.map((l) => [l.txId, l.internal, l.costOpen.toFixed(2)])).toEqual([
      [3, true, "10008.00"],
      [6, true, "0.00"],
    ]);
    // zonder de optie: dagkoers
    const plain = processTransactions(linkInternalTransfers([kraken, w], "average").txs.get("1-20")!, "average");
    expect(plain.cost.toFixed(2)).toBe("40008.00");
    // ook zonder enige match werkt de optie
    const alone = processTransactions(linkInternalTransfers([w], "average", { zeroCostIds: new Set([3, 6]) }).txs.get("1-20")!, "average");
    expect(alone.cost.toFixed(2)).toBe("0.00");
  });

  it("zender zonder kostprijs (staking-reward): ontvangst wordt intern met kostprijs 0", () => {
    const a: TransferGroup = { key: "1-1", assetId: 1, platformId: 1, txs: [tx({ id: 1, type: "staking", quantity: "1", executedAt: "2023-01-01T00:00:00Z" }), tx({ id: 2, type: "transfer_out", quantity: "1", executedAt: "2023-06-01T00:00:00Z" })] };
    const b: TransferGroup = { key: "1-2", assetId: 1, platformId: 2, txs: [tx({ id: 3, type: "transfer_in", quantity: "1", price: "30000", executedAt: "2023-06-01T01:00:00Z" })] };
    const r = processTransactions(linkInternalTransfers([a, b], "average").txs.get("1-2")!, "average");
    expect(r.cost.toFixed(2)).toBe("0.00");
    expect(r.totalBuyCost.toFixed(2)).toBe("0.00");
  });
});
