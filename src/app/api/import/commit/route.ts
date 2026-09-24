import { z } from "zod";
import { handler, json } from "@/lib/api";
import { commitImport, type ImportDraft } from "@/lib/importers";
import { PRICE_SOURCES } from "@/lib/db/schema";

const input = z.object({
  drafts: z.array(z.any()),
  portfolioId: z.coerce.number().int().positive(),
  platformId: z.coerce.number().int().positive(),
  yahooSuffix: z.string().max(10).default(""),
  priceSource: z.enum(PRICE_SOURCES).default("yahoo"),
  categoryOverrides: z.record(z.string(), z.enum(["crypto", "stock", "etf", "commodity", "real_estate"])).optional(),
});

export const POST = handler(async (req) => {
  const body = input.parse(await req.json());
  const result = await commitImport(body.drafts as ImportDraft[], body);
  return json(result);
});
