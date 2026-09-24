import { z } from "zod";
import { handler, json } from "@/lib/api";
import { getSettings, setSetting } from "@/lib/settings";
import { maskSecret } from "@/lib/secrets";
import { isPasswordSet, isRecoveryCodeSet } from "@/lib/auth";
import { scheduleJobs } from "@/lib/worker";
import { getDb, schema } from "@/lib/db";
import { installInfo } from "@/lib/settings-overview";
import { isValidTimeZone } from "@/lib/schedule";

export const GET = handler(async () => {
  const pushSubs = getDb().select({ id: schema.pushSubscriptions.id }).from(schema.pushSubscriptions).all().length;
  return json({
    settings: getSettings(),
    secrets: { etoroApiKey: maskSecret("etoroApiKey"), etoroUserKey: maskSecret("etoroUserKey") },
    pushSubs,
    passwordSet: isPasswordSet(),
    recoveryCodeSet: isRecoveryCodeSet(),
    install: installInfo(),
  });
});

const url = (msg: string) =>
  z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === "" || /^https?:\/\//i.test(v), msg);

const patch = z.object({
  displayCurrency: z.enum(["EUR", "USD", "BTC"]).optional(),
  costMethod: z.enum(["average", "fifo"]).optional(),
  ignoreFx: z.boolean().optional(),
  hideDust: z.boolean().optional(),
  refreshTime: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Gebruik een tijd als 23:45").optional(),
  snapshotTime: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Gebruik een tijd als 23:59").optional(),
  notifyChannel: z.enum(["app", "push", "ntfy"]).optional(),
  ntfyTopicUrl: url("De topic-URL moet met http:// of https:// beginnen").optional(),
  timezone: z
    .string()
    .trim()
    .max(60)
    .refine(isValidTimeZone, "Onbekende tijdzone; gebruik een IANA-naam zoals Europe/Amsterdam")
    .optional(),
  bitcoinApiUrl: url("De URL moet met http:// of https:// beginnen").optional(),
  bitcoinFallbackEnabled: z.boolean().optional(),
  bitcoinFallbackUrl: url("De URL moet met http:// of https:// beginnen").optional(),
  walletSyncMinutes: z.coerce.number().int().min(0, "Minimaal 0").max(1440, "Maximaal 1440 (dagelijks)").optional(),
  priceRefreshMinutes: z.coerce.number().int().min(0, "Minimaal 0").max(1440, "Maximaal 1440 (dagelijks)").optional(),
});

export const PATCH = handler(async (req) => {
  const body = patch.parse(await req.json());
  const before = getSettings();
  for (const [k, v] of Object.entries(body)) if (v !== undefined) setSetting(k as keyof typeof body, String(v));
  const after = getSettings();
  // alleen opnieuw plannen als de planning echt veranderde (een blur zonder wijziging herstart geen cronjobs)
  const scheduleKeys = ["refreshTime", "snapshotTime", "timezone", "walletSyncMinutes", "priceRefreshMinutes"] as const;
  if (scheduleKeys.some((k) => before[k] !== after[k])) scheduleJobs();
  return json(after);
});
