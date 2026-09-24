import { handler, json } from "@/lib/api";
import { vapidKeys } from "@/lib/notify";

export const GET = handler(async () => json({ publicKey: vapidKeys().publicKey }));
