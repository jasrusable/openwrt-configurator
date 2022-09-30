import { z } from "zod";

export const systemSystemSchema = z.object({
  hostname: z.string().optional(),
  timezone: z.string().optional(),
});

export const oncSystemSystemSchema = systemSystemSchema