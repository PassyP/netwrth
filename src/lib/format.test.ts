import { describe, it, expect } from "vitest";
import { MASK, formatMoney, formatPrice, formatQuantity, maskNumbers } from "./format";

describe("Bedragen verbergen", () => {
  it("formatMoney: vast masker met valutateken en teken, ongeacht de grootte van het bedrag", () => {
    expect(formatMoney("1234567.89", "EUR", { hidden: true })).toBe(`€${MASK}`);
    expect(formatMoney("0.5", "EUR", { hidden: true })).toBe(`€${MASK}`);
    expect(formatMoney("-12.5", "USD", { hidden: true })).toBe(`−$${MASK}`);
    expect(formatMoney("42", "EUR", { hidden: true, sign: true })).toBe(`+€${MASK}`);
    expect(formatMoney("0.0123", "BTC", { hidden: true })).toBe(`₿${MASK}`);
    expect(formatMoney("100", "CHF", { hidden: true })).toBe(`CHF ${MASK}`);
  });

  it("zonder hidden blijft de uitvoer ongewijzigd", () => {
    expect(formatMoney("1234567.891", "EUR")).toBe("€1.234.567,89");
    expect(formatMoney("-12.5", "USD", { sign: true })).toBe("−$12,50");
    expect(formatMoney("42", "EUR", { sign: true, decimals: 0 })).toBe("+€42");
    expect(formatMoney("0.0123", "BTC")).toBe("₿0,01230000");
    expect(formatQuantity("1234.5")).toBe("1.234,5");
    expect(formatPrice("0.5", "EUR")).toBe("€0,5000");
    expect(formatPrice("95123.4567", "EUR")).toBe("€95.123,46");
  });

  it("formatQuantity en formatPrice", () => {
    expect(formatQuantity("0.53", { hidden: true })).toBe(MASK);
    expect(formatPrice("95123.4567", "EUR", { decimals: 4 })).toBe("€95.123,4567");
    expect(formatPrice("123456", "EUR", { hidden: true })).toBe(`€${MASK}`);
  });

  it("maskNumbers: elk getal in vrije tekst wordt het masker", () => {
    expect(maskNumbers("Verbinding OK: 3 open posities, kas $1234.56")).toBe(`Verbinding OK: ${MASK} open posities, kas $${MASK}`);
    expect(maskNumbers("BTC: app 0.53000000, platform 0.54000000")).toBe(`BTC: app ${MASK}, platform ${MASK}`);
    expect(maskNumbers("Minerfee 0,00001234 BTC · −12,5")).toBe(`Minerfee ${MASK} BTC · −${MASK}`);
    expect(maskNumbers("1e-8 verkocht")).toBe(`${MASK}e-${MASK} verkocht`);
    expect(maskNumbers("geen getallen hier")).toBe("geen getallen hier");
  });
});
