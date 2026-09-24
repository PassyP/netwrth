import { handler, json } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { addAssetFromInput, primeAssetPrice } from "@/lib/assets";
import { latestQuote } from "@/lib/prices/quotes";

export const GET = handler(async () => {
  const rows = getDb().select().from(schema.assets).orderBy(schema.assets.symbol).all();
  return json(rows.map((a) => ({ ...a, quote: latestQuote(a.id) })));
});

export const POST = handler(async (req) => {
  const asset = await addAssetFromInput(await req.json());
  void primeAssetPrice(asset);
  return json(asset, { status: 201 });
});
