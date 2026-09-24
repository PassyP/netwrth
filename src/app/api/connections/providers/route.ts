import { handler, json } from "@/lib/api";
import { providerInfo } from "@/lib/connections/sync";

export const GET = handler(async () => json(providerInfo()));
