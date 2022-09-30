import { z } from "zod";
import {
  configSchema,
  makeOncConfigSchema,
  oncSectionSchema,
  sectionSchema,
} from "../../utils";
import { oncSystemSystemSchema, systemSystemSchema } from "./system";

export const systemSchema = configSchema(
  z.object({
    system: sectionSchema(systemSystemSchema),
  })
);

export const oncSystemSchema = makeOncConfigSchema(
  z.object({
    system: oncSectionSchema(oncSystemSystemSchema),
  })
);

export const systemResetCommands = [
  "while uci -q delete system.@system[0]; do :; done",
];
