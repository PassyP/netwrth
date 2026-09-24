import { z } from "zod";
import { handler, json } from "@/lib/api";
import { removeWalletAccount, updateWalletAccount } from "@/lib/connections/wallet-accounts";
import { resetWalletBookings } from "@/lib/connections/sync";

const patch = z.object({ label: z.string().trim().min(1).max(60).optional(), enabled: z.boolean().optional() });

async function ids(ctx: { params: Promise<{ id: string; accountId: string }> }) {
  const p = await ctx.params;
  const id = Number(p.id);
  const accountId = Number(p.accountId);
  if (!Number.isInteger(id) || !Number.isInteger(accountId)) throw new Error("Ongeldig id");
  return { id, accountId };
}

/** Label of aan/uit; bij aan/uit worden de boekingen van de koppeling opnieuw opgebouwd (volgende sync). */
export const PATCH = handler(async (req, ctx: { params: Promise<{ id: string; accountId: string }> }) => {
  const { id, accountId } = await ids(ctx);
  const body = patch.parse(await req.json());
  const r = updateWalletAccount(id, accountId, body);
  const rebooked = r.enabledChanged ? resetWalletBookings(id) : 0;
  return json({ account: r.account, rebooked });
});

export const DELETE = handler(async (_req, ctx: { params: Promise<{ id: string; accountId: string }> }) => {
  const { id, accountId } = await ids(ctx);
  const r = removeWalletAccount(id, accountId);
  const rebooked = r.removed && r.wasEnabled ? resetWalletBookings(id) : 0;
  return json({ ok: r.removed, rebooked });
});
