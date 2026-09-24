import { z } from "zod";
import { handler, json } from "@/lib/api";
import { createPlatform, listPlatforms, PLATFORM_TYPES } from "@/lib/platforms";

export const GET = handler(async () => json(listPlatforms()));

const input = z.object({ name: z.string().trim().min(1).max(60), type: z.enum(PLATFORM_TYPES).default("broker") });

export const POST = handler(async (req) => json(createPlatform(input.parse(await req.json())), { status: 201 }));
