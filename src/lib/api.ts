import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { isAuthorized, readSessionCookie } from "./auth";
import { ApiError } from "./errors";

export const UNAUTHORIZED = "Niet ingelogd";

export function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function errorResponse(e: unknown, status = 400) {
  if (e instanceof ZodError) {
    const msg = e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return NextResponse.json({ error: `Ongeldige invoer: ${msg}` }, { status: 400 });
  }
  const message = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: message }, { status });
}

/**
 * Wrapper voor route handlers: vangt fouten en geeft ze als JSON terug.
 * Vereist een geldige login zodra er een wachtwoord is ingesteld, tenzij `public: true`.
 */
export function handler<Ctx>(fn: (req: Request, ctx: Ctx) => Promise<Response> | Response, opts: { public?: boolean } = {}) {
  return async (req: Request, ctx: Ctx) => {
    if (!opts.public && !isAuthorized(readSessionCookie(req))) return NextResponse.json({ error: UNAUTHORIZED }, { status: 401 });
    try {
      return await fn(req, ctx);
    } catch (e) {
      console.error(`[api] ${req.method} ${new URL(req.url).pathname}:`, e instanceof Error ? e.message : e);
      if (e instanceof ApiError) return errorResponse(e, e.status);
      return errorResponse(e, e instanceof ZodError ? 400 : 500);
    }
  };
}

export function parsePortfolioId(req: Request): number | null {
  const v = new URL(req.url).searchParams.get("portfolioId");
  if (!v || v === "all") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function idFromParams(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  const { id } = await ctx.params;
  const n = Number(id);
  if (!Number.isInteger(n)) throw new Error("Ongeldig id");
  return n;
}
