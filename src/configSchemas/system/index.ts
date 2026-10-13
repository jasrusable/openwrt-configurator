import { z } from "zod";
import {
  configSchema,
  makeOncConfigSchema,
  oncSectionSchema,
  sectionSchema,
  onlySectionTypes,
} from "../../utils";
import { oncSystemSystemSchema, systemSystemSchema } from "./system";

// OpenWrt's system section types.
const knownTypes = onlySectionTypes(["system", "timeserver", "led", "button", "rngd"]);

export const systemSchema = configSchema(
  z
    .object({
      system: sectionSchema(systemSystemSchema),
    })
    .passthrough()
).superRefine(knownTypes);

export const oncSystemSchema = makeOncConfigSchema(
  z
    .object({
      system: oncSectionSchema(oncSystemSystemSchema),
    })
    .passthrough()
).superRefine(knownTypes);

