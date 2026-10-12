import { z } from "zod";
import type { StudioStatus } from "@/lib/studio-schema";

const statusSchema = z.object({
  aiConfigured: z.boolean(),
  model: z.string().refine((value) => Boolean(value.trim())),
  storage: z.literal("local"),
  supportedFiles: z.array(z.string().regex(/^\.[a-z0-9]+$/i)),
}).strict();

export function studioStatusResponse(value: unknown): StudioStatus | null {
  const parsed = statusSchema.safeParse(value);
  if (!parsed.success) return null;
  if (new Set(parsed.data.supportedFiles).size !== parsed.data.supportedFiles.length) return null;
  return parsed.data;
}
