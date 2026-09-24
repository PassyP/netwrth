import { z } from "zod";
import { handler, json } from "@/lib/api";
import { dismissAttention, resetDismissedAttention } from "@/lib/settings-overview";

const input = z.object({ key: z.string().min(1).max(100), fingerprint: z.string().max(5000) });

/** Aandachtspunt negeren tot er iets verandert (kritieke punten tonen we altijd, ook na negeren). */
export const POST = handler(async (req) => {
  const { key, fingerprint } = input.parse(await req.json());
  dismissAttention(key, fingerprint);
  return json({ ok: true });
});

/** Alle genegeerde punten weer tonen. */
export const DELETE = handler(async () => {
  resetDismissedAttention();
  return json({ ok: true });
});
