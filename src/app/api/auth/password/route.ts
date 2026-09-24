import { z } from "zod";
import { handler, json } from "@/lib/api";
import { MIN_PASSWORD_LENGTH, checkPassword, clearPassword, clearedCookie, createSessionToken, isPasswordSet, sessionCookie, setPassword } from "@/lib/auth";

const setInput = z.object({ current: z.string().max(500).optional(), next: z.string().min(MIN_PASSWORD_LENGTH, `Minimaal ${MIN_PASSWORD_LENGTH} tekens`).max(500) });
const removeInput = z.object({ current: z.string().max(500) });

/** Bij een bestaand wachtwoord moet het huidige kloppen; anders een 401-antwoord. */
function wrongCurrent(current: string | undefined): Response | null {
  if (!isPasswordSet()) return null;
  if (current && checkPassword(current)) return null;
  return json({ error: "Huidig wachtwoord is onjuist" }, { status: 401 });
}

/** Wachtwoord instellen of wijzigen. Geeft eenmalig de nieuwe herstelcode terug; deze browser blijft ingelogd (cookie 90 dagen). */
export const POST = handler(async (req) => {
  const { current, next } = setInput.parse(await req.json());
  const bad = wrongCurrent(current);
  if (bad) return bad;
  const recoveryCode = setPassword(next);
  return json({ ok: true, recoveryCode }, { headers: { "set-cookie": sessionCookie(createSessionToken(true), true, req) } });
});

/** Wachtwoord verwijderen: de app is daarna weer open. */
export const DELETE = handler(async (req) => {
  const { current } = removeInput.parse(await req.json());
  const bad = wrongCurrent(current);
  if (bad) return bad;
  clearPassword();
  return json({ ok: true }, { headers: { "set-cookie": clearedCookie() } });
});
