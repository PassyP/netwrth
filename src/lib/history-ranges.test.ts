import { describe, it, expect } from "vitest";
import { rangeDays } from "./history-ranges";

const DAYS = { "1W": 7, "1J": 365, "5J": 1826, Alles: null };

describe("rangeDays", () => {
  it("geeft de dagen van een bekende periode; Alles blijft null, ook met een fallback", () => {
    expect(rangeDays(DAYS, "1W", 365)).toBe(7);
    expect(rangeDays(DAYS, "5J", 365)).toBe(1826);
    expect(rangeDays(DAYS, "Alles", 365)).toBeNull();
  });

  it("geeft voor een onbekende periode de fallback", () => {
    expect(rangeDays(DAYS, "2X", 365)).toBe(365);
    expect(rangeDays(DAYS, "alles", 365)).toBe(365);
    expect(rangeDays(DAYS, "", 365)).toBe(365);
    expect(rangeDays(DAYS, "2X", null)).toBeNull();
  });

  it("negeert sleutels van Object.prototype", () => {
    for (const r of ["constructor", "__proto__", "toString"]) expect(rangeDays(DAYS, r, 365), r).toBe(365);
  });
});
