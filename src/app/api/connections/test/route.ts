import { handler, json } from "@/lib/api";
import { testCredentials } from "@/lib/connections/sync";

export const POST = handler(async (req) => json(await testCredentials(await req.json())));
