import { describe, it, expect } from "vitest";
import { TX_FORM_TYPES, TX_GROUPS, isMainType, parseDecimal, txAmounts, txLayout, txTotal, txVisible, validateTx, type TxLayout, type TxType } from "./tx-form";

const noKeep = { price: false, fee: false };
const base = { hasAsset: true, hasPlatform: true, addingWallet: false, executedAt: "2026-01-15T09:30" };

function check(type: TxType, values: { quantity?: string; price?: string; fee?: string }, opts: { category?: string; layout?: TxLayout } = {}) {
  const layout = opts.layout ?? txLayout(type, opts.category ?? "stock", "coin");
  const visible = txVisible(layout, noKeep, false);
  const v = { quantity: "", price: "", fee: "", ...values };
  return validateTx({ ...base, ...v, layout, visible });
}

describe("transactieformulier: soorten", () => {
  it("elke soort staat in precies één groep; alleen Handel en Geld staan open", () => {
    const grouped = TX_GROUPS.flatMap((g) => g.types);
    expect([...grouped].sort()).toEqual([...TX_FORM_TYPES].sort());
    expect(TX_GROUPS.filter((g) => g.main).map((g) => g.label)).toEqual(["Handel", "Geld"]);
    expect(isMainType("fee")).toBe(true);
    expect(isMainType("dividend")).toBe(false);
    expect(isMainType("transfer_out")).toBe(false);
  });
});

describe("transactieformulier: velden per soort", () => {
  it("aankoop en verkoop: aantal, prijs per stuk en kosten", () => {
    const l = txLayout("buy", "stock", "coin");
    expect(l).toMatchObject({ asset: true, quantity: true, price: true, priceLabel: "Prijs per stuk", fee: "show" });
  });

  it("vastgoed: geen aantal (vast 1), labels per soort", () => {
    expect(txLayout("buy", "real_estate", "coin")).toMatchObject({ quantity: false, quantityIsOne: true, priceLabel: "Aankoopprijs", feeLabel: "Aankoopkosten" });
    expect(txLayout("sell", "real_estate", "coin")).toMatchObject({ priceLabel: "Verkoopprijs", feeLabel: "Verkoopkosten" });
    // het oude formulier toonde hier "Aankoopprijs"; huur of dividend is gewoon een bedrag
    expect(txLayout("dividend", "real_estate", "coin")).toMatchObject({ priceLabel: "Bedrag", feeLabel: "Kosten", quantityIsOne: false });
  });

  it("overboeking uit: alleen het aantal; overboeking in: kostprijs mag leeg", () => {
    expect(txLayout("transfer_out", "crypto", "coin")).toMatchObject({ quantity: true, price: false, fee: "none" });
    expect(txLayout("transfer_in", "crypto", "coin")).toMatchObject({ quantity: true, price: true, priceRequired: false, priceLabel: "Kostprijs per stuk" });
  });

  it("staking in crypto: munt of geld; anders alleen een bedrag", () => {
    expect(txLayout("staking", "crypto", "coin")).toMatchObject({ stakeChoice: true, quantity: true, price: false, fee: "none" });
    expect(txLayout("staking", "crypto", "cash")).toMatchObject({ stakeChoice: true, quantity: false, price: true, fee: "link" });
    expect(txLayout("staking", "etf", "coin")).toMatchObject({ stakeChoice: false, quantity: false, price: true });
  });

  it("geldsoorten: geen asset; bij 'Kosten' geen apart kostenveld", () => {
    expect(txLayout("deposit", undefined, "coin")).toMatchObject({ asset: false, price: true, fee: "link" });
    expect(txLayout("fee", undefined, "coin")).toMatchObject({ asset: false, price: true, fee: "none" });
  });

  it("bestaande bedragen blijven zichtbaar bij bewerken", () => {
    const out = txLayout("transfer_out", "crypto", "coin");
    expect(txVisible(out, noKeep, false)).toEqual({ quantity: true, price: false, fee: false });
    expect(txVisible(out, { price: true, fee: true }, false)).toEqual({ quantity: true, price: true, fee: true });
    const div = txLayout("dividend", "stock", "coin");
    expect(txVisible(div, noKeep, false).fee).toBe(false);
    expect(txVisible(div, noKeep, true).fee).toBe(true);
  });
});

describe("transactieformulier: controle", () => {
  it("leest getallen zoals de server", () => {
    expect(parseDecimal("105,20")?.toString()).toBe("105.2");
    expect(parseDecimal(" 3 ")?.toString()).toBe("3");
    expect(parseDecimal("-1")?.toString()).toBe("-1");
    expect(parseDecimal("1.234,56")).toBeNull(); // duizendtallen kent de server niet
    expect(parseDecimal("abc")).toBeNull();
    expect(parseDecimal("")).toBeNull();
  });

  it("aankoop vraagt asset, aantal en een prijs boven 0", () => {
    expect(check("buy", {})).toMatchObject({ quantity: "Vul het aantal in.", price: "Vul de prijs per stuk in." });
    expect(check("buy", { quantity: "0", price: "0" })).toMatchObject({ quantity: "Het aantal moet groter dan 0 zijn.", price: "De prijs per stuk moet groter dan 0 zijn." });
    expect(check("buy", { quantity: "1.000,5", price: "12,50" }).quantity).toMatch(/Geen geldig aantal/);
    expect(check("buy", { quantity: "2", price: "12,50" })).toEqual({});
    const l = txLayout("buy", "stock", "coin");
    expect(validateTx({ ...base, hasAsset: false, quantity: "2", price: "1", fee: "", layout: l, visible: txVisible(l, noKeep, false) })).toEqual({ asset: "Kies een asset." });
  });

  it("bedrag moet boven 0; kosten alleen een geldig getal", () => {
    expect(check("deposit", { price: "0" }, { category: undefined })).toEqual({ price: "Het bedrag moet groter dan 0 zijn." });
    expect(check("buy", { quantity: "1", price: "10", fee: "twee" }).fee).toMatch(/Geen geldig bedrag/);
    expect(check("buy", { quantity: "1", price: "10", fee: "" })).toEqual({});
  });

  it("overboeking in mag zonder kostprijs, maar niet met een ongeldige", () => {
    expect(check("transfer_in", { quantity: "0,5" }, { category: "crypto" })).toEqual({});
    expect(check("transfer_in", { quantity: "0,5", price: "-3" }, { category: "crypto" })).toEqual({ price: "Mag niet negatief zijn." });
  });

  it("platform en datum", () => {
    const l = txLayout("deposit", undefined, "coin");
    const vis = txVisible(l, noKeep, false);
    expect(validateTx({ ...base, hasPlatform: false, quantity: "", price: "5", fee: "", layout: l, visible: vis })).toEqual({ platform: "Kies een platform of voeg een wallet toe." });
    expect(validateTx({ ...base, addingWallet: true, quantity: "", price: "5", fee: "", layout: l, visible: vis }).platform).toMatch(/nieuwe wallet/);
    expect(validateTx({ ...base, executedAt: "", quantity: "", price: "5", fee: "", layout: l, visible: vis })).toEqual({ executedAt: "Vul een datum en tijd in." });
  });
});

describe("transactieformulier: totaal en wat er naar de API gaat", () => {
  const totalOf = (type: TxType, v: { quantity?: string; price?: string; fee?: string }, category = "stock", feeOpened = false) => {
    const layout = txLayout(type, category, "coin");
    const t = txTotal(type, txVisible(layout, noKeep, feeOpened), { quantity: "", price: "", fee: "", ...v });
    return t && { label: t.label, value: t.value?.toString() ?? null };
  };

  it("rekent zoals de engine", () => {
    expect(totalOf("buy", { quantity: "10", price: "105,20", fee: "1" })).toEqual({ label: "Totaal betaald", value: "1053" });
    expect(totalOf("sell", { quantity: "5", price: "190,40", fee: "1" })).toEqual({ label: "Opbrengst na kosten", value: "951" });
    expect(totalOf("sell", { quantity: "5", price: "190,40" })).toEqual({ label: "Opbrengst", value: "952" });
    expect(totalOf("buy", { price: "250000", fee: "9000" }, "real_estate")).toEqual({ label: "Totaal betaald", value: "259000" });
    expect(totalOf("dividend", { price: "12,35", fee: "1,85" }, "stock", true)).toEqual({ label: "Netto ontvangen", value: "10.5" });
    expect(totalOf("buy", { quantity: "10" })).toEqual({ label: "Totaal betaald", value: null });
  });

  it("geen totaalregel als er niets te rekenen valt", () => {
    expect(totalOf("dividend", { price: "12,35" })).toBeNull();
    expect(totalOf("transfer_out", { quantity: "0,5" }, "crypto")).toBeNull();
  });

  it("staking met een bestaand aantal én bedrag: het bedrag is geen prijs per stuk", () => {
    const layout = txLayout("staking", "crypto", "coin");
    const values = { quantity: "0.001", price: "30", fee: "" };
    expect(txTotal("staking", txVisible(layout, { price: true, fee: false }, false), values)).toBeNull();
    const withFee = txTotal("staking", txVisible(layout, { price: true, fee: true }, false), { ...values, fee: "1" });
    expect(withFee && { label: withFee.label, value: withFee.value?.toString() }).toEqual({ label: "Netto ontvangen", value: "29" });
  });

  it("verborgen velden gaan als 0, vastgoed met aantal 1", () => {
    const amounts = (type: TxType, category: string | undefined, v: { quantity?: string; price?: string; fee?: string }, stakeIn: "coin" | "cash" = "coin") => {
      const layout = txLayout(type, category, stakeIn);
      return txAmounts(layout, txVisible(layout, noKeep, false), { quantity: "", price: "", fee: "", ...v });
    };
    expect(amounts("buy", "stock", { quantity: " 10 ", price: "105,20", fee: "" })).toEqual({ quantity: "10", price: "105,20", fee: "0" });
    expect(amounts("buy", "real_estate", { quantity: "7", price: "250000", fee: "9000" })).toEqual({ quantity: "1", price: "250000", fee: "9000" });
    expect(amounts("transfer_out", "crypto", { quantity: "0,5", price: "40000", fee: "0,0001" })).toEqual({ quantity: "0,5", price: "0", fee: "0" });
    expect(amounts("staking", "crypto", { quantity: "0,01", price: "300" })).toEqual({ quantity: "0,01", price: "0", fee: "0" });
    expect(amounts("staking", "crypto", { quantity: "0,01", price: "300" }, "cash")).toEqual({ quantity: "0", price: "300", fee: "0" });
    expect(amounts("dividend", "stock", { quantity: "3", price: "12,35", fee: "1" })).toEqual({ quantity: "0", price: "12,35", fee: "0" });
  });
});
