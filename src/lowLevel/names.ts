// The low-level JSON spells its fields as UCI does (snake_case); the plan
// spells them as TypeScript does. Renamed here, both ways, key order kept,
// so `compile` prints what it always has.
import { PlanDevice, PlanFile, Service } from "../plan/types";
import { LowLevelConfig } from "./schema";

type JsonDevice = LowLevelConfig["devices"][number];
type JsonService = Omit<NonNullable<LowLevelConfig["services"]>[number], ".if">;
type JsonFile = Omit<NonNullable<LowLevelConfig["files"]>[number], ".if">;

const toJson: Record<string, string> = {
  modelId: "model_id",
  provisionOrder: "provision_order",
  privateKeyPath: "private_key_path",
  restartAfterRollback: "restart_after_rollback",
  restartOnPackages: "restart_on_packages",
  runAfter: "run_after",
  runAfterReload: "run_after_reload",
};
const fromJson = Object.fromEntries(Object.entries(toJson).map(([plan, json]) => [json, plan]));

const renamed = (value: object, names: Record<string, string>) =>
  Object.fromEntries(Object.entries(value).map(([key, v]) => [names[key] ?? key, v]));

/** A device as the JSON writes it: its login under `provisioning_config.ssh_auth`. */
export const deviceToJson = (device: PlanDevice): JsonDevice =>
  Object.fromEntries(
    Object.entries(device).map(([key, value]) =>
      key === "login" ? ["provisioning_config", { ssh_auth: renamed(value as object, toJson) }] : [toJson[key] ?? key, value]
    )
  ) as JsonDevice;

export const deviceFromJson = (device: JsonDevice): PlanDevice =>
  Object.fromEntries(
    Object.entries(device).map(([key, value]) =>
      key === "provisioning_config"
        ? ["login", renamed((value as { ssh_auth: object }).ssh_auth, fromJson)]
        : [fromJson[key] ?? key, value]
    )
  ) as PlanDevice;

export const serviceToJson = (service: Omit<Service, "when">) => renamed(service, toJson) as JsonService;
export const serviceFromJson = (service: JsonService) => renamed(service, fromJson) as Omit<Service, "when">;
export const fileToJson = (file: Omit<PlanFile, "when">) => renamed(file, toJson) as JsonFile;
export const fileFromJson = (file: JsonFile) => renamed(file, fromJson) as Omit<PlanFile, "when">;
