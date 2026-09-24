import fs from "node:fs";
import path from "node:path";
import { handler } from "@/lib/api";
import { dataDir, getDb } from "@/lib/db";
import { setMeta } from "@/lib/settings";

/** Back-up: consistente kopie van de SQLite-database als download. */
export const GET = handler(async () => {
  getDb();
  const Database = (await import("better-sqlite3")).default;
  const src = path.join(dataDir(), "portfolio.db");
  const tmp = path.join(dataDir(), `backup-${Date.now()}.db`);
  const conn = new Database(src, { readonly: true });
  await conn.backup(tmp);
  conn.close();
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  setMeta("lastBackupAt", new Date().toISOString()); // voor "Laatste back-up" en het aandachtspunt in Instellingen
  return new Response(new Uint8Array(buf), {
    headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="netwrth-backup-${new Date().toISOString().slice(0, 10)}.db"` },
  });
});
