// What the system settings may be, given the rest.
import type { Choice } from "../feature";

export const systemRules: Choice[] = [
  {
    path: "system.ssh.password_login",
    values: [false],
    unavailable: (intent) =>
      !intent.system.ssh?.authorized_keys?.length &&
      "Add an authorized key first: with neither a password nor a key, nobody could log in.",
  },
];
