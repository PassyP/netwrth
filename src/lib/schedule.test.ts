import { describe, it, expect } from "vitest";
import { INTERVAL_PRESETS, dailyCron, describeInterval, formatNextRun, intervalCron, isPresetInterval, isValidTimeZone, nextRun, presetLabel } from "./schedule";

const TZ = "Europe/Amsterdam";

describe("presets sluiten precies aan op intervalCron", () => {
  it("elke preset verdeelt de klok gelijkmatig: delers van 60 minuten of van 24 uur", () => {
    for (const m of INTERVAL_PRESETS) {
      if (m === 0) {
        expect(intervalCron(m)).toBeNull();
        continue;
      }
      const cron = intervalCron(m)!;
      if (m < 60) {
        expect(60 % m).toBe(0);
        expect(cron).toBe(`*/${m} * * * *`);
      } else if (m < 1440) {
        expect(m % 60).toBe(0);
        expect(24 % (m / 60)).toBe(0);
        expect(cron).toBe(`0 */${m / 60} * * *`);
      } else {
        expect(cron).toBe("0 0 * * *");
      }
    }
  });

  it("labels van de presets", () => {
    expect(presetLabel(0)).toBe("Alleen dagelijkse ronde en handmatig");
    expect(presetLabel(10)).toBe("Elke 10 min");
    expect(presetLabel(60)).toBe("Elk uur");
    expect(presetLabel(360)).toBe("Elke 6 uur");
    expect(presetLabel(1440)).toBe("Dagelijks om 00:00");
    expect(isPresetInterval(60)).toBe(true);
    expect(isPresetInterval(90)).toBe(false);
  });
});

describe("describeInterval: afwijkende waarden worden niet stil omgezet", () => {
  it("preset", () => {
    expect(describeInterval(60)).toEqual({ label: "Elk uur", custom: false, note: null });
  });
  it("45 minuten draait om :00 en :45 (cron telt vanaf het hele uur)", () => {
    expect(describeInterval(45)).toEqual({ label: "Aangepast: elke 45 min", custom: true, note: "draait om :00 en :45 van elk uur" });
  });
  it("7 minuten: te veel tijdstippen om op te noemen", () => {
    expect(describeInterval(7).note).toBe("telt elk heel uur opnieuw vanaf :00");
  });
  it("90 minuten wordt elke 2 uur, 300 minuten elke 5 uur met een onregelmatig uur", () => {
    expect(describeInterval(90)).toEqual({ label: "Aangepast: 90 min", custom: true, note: "wordt elke 2 uur" });
    expect(describeInterval(300).note).toBe("wordt elke 5 uur, om 0, 5, 10, 15 en 20 uur");
  });
  it("2000 minuten wordt dagelijks", () => {
    expect(describeInterval(2000).note).toBe("wordt dagelijks om 00:00");
  });
});

describe("nextRun en formatNextRun", () => {
  // 24 september 2026, 10:07 in Amsterdam (zomertijd, UTC+2)
  const now = new Date("2026-09-24T08:07:30.000Z");

  it("elk uur: het volgende hele uur", () => {
    const next = nextRun(intervalCron(60)!, now, TZ)!;
    expect(next.toISOString()).toBe("2026-09-24T09:00:00.000Z");
    expect(formatNextRun(next, now, TZ)).toBe("11:00");
  });

  it("elke 10 minuten", () => {
    expect(nextRun(intervalCron(10)!, now, TZ)!.toISOString()).toBe("2026-09-24T08:10:00.000Z");
  });

  it("elke 6 uur in de lokale tijd (12:00 Amsterdam)", () => {
    expect(nextRun(intervalCron(360)!, now, TZ)!.toISOString()).toBe("2026-09-24T10:00:00.000Z");
  });

  it("dagelijkse ronde en middernacht: morgen", () => {
    const round = nextRun(dailyCron("23:45"), now, TZ)!;
    expect(formatNextRun(round, now, TZ)).toBe("23:45");
    const midnight = nextRun(intervalCron(1440)!, now, TZ)!;
    expect(midnight.toISOString()).toBe("2026-09-24T22:00:00.000Z");
    expect(formatNextRun(midnight, now, TZ)).toBe("morgen 00:00");
  });

  it("morgen blijft morgen rond de zomertijdwissel (dagen van 25 en 23 uur)", () => {
    const fallBack = new Date("2026-10-24T22:30:00.000Z"); // 25 okt 00:30 zomertijd
    const midnight = nextRun(intervalCron(1440)!, fallBack, TZ)!;
    expect(midnight.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(formatNextRun(midnight, fallBack, TZ)).toBe("morgen 00:00");
    const springForward = new Date("2026-03-28T22:50:00.000Z"); // 28 mrt 23:50 wintertijd
    const round = nextRun(dailyCron("23:45"), springForward, TZ)!;
    expect(round.toISOString()).toBe("2026-03-29T21:45:00.000Z");
    expect(formatNextRun(round, springForward, TZ)).toBe("morgen 23:45");
  });

  it("volgt de tijdzone", () => {
    expect(nextRun(dailyCron("08:00"), now, "UTC")!.toISOString()).toBe("2026-09-25T08:00:00.000Z");
    expect(nextRun(dailyCron("08:00"), now, TZ)!.toISOString()).toBe("2026-09-25T06:00:00.000Z");
  });

  it("onbekende cron-vorm → null", () => {
    expect(nextRun("0 0 1 * *", now, TZ)).toBeNull();
  });
});

describe("isValidTimeZone", () => {
  it("herkent IANA-namen", () => {
    expect(isValidTimeZone("Europe/Amsterdam")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
