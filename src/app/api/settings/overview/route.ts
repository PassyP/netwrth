import { handler, json } from "@/lib/api";
import { computeAttention, criticalCount, installInfo, settingsSummaries } from "@/lib/settings-overview";

/** Statusoverzicht van Instellingen; ?only=critical geeft alleen het aantal kritieke punten (stip in de navigatie). */
export const GET = handler(async (req) => {
  if (new URL(req.url).searchParams.get("only") === "critical") return json({ critical: criticalCount() });
  return json({ attention: computeAttention(), summaries: settingsSummaries(), install: installInfo() });
});
