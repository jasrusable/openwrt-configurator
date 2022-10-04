import { z } from "zod";

export const systemSystemSchema = z
  .object({
    hostname: z.string().optional(),
    timezone: z.string().optional(),
  })
  .passthrough();

export const oncSystemSystemSchema = systemSystemSchema;
