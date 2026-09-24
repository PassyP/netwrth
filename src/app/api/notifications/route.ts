import { isNull } from "drizzle-orm";
import { handler, json } from "@/lib/api";
import { getDb, schema } from "@/lib/db";

export const GET = handler(async (req) => {
  const unread = new URL(req.url).searchParams.get("unread") === "1";
  const db = getDb();
  const rows = unread ? db.select().from(schema.notifications).where(isNull(schema.notifications.readAt)).all() : db.select().from(schema.notifications).all();
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return json(rows.slice(0, 100));
});

/** Alles als gelezen markeren. */
export const POST = handler(async () => {
  getDb().update(schema.notifications).set({ readAt: new Date().toISOString() }).where(isNull(schema.notifications.readAt)).run();
  return json({ ok: true });
});
