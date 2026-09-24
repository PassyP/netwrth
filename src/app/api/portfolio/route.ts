import { handler, json, parsePortfolioId } from "@/lib/api";
import { computePortfolio } from "@/lib/portfolio";

/**
 * Portfolio-overzicht. Zonder `?detail=1` blijven de lots en gerealiseerde events per positie weg: het overzicht en de
 * allocatiepagina gebruiken ze niet, en bij honderden lots per positie zijn ze het leeuwendeel van het antwoord
 * (~300 KB tegen ~4 KB). De assetpagina rekent haar eigen posities uit via /api/assets/[id].
 */
export const GET = handler(async (req) => {
  const view = computePortfolio(parsePortfolioId(req));
  const detail = new URL(req.url).searchParams.get("detail") === "1";
  if (detail) return json(view);
  return json({ ...view, positions: view.positions.map((p) => ({ ...p, lots: [], realizedEvents: [] })) });
});
