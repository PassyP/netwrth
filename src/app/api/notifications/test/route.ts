import { handler, json } from "@/lib/api";
import { sendTestNotification } from "@/lib/notify";

/** Testmelding via het ingestelde kanaal (Instellingen → Meldingen). */
export const POST = handler(async () => json(await sendTestNotification()));
