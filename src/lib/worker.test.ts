import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pm-worker-"));

import { intervalCron } from "./worker";

describe("intervalCron", () => {
  it("vertaalt een interval in minuten naar een cron-expressie", () => {
    expect(intervalCron(0)).toBeNull();
    expect(intervalCron(-5)).toBeNull();
    expect(intervalCron(Number.NaN)).toBeNull();
    expect(intervalCron(1)).toBe("*/1 * * * *");
    expect(intervalCron(10)).toBe("*/10 * * * *");
    expect(intervalCron(59)).toBe("*/59 * * * *");
    expect(intervalCron(60)).toBe("0 */1 * * *");
    expect(intervalCron(90)).toBe("0 */2 * * *");
    expect(intervalCron(360)).toBe("0 */6 * * *");
    expect(intervalCron(1440)).toBe("0 0 * * *");
  });
});
