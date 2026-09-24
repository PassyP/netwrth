import { describe, it, expect, afterEach, vi } from "vitest";
import { getQuote } from "./yahoo";

// Fictieve antwoorden van de v8-chart (range=5d&interval=1d) in de vorm die Yahoo levert: meta met chartPreviousClose
// (de slot vóór het hele venster), timestamp[] met de opening van elke handelsdag en indicators.quote[0].close[], waar
// soms een null tussen staat.
const t = (iso: string) => Date.parse(iso) / 1000;

interface Chart {
  meta: Record<string, unknown>;
  timestamp?: number[];
  closes?: (number | null)[];
}

function chartBody({ meta, timestamp, closes }: Chart) {
  const indicators = closes && {
    quote: [{ open: closes, high: closes, low: closes, close: closes, volume: closes.map((c) => (c == null ? null : 1000)) }],
    adjclose: [{ adjclose: closes }],
  };
  return { chart: { result: [{ meta: { dataGranularity: "1d", range: "5d", ...meta }, ...(timestamp && { timestamp }), ...(indicators && { indicators }) }], error: null } };
}

const requests: URL[] = [];
function serve(chart: Chart) {
  vi.stubGlobal("fetch", async (input: URL | RequestInfo) => {
    requests.push(new URL(typeof input === "string" ? input : (input as URL).toString()));
    return new Response(JSON.stringify(chartBody(chart)), { status: 200, headers: { "content-type": "application/json" } });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  requests.length = 0;
});

// ETF op Xetra (CEST): candles om 09:00 lokaal = 07:00 UTC, vr 5 t/m do 11 juni 2026
const XETRA = { currency: "EUR", symbol: "ETFX.DE", exchangeName: "GER", fullExchangeName: "XETRA", instrumentType: "ETF", gmtoffset: 7200, timezone: "CEST", exchangeTimezoneName: "Europe/Berlin", longName: "Voorbeeld Wereld ETF" };
const XETRA_DAYS = ["2026-06-05", "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11"].map((d) => t(`${d}T07:00:00Z`));

describe("Yahoo getQuote: vorige slot", () => {
  it("neemt de slot van de vorige handelsdag, niet chartPreviousClose (de slot vóór het venster van vijf dagen)", async () => {
    serve({ meta: { ...XETRA, regularMarketPrice: 51.1, regularMarketTime: t("2026-06-11T15:35:00Z"), chartPreviousClose: 50 }, timestamp: XETRA_DAYS, closes: [50.4, 51.2, 51.6, 51.8, 51.1] });
    const q = await getQuote("ETFX.DE");
    expect(q).toEqual({ symbol: "ETFX.DE", price: 51.1, previousClose: 51.8, currency: "EUR", time: "2026-06-11T15:35:00.000Z", name: "Voorbeeld Wereld ETF", exchange: "GER" });
    expect(requests[0].pathname).toBe("/v8/finance/chart/ETFX.DE");
    expect(Object.fromEntries(requests[0].searchParams)).toEqual({ range: "5d", interval: "1d" });
  });

  it("slaat een lege slot (null) over: dan telt de laatste handelsdag daarvóór", async () => {
    serve({ meta: { ...XETRA, regularMarketPrice: 51.1, regularMarketTime: t("2026-06-11T15:35:00Z"), chartPreviousClose: 50 }, timestamp: XETRA_DAYS, closes: [50.4, 51.2, 51.6, null, 51.1] });
    const q = await getQuote("ETFX.DE");
    expect(q.previousClose).toBe(51.6); // dinsdag; met chartPreviousClose stond hier +2,2% in plaats van −1,0%
  });

  it("vóór de opening telt de sessie van regularMarketTime, ook als de candle van vandaag al leeg in de reeks staat", async () => {
    const days = [...XETRA_DAYS.slice(0, 4), t("2026-06-11T06:00:00Z")]; // do 08:00 lokaal, beurs nog dicht
    serve({ meta: { ...XETRA, regularMarketPrice: 51.8, regularMarketTime: t("2026-06-10T15:35:00Z"), chartPreviousClose: 50 }, timestamp: days, closes: [50.4, 51.2, 51.6, 51.8, null] });
    const q = await getQuote("ETFX.DE");
    expect(q).toMatchObject({ price: 51.8, previousClose: 51.6 }); // de verandering van woensdag, tot de beurs opent
  });

  it("crypto handelt 24/7 met candles om 00:00 UTC: de vorige slot is die van gisteren, ook net na middernacht", async () => {
    const coin = { currency: "EUR", symbol: "XYZ-EUR", exchangeName: "CCC", fullExchangeName: "CCC", instrumentType: "CRYPTOCURRENCY", gmtoffset: 0, timezone: "UTC", exchangeTimezoneName: "UTC", shortName: "Xyz EUR", chartPreviousClose: 11 };
    const days = ["2026-06-06", "2026-06-07", "2026-06-08", "2026-06-09", "2026-06-10"].map((d) => t(`${d}T00:00:00Z`)); // za t/m wo, weekend incluis
    serve({ meta: { ...coin, regularMarketPrice: 12.5, regularMarketTime: t("2026-06-10T10:15:00Z") }, timestamp: days, closes: [11.2, 11.6, 11.9, 12.1, 12.5] });
    expect(await getQuote("XYZ-EUR")).toMatchObject({ price: 12.5, previousClose: 12.1 });

    // twee minuten na middernacht, nog zonder candle voor de nieuwe dag: de slot van gisteren blijft de referentie
    serve({ meta: { ...coin, regularMarketPrice: 12.12, regularMarketTime: t("2026-06-10T00:02:00Z") }, timestamp: [t("2026-06-05T00:00:00Z"), ...days.slice(0, 4)], closes: [11.4, 11.2, 11.6, 11.9, 12.1] });
    expect(await getQuote("XYZ-EUR")).toMatchObject({ price: 12.12, previousClose: 12.1 });
  });

  it("dagen tellen in de tijdzone van de beurs: in Sydney opent de candle in UTC op de avond ervoor", async () => {
    // ASX in AEDT (UTC+11): opening 10:00 lokaal = 23:00 UTC de dag ervoor; ma 12 t/m vr 16 januari 2026
    const days = ["2026-01-11", "2026-01-12", "2026-01-13", "2026-01-14", "2026-01-15"].map((d) => t(`${d}T23:00:00Z`));
    serve({
      meta: { currency: "AUD", symbol: "ABCD.AX", exchangeName: "ASX", instrumentType: "EQUITY", gmtoffset: 39600, timezone: "AEDT", exchangeTimezoneName: "Australia/Sydney", regularMarketPrice: 8.25, regularMarketTime: t("2026-01-16T05:10:00Z"), chartPreviousClose: 7.9 },
      timestamp: days,
      closes: [8, 8.1, 8.2, 8.3, 8.25],
    });
    expect(await getQuote("ABCD.AX")).toMatchObject({ price: 8.25, previousClose: 8.3, currency: "AUD" }); // in UTC-dagen zou de eigen candle van vrijdag als vorige slot gelden
  });

  it("rekent pence om naar pond, ook voor de vorige slot", async () => {
    const days = ["2026-06-05", "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11"].map((d) => t(`${d}T07:00:00Z`)); // 08:00 BST
    serve({ meta: { currency: "GBp", symbol: "ABC.L", exchangeName: "LSE", gmtoffset: 3600, timezone: "BST", exchangeTimezoneName: "Europe/London", regularMarketPrice: 1250, regularMarketTime: t("2026-06-11T15:30:00Z"), chartPreviousClose: 1200 }, timestamp: days, closes: [1210, 1220, 1230, 1240, 1250] });
    expect(await getQuote("ABC.L")).toMatchObject({ price: 12.5, previousClose: 12.4, currency: "GBP" });
  });

  it("zonder eerdere slot in het venster: meta.previousClose, dan chartPreviousClose, anders geen", async () => {
    const at = { regularMarketTime: t("2026-06-11T15:35:00Z") };
    // nieuwe notering: alleen de candle van vandaag; chartPreviousClose is de uitgifteprijs
    serve({ meta: { ...XETRA, ...at, regularMarketPrice: 20.4, chartPreviousClose: 20 }, timestamp: [XETRA_DAYS[4]], closes: [20.4] });
    expect((await getQuote("ETFX.DE")).previousClose).toBe(20);
    // alle eerdere slots leeg: de laatst bekende slot is die vóór het venster
    serve({ meta: { ...XETRA, ...at, regularMarketPrice: 51.1, chartPreviousClose: 50 }, timestamp: XETRA_DAYS, closes: [null, null, null, null, 51.1] });
    expect((await getQuote("ETFX.DE")).previousClose).toBe(50);
    // geen candles in het antwoord: meta.previousClose (de echte vorige slot) gaat voor chartPreviousClose
    serve({ meta: { ...XETRA, ...at, regularMarketPrice: 20.4, previousClose: 19.5, chartPreviousClose: 18 } });
    expect((await getQuote("ETFX.DE")).previousClose).toBe(19.5);
    serve({ meta: { ...XETRA, ...at, regularMarketPrice: 20.4 } });
    expect(await getQuote("ETFX.DE")).toMatchObject({ price: 20.4, previousClose: null });
  });
});
