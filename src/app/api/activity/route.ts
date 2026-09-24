import { handler, json } from "@/lib/api";
import { recentActivity } from "@/lib/settings-overview";

/** Recente taken: koersrondes, snapshots en syncs van koppelingen, nieuwste eerst (?limit=, standaard 50). */
export const GET = handler(async (req) => {
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 50);
  return json(recentActivity(Number.isFinite(limit) ? limit : 50));
});
