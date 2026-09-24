import { handler, json } from "@/lib/api";
import { savePushSubscription, removePushSubscription } from "@/lib/notify";

export const POST = handler(async (req) => {
  const sub = await req.json();
  if (!sub?.endpoint) return json({ error: "Ongeldige subscription" }, { status: 400 });
  savePushSubscription(sub);
  return json({ ok: true }, { status: 201 });
});

export const DELETE = handler(async (req) => {
  const { endpoint } = await req.json();
  if (endpoint) removePushSubscription(endpoint);
  return json({ ok: true });
});
