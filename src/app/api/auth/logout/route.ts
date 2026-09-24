import { handler, json } from "@/lib/api";
import { clearedCookie } from "@/lib/auth";

export const POST = handler(async () => json({ ok: true }, { headers: { "set-cookie": clearedCookie() } }), { public: true });
