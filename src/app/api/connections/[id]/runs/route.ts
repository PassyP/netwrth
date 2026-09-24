import { desc, eq } from "drizzle-orm";
import { handler, json, idFromParams } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { parseWarnings } from "@/lib/connections/sync";

export const GET = handler(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  const rows = getDb().select().from(schema.syncRuns).where(eq(schema.syncRuns.connectionId, id)).orderBy(desc(schema.syncRuns.id)).limit(20).all();
  return json(rows.map((r) => ({ ...r, warnings: parseWarnings(r.warnings) })));
});
