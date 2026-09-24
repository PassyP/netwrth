import { handler, json } from "@/lib/api";
import { searchAssetCandidates } from "@/lib/assets";

export const GET = handler(async (req) => {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return json(await searchAssetCandidates(q));
});
