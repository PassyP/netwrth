import { z } from "zod";
import { handler, json } from "@/lib/api";
import { checkPassword, isPasswordSet, rotateRecoveryCode } from "@/lib/auth";

const input = z.object({ current: z.string().max(500) });

/** Nieuwe herstelcode aanvragen (bijv. als de oude kwijt is). Vereist het huidige wachtwoord; de oude code vervalt. */
export const POST = handler(async (req) => {
  const { current } = input.parse(await req.json());
  if (!isPasswordSet()) return json({ error: "Er is geen wachtwoord ingesteld" }, { status: 400 });
  if (!checkPassword(current)) return json({ error: "Huidig wachtwoord is onjuist" }, { status: 401 });
  return json({ ok: true, recoveryCode: rotateRecoveryCode() });
});
