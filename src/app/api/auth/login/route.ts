import { z } from "zod";
import { handler, json } from "@/lib/api";
import { checkPassword, clientIp, createSessionToken, failureDelay, isPasswordSet, lockedFor, registerFailure, registerSuccess, sessionCookie } from "@/lib/auth";

const input = z.object({ password: z.string().max(500), remember: z.boolean().optional().default(true) });

// Publiek: dit is de enige route die zonder login bereikbaar moet zijn.
export const POST = handler(
  async (req) => {
    if (!isPasswordSet()) return json({ ok: true });
    const ip = clientIp(req);
    const wait = lockedFor(ip);
    if (wait > 0) return json({ error: `Te veel pogingen. Probeer het over ${wait} seconden opnieuw.` }, { status: 429 });

    const { password, remember } = input.parse(await req.json());
    if (!checkPassword(password)) {
      registerFailure(ip);
      await failureDelay();
      return json({ error: "Onjuist wachtwoord" }, { status: 401 });
    }
    registerSuccess(ip);
    return json({ ok: true }, { headers: { "set-cookie": sessionCookie(createSessionToken(remember), remember, req) } });
  },
  { public: true },
);
