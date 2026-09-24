import { handler, json } from "@/lib/api";
import { parseSpreadsheet, detectProfile, swissquotePositionsToDrafts, genericToDrafts, guessMapping, type ColumnMapping } from "@/lib/importers";

export const POST = handler(async (req) => {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "Geen bestand" }, { status: 400 });
  const mappingRaw = form.get("mapping");
  const buf = Buffer.from(await file.arrayBuffer());
  const sheet = parseSpreadsheet(buf, file.name);
  const profile = detectProfile(sheet.headers);
  const mapping: ColumnMapping = mappingRaw ? JSON.parse(String(mappingRaw)) : guessMapping(sheet.headers);
  const drafts = profile === "swissquote-positions" ? swissquotePositionsToDrafts(sheet, file.name) : genericToDrafts(sheet, mapping, file.name);
  return json({ filename: file.name, profile, headers: sheet.headers, sample: sheet.rows.slice(0, 5), rowCount: sheet.rows.length, mapping, drafts });
});
