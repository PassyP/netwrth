import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-fx-history-"));

import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { computeHistory } from "@/lib/history";
import { daysBetween, ensureFxCoverage, ensureFxHistory, fxGaps, fxRequestWindows, shiftDays } from "./fx";
import { awaitHistoryCoverage } from "./quotes";

// --- fixtures ------------------------------------------------------------
const NOW = "2026-09-23T12:00:00.000Z"; // woensdag
const TODAY = NOW.slice(0, 10);
const isWeekday = (d: string) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
/** Nep-ECB: een koers op elke werkdag, per dag een andere waarde zodat een verouderde koers opvalt. */
const ecb = (d: string) => {
  const i = daysBetween("2017-01-01", d);
  return { USD: 1 + i / 10000, CHF: 0.9 + i / 20000, GBP: 0.8 + i / 40000 };
};
const ecbDayOnOrBefore = (d: string) => {
  while (!isWeekday(d)) d = shiftDays(d, -1);
  return d;
};

const state = { fail: false };
const calls: string[] = []; // "start..end" of "latest"
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const router = (async (input: URL | RequestInfo) => {
  const url = new URL(typeof input === "string" ? input : (input as URL).toString());
  if (url.hostname === "api.frankfurter.dev") {
    const what = url.pathname.slice("/v1/".length);
    calls.push(what);
    if (state.fail) return new Response("boom", { status: 502 });
    if (what.includes("..")) {
      const [start, end] = what.split("..");
      const rates: Record<string, Record<string, number>> = {};
      for (let d = start; d <= end && d <= TODAY; d = shiftDays(d, 1)) if (isWeekday(d)) rates[d] = ecb(d);
      return json({ base: "EUR", start_date: start, end_date: end, rates });
    }
    return json({ base: "EUR", date: TODAY, rates: ecb(TODAY) });
  }
  return new Response("blocked", { status: 403 }); // Yahoo (BTC-reeks) blijft buiten deze test
}) as typeof fetch;

/** ECB-rijen zoals ratePerEur ze achterlaat: alleen de werkdagen van tien dagen vóór een transactiedag. */
function seedAround(day: string) {
  for (let d = shiftDays(day, -10); d <= day; d = shiftDays(d, 1)) {
    if (!isWeekday(d)) continue;
    for (const [currency, rate] of Object.entries(ecb(d))) {
      getDb().insert(schema.fxRates).values({ date: d, currency, ratePerEur: String(rate) }).onConflictDoNothing().run();
    }
  }
}
const datesOf = (currency: string) =>
  getDb().select({ date: schema.fxRates.date }).from(schema.fxRates).where(eq(schema.fxRates.currency, currency)).orderBy(schema.fxRates.date).all().map((r) => r.date);

let portfolioId: number;
let platformId: number;
let assetId: number;
function addBuy(executedAt: string, quantity: string, price: string) {
  const day = executedAt.slice(0, 10);
  const fxEur = String(1 / ecb(ecbDayOnOrBefore(day)).USD);
  getDb().insert(schema.transactions).values({ portfolioId, assetId, platformId, type: "buy", quantity, price, currency: "USD", fee: "0", executedAt, fxEur, fxUsd: "1", source: "manual", createdAt: NOW }).run();
  seedAround(day);
}
const pointOn = (day: string) => computeHistory(portfolioId).find((p) => p.date === day)!;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  vi.stubGlobal("fetch", router);
  const db = getDb();
  portfolioId = Number(db.insert(schema.portfolios).values({ name: "FX-test", createdAt: NOW }).run().lastInsertRowid);
  platformId = Number(db.insert(schema.platforms).values({ name: "FX-broker", type: "broker" }).run().lastInsertRowid);
  // USD-aandeel met handmatige koersen: geen koersfeed, dus alleen de ECB-reeks doet ertoe
  assetId = Number(db.insert(schema.assets).values({ symbol: "ACME", name: "Acme Corp", category: "stock", currency: "USD", priceSource: "manual", createdAt: NOW }).run().lastInsertRowid);
  addBuy("2025-02-12T15:00:00.000Z", "10", "300");
  addBuy("2026-04-22T15:00:00.000Z", "5", "400");
  addBuy("2026-07-03T15:00:00.000Z", "1", "350");
  seedAround(TODAY); // de koers van vandaag uit de verversronde
  db.insert(schema.priceQuotes).values({ assetId, ts: "2026-04-22T21:00:00.000Z", day: "2026-04-22", price: "400", currency: "USD", source: "manual" }).run();
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// --- gaten vinden ----------------------------------------------------------
describe("fxGaps", () => {
  it("ziet Pasen (do → di) niet als gat, een week zonder koers wel", () => {
    // Goede Vrijdag 2026-04-03, Paasmaandag 2026-04-06
    expect(fxGaps(["2026-03-31", "2026-04-01", "2026-04-02", "2026-04-07", "2026-04-08"], "2026-04-01", "2026-04-08")).toEqual([]);
    // do 2026-04-09 → wo 2026-04-15: vr, ma en di ontbreken
    expect(fxGaps(["2026-04-08", "2026-04-09", "2026-04-15"], "2026-04-08", "2026-04-15")).toEqual([["2026-04-10", "2026-04-14"]]);
  });

  it("zonder rijen: het hele stuk vanaf een week vóór de eerste transactie", () => {
    expect(fxGaps([], "2026-03-01", "2026-03-20")).toEqual([["2026-02-22", "2026-03-20"]]);
  });

  it("zonder koers vlak vóór de eerste transactie: vanaf de marge, niet vanaf een oude rij", () => {
    expect(fxGaps(["2010-01-04", "2018-10-17"], "2018-10-15", "2018-10-17")).toEqual([["2018-10-08", "2018-10-16"]]);
    expect(fxGaps(["2018-10-19"], "2018-10-15", "2018-10-19")).toEqual([["2018-10-08", "2018-10-18"]]);
    // een vrijdagkoers voor een eerste transactie op zondag volstaat
    expect(fxGaps(["2018-10-12", "2018-10-15"], "2018-10-14", "2018-10-15")).toEqual([]);
  });

  it("vult het stuk tot vandaag als de laatste rij meer dan vijf dagen oud is", () => {
    expect(fxGaps(["2026-09-11", "2026-09-14"], "2026-09-11", "2026-09-17")).toEqual([]);
    expect(fxGaps(["2026-09-11", "2026-09-14"], "2026-09-11", "2026-09-21")).toEqual([["2026-09-15", "2026-09-21"]]);
  });
});

describe("fxRequestWindows", () => {
  it("bundelt de gaten van een jaar in één verzoek, ook als elke valuta ze meldt", () => {
    const gaps: [string, string][] = [
      ["2021-02-08", "2021-07-30"],
      ["2021-09-06", "2021-10-01"],
      ["2021-11-15", "2021-12-20"],
    ];
    expect(fxRequestWindows([...gaps, ...gaps, ...gaps].reverse())).toEqual([["2021-02-08", "2021-12-20"]]);
  });

  it("knipt een gat van meer dan een jaar op in aansluitende verzoeken van hoogstens een jaar", () => {
    const w = fxRequestWindows([["2018-01-01", "2020-06-30"]]);
    expect(w).toEqual([
      ["2018-01-01", "2018-12-31"],
      ["2019-01-01", "2019-12-31"],
      ["2020-01-01", "2020-06-30"],
    ]);
  });

  it("begint een nieuw verzoek voor wat buiten het jaar van het vorige valt", () => {
    const gaps: [string, string][] = [
      ["2022-03-14", "2022-08-19"],
      ["2023-02-06", "2023-04-21"], // loopt over het jaar heen
      ["2024-05-06", "2024-05-17"], // ligt er helemaal buiten
    ];
    expect(fxRequestWindows(gaps)).toEqual([
      ["2022-03-14", "2023-03-13"],
      ["2023-03-14", "2023-04-21"],
      ["2024-05-06", "2024-05-17"],
    ]);
  });
});

// --- aanvullen -------------------------------------------------------------
describe("ECB-reeks aanvullen", () => {
  it("de historie rekent in een gat met de laatste koers ervóór, tot de reeks via de historie-route is aangevuld", async () => {
    // midden in het gat 2026-04-22 → 2026-07-03: nog de koers van 22 april
    const staleDay = "2026-06-01";
    expect(Number(pointOn(staleDay).value.EUR)).toBeCloseTo((15 * 400) / ecb("2026-04-22").USD, 2);

    calls.length = 0;
    await awaitHistoryCoverage(5000); // wat /api/history vóór computeHistory doet
    // 2025-02-12 → 2026-04-12 (> een jaar) plus de gaten van 2026 in het tweede verzoek
    expect(calls).toEqual(["2025-02-13..2026-02-12", "2026-02-13..2026-09-13"]);
    for (const ccy of ["USD", "CHF", "GBP"]) expect(fxGaps(datesOf(ccy), "2025-02-12", TODAY)).toEqual([]);
    expect(datesOf("USD")).toContain(staleDay);

    expect(Number(pointOn(staleDay).value.EUR)).toBeCloseTo((15 * 400) / ecb(staleDay).USD, 2);
    // zaterdag: de vrijdagkoers
    expect(Number(pointOn("2026-06-06").value.EUR)).toBeCloseTo((15 * 400) / ecb("2026-06-05").USD, 2);
  });

  it("een gevulde reeks kost geen verzoeken meer", async () => {
    calls.length = 0;
    expect(await ensureFxHistory("2025-02-12")).toBe(0);
    expect(await ensureFxCoverage()).toBe(0);
    expect(calls).toEqual([]);
  });

  it("ensureFxCoverage: een oudere eerste transactie telt als nieuw gat; na een fout pas een uur later opnieuw; gelijktijdige aanroepen delen de run", async () => {
    getDb().insert(schema.transactions).values({ portfolioId, assetId, platformId, type: "buy", quantity: "1", price: "200", currency: "USD", fee: "0", executedAt: "2024-06-03T15:00:00.000Z", fxEur: "0.9", fxUsd: "1", source: "manual", createdAt: NOW }).run();
    calls.length = 0;
    state.fail = true;
    const a = ensureFxCoverage();
    expect(ensureFxCoverage()).toBe(a);
    await expect(a).rejects.toThrow("FX 502");
    expect(calls).toEqual(["2024-05-27..2025-02-02"]);

    expect(await ensureFxCoverage()).toBe(0); // binnen het uur: geen nieuw verzoek
    expect(calls).toHaveLength(1);

    state.fail = false;
    vi.setSystemTime(new Date(Date.parse(NOW) + 61 * 60 * 1000));
    const n = await ensureFxCoverage();
    expect(calls).toEqual(["2024-05-27..2025-02-02", "2024-05-27..2025-02-02"]);
    const added = datesOf("USD").filter((d) => d >= "2024-05-27" && d <= "2025-02-02").length;
    expect(added).toBeGreaterThan(150);
    expect(n).toBe(3 * added); // nieuwe rijen, drie valuta per dag
    expect(fxGaps(datesOf("USD"), "2024-06-03", TODAY)).toEqual([]);

    expect(await ensureFxCoverage()).toBe(0); // klaar voor vandaag
    expect(calls).toHaveLength(2);
  });
});
