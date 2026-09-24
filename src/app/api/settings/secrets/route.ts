import { z } from "zod";
import { handler, json } from "@/lib/api";
import { setSecret, deleteSecret, maskSecret } from "@/lib/secrets";

const input = z.object({ etoroApiKey: z.string().trim().min(8).max(500).optional(), etoroUserKey: z.string().trim().min(8).max(500).optional() });

export const POST = handler(async (req) => {
  const body = input.parse(await req.json());
  if (body.etoroApiKey) setSecret("etoroApiKey", body.etoroApiKey);
  if (body.etoroUserKey) setSecret("etoroUserKey", body.etoroUserKey);
  return json({ etoroApiKey: maskSecret("etoroApiKey"), etoroUserKey: maskSecret("etoroUserKey") });
});

export const DELETE = handler(async () => {
  deleteSecret("etoroApiKey");
  deleteSecret("etoroUserKey");
  return json({ ok: true });
});
