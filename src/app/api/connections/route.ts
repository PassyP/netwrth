import { handler, json } from "@/lib/api";
import { createConnection, listConnections, runSync } from "@/lib/connections/sync";

export const GET = handler(async () => json(listConnections()));

/** Koppeling aanmaken; met ?sync=1 direct de eerste sync draaien (wizard). */
export const POST = handler(async (req) => {
  const body = await req.json();
  const conn = createConnection(body);
  const doSync = new URL(req.url).searchParams.get("sync") === "1";
  const report = doSync ? await runSync(conn.id, "initial") : null;
  return json({ connection: conn, report }, { status: 201 });
});
