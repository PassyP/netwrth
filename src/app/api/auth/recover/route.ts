import { z } from "zod";
import { handler, json } from "@/lib/api";
import { MIN_PASSWORD_LENGTH, checkRecoveryCode, clientIp, createSessionToken, failureDelay, isPasswordSet, lockedFor, registerFailure, registerSuccess, sessionCookie, setPassword } from "@/lib/auth";

const input = z.object({ code: z.string().min(1).max(100), next: z.string().min(MIN_PASSWORD_LENGTH, `Minimaal ${MIN_PASSWORD_LENGTH} tekens`).max(500) });

/**
 * "Wachtwoord vergeten?": met de herstelcode een nieuw wachtwoord zetten. Publiek, met dezelfde brute-force-rem als inloggen.
 * De gebruikte code vervalt; de nieuwe code komt eenmalig terug in het antwoord.
 */
export const POST = handler(
  async (req) => {
    if (!isPasswordSet()) return json({ error: "Er is geen wachtwoord ingesteld" }, { status: 400 });
    const ip = clientIp(req);
    const wait = lockedFor(ip);
    if (wait > 0) return json({ error: `Te veel pogingen. Probeer het over ${wait} seconden opnieuw.` }, { status: 429 });

    const { code, next } = input.parse(await req.json());
    if (!checkRecoveryCode(code)) {
      registerFailure(ip);
      await failureDelay();
      return json({ error: "Onjuiste herstelcode" }, { status: 401 });
    }
    registerSuccess(ip);
    const recoveryCode = setPassword(next);
    return json({ ok: true, recoveryCode }, { headers: { "set-cookie": sessionCookie(createSessionToken(true), true, req) } });
  },
  { public: true },
);
