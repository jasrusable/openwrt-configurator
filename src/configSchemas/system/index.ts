import { z } from "zod";
import {
  configSchema,
  makeOncConfigSchema,
  oncSectionSchema,
  sectionSchema,
} from "../../utils";
import { oncSystemSystemSchema, systemSystemSchema } from "./system";

export const systemSchema = configSchema(
  z
    .object({
      system: sectionSchema(systemSystemSchema),
    })
    .passthrough()
);

export const oncSystemSchema = makeOncConfigSchema(
  z
    .object({
      system: oncSectionSchema(oncSystemSystemSchema),
    })
    .passthrough()
);

export const systemSectionsToReset = {
  system: {
    system: true,
  },
};
