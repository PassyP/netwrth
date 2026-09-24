import { handler, json } from "@/lib/api";
import { testConnection } from "@/lib/prices/etoro";

export const POST = handler(async () => json(await testConnection()));
