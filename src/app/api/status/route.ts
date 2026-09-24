import { handler, json } from "@/lib/api";
import { isAuthorized, readSessionCookie } from "@/lib/auth";
import { getDb, schema } from "@/lib/db";
import { etoroConfigured } from "@/lib/prices/etoro";
import { desc } from "drizzle-orm";

// Publiek: de Docker-healthcheck heeft geen login. Zonder login alleen ok en versie,
// want de laatste job kan namen van assets bevatten. getDb() blijft vooraan staan,
// zodat de healthcheck faalt als de database niet te openen is.
export const GET = handler(
  async (req) => {
    const db = getDb();
    if (!isAuthorized(readSessionCookie(req))) return json({ ok: true, version: process.env.APP_VERSION ?? "dev" });
    const lastRefresh = db.select().from(schema.jobRuns).orderBy(desc(schema.jobRuns.id)).limit(1).get();
    const fx = db.select().from(schema.fxRates).orderBy(desc(schema.fxRates.date)).limit(1).get();
    return json({ ok: true, etoroConfigured: etoroConfigured(), lastJob: lastRefresh ?? null, fxDate: fx?.date ?? null, version: process.env.APP_VERSION ?? "dev" });
  },
  { public: true },
);
