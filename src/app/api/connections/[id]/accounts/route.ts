import { z } from "zod";
import { eq } from "drizzle-orm";
import { handler, json, idFromParams } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { getDb, schema } from "@/lib/db";
import { addWalletAccounts, listWalletAccounts, walletAccountInput } from "@/lib/connections/wallet-accounts";
import { resetWalletBookings } from "@/lib/connections/sync";

const input = z.object({ accounts: z.array(walletAccountInput).min(1).max(50) });

function requireWallet(id: number) {
  const conn = getDb().select().from(schema.connections).where(eq(schema.connections.id, id)).get();
  if (!conn) throw new ApiError("Koppeling niet gevonden.", 404);
  if (conn.provider !== "bitcoin") throw new ApiError("Geen Bitcoin-wallet-koppeling.", 400);
  return conn;
}

export const GET = handler(async (_req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  requireWallet(id);
  return json(listWalletAccounts(id));
});

/** Accounts toevoegen; een nieuw ingeschakeld account verandert de adresset, dus de boekingen worden opnieuw opgebouwd (volgende sync). */
export const POST = handler(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const id = await idFromParams(ctx);
  requireWallet(id);
  const body = input.parse(await req.json());
  const r = addWalletAccounts(id, body.accounts);
  const rebooked = r.added > 0 && body.accounts.some((a) => a.enabled !== false) ? resetWalletBookings(id) : 0;
  return json({ ...r, rebooked, accounts: listWalletAccounts(id) }, { status: 201 });
});
