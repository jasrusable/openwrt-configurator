// `secrets set`: a value for `{ "$secret": "name" }` refs, kept in the macOS keychain.
import { CommandSpec } from "../args";
import { setKeychainSecret } from "../secrets";
import { CliContext } from "./context";

export const secretsCommand = ({ platform }: CliContext): CommandSpec => ({
  name: "secrets set",
  description:
    'prompt for a value and store it in the macOS keychain for { "$secret": "name" } refs (the value is never printed)',
  args: [
    {
      name: "name",
      description: "secret name matching the $secret field in the config",
    },
  ],
  action: async ([name]) => {
    await setKeychainSecret({ name, platform });
  },
});
