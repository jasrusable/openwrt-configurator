import { posix as posixPath } from "path";
import { NodeSSH } from "node-ssh";
import { dhcpSectionsToReset } from "./configSchemas/dhcp";
import { firewallSectionsToReset } from "./configSchemas/firewall";
import { networkSectionsToReset } from "./configSchemas/network";
import { systemSectionsToReset } from "./configSchemas/system";
import { wirelessSectionsToReset } from "./configSchemas/wireless";
import { getUciCommands } from "./getUciCommands";
import { OpenWrtState } from "./openWrtConfigSchema";
import { getInstalledPackages, getManagedFiles } from "./utils";

// Manifest of files written by this tool, so files removed from config are
// removed from the device on the next provision (declarative, like UCI resets).
export const managedFilesManifest = "/etc/onc/managed_files";

const uciErrFile = "/tmp/.onc-uci-err";

/** The trailing commands that make staged UCI changes take effect. */
export const finaliseCommands = ["uci commit", "reload_config"];

// Pick a heredoc delimiter guaranteed not to occur in the content.
export const heredocDelimiter = (content: string, base = "ONC_EOF") => {
  let delimiter = base;
  while (content.includes(delimiter)) {
    delimiter = `${delimiter}_`;
  }
  return delimiter;
};

const writeFileCommand = (path: string, content: string, mode?: string) => {
  // Write via a quoted heredoc: `cat` is always present (unlike the `base64`
  // applet, which is missing on stripped/small-flash busybox builds), and a
  // quoted delimiter keeps content literal so `$vars` in scripts aren't
  // expanded at write time.
  const delimiter = heredocDelimiter(content);
  const body = content.endsWith("\n") ? content : `${content}\n`;
  return [
    `mkdir -p '${posixPath.dirname(path)}'`,
    `cat > '${path}' <<'${delimiter}'`,
    `${body}${delimiter}`,
    ...(mode ? [`chmod ${mode} '${path}'`] : []),
  ].join("\n");
};

const sectionsToReset: any = {
  ...dhcpSectionsToReset,
  ...firewallSectionsToReset,
  ...networkSectionsToReset,
  ...systemSectionsToReset,
  ...wirelessSectionsToReset,
};


/**
 * `uci revert` for every config this provision could have staged changes in.
 *
 * Deriving this from the built-in section list alone was not enough: the config
 * schema has a catchall, so a config can legitimately drive any UCI package
 * (dropbear, sqm, usteer, ...). Those were staged but never reverted, and since
 * the final command is a bare `uci commit` — which commits *every* package —
 * a later run would silently commit changes left behind by a failed one.
 */
export const getRevertCommands = (state: OpenWrtState) => {
  const touched = [
    ...new Set([
      ...Object.keys(sectionsToReset),
      ...Object.keys(state.config || {}),
    ]),
  ].sort();

  return touched.map((configKey) => `uci revert ${configKey}`);
};

/**
 * Apply many UCI operations with a single `uci` process.
 *
 * Spawning `uci` per command costs ~1.5ms on the device; one `uci batch`
 * consuming the same operations on stdin costs ~0.1ms each, a 13x saving on a
 * ~300 command provision. A quoted heredoc keeps values literal, so no shell
 * escaping is layered on top of the quoting `getUciCommands` already applies.
 *
 * `uci batch` reports failures on stderr but still exits 0, so the exit status
 * cannot be trusted — any stderr output is treated as a failure instead. Only
 * `set`/`add_list` go through here; the tolerant delete loops stay outside,
 * where a missing section is expected rather than an error.
 *
 * The batch is line-oriented, so an operation carrying an embedded newline
 * would be split across lines and misparsed. Those are issued as standalone
 * `uci` commands, where the shell's quoting keeps the value intact — and the
 * batch is flushed around them rather than partitioned, because UCI lists are
 * ordered and hoisting every batchable operation ahead of a multi-line one
 * would silently move a list element relative to its siblings.
 */
const uciBatchCommands = (uciCommands: string[]) => {
  const commands: string[] = [];
  let pending: string[] = [];

  const flush = () => {
    if (pending.length === 0) {
      return;
    }
    const operations = pending
      .map((command) => command.replace(/^uci /, ""))
      .join("\n");
    const delimiter = heredocDelimiter(operations, "ONC_UCI");
    commands.push(
      [
        `uci batch 2>${uciErrFile} <<'${delimiter}'`,
        operations,
        delimiter,
        `if [ -s ${uciErrFile} ]; then cat ${uciErrFile} >&2; rm -f ${uciErrFile}; exit 1; fi`,
        `rm -f ${uciErrFile}`,
      ].join("\n")
    );
    pending = [];
  };

  for (const command of uciCommands) {
    if (command.includes("\n")) {
      flush();
      commands.push(command);
    } else {
      pending.push(command);
    }
  }
  flush();

  return commands;
};

export const getDeviceScript = async ({
  state,
  ssh,
  installedPackages: providedInstalledPackages,
}: {
  state: OpenWrtState;
  ssh?: NodeSSH;
  /** Pass an already-fetched list to avoid a second `apk info` round trip. */
  installedPackages?: string[];
}) => {
  const uciCommands = getUciCommands({ openWrtConfig: state.config });

  const configSections =
    state.configSectionsToReset &&
    Object.keys(state.configSectionsToReset).reduce<string[][]>(
      (acc, configKey) => {
        const sections = (state.configSectionsToReset?.[configKey] || []).map(
          (sectionKey) => [configKey, sectionKey]
        );
        return [...acc, ...sections];
      },
      []
    );

  const resetCommands = configSections
    ? configSections.map(([configKey, sectionKey]) => {
        return `while uci -q delete ${configKey}.@${sectionKey}[0]; do :; done`;
      })
    : [];

  const installedPackages =
    providedInstalledPackages ??
    (ssh ? await getInstalledPackages(ssh) : undefined);

  const packagesToUninstall = installedPackages
    ? (state.packagesToUninstall || []).filter((p) =>
        installedPackages.includes(p)
      )
    : state.packagesToUninstall;

  const packagesToInstall = installedPackages
    ? (state.packagesToInstall || []).filter(
        (p) => !installedPackages.includes(p.packageName)
      )
    : state.packagesToInstall;

  const packageCommands = [
    ...(packagesToUninstall && packagesToUninstall.length > 0
      ? [`apk del --rdepends ${packagesToUninstall.join(" ")}`]
      : []),
    ...(packagesToInstall && packagesToInstall.length > 0
      ? [
          `apk add --update-cache ${packagesToInstall
            .map((p) => p.packageName)
            .join(" ")}`,
        ]
      : []),
  ];

  const files = state.files || [];
  const previouslyManagedFiles = ssh
    ? await getManagedFiles(ssh, managedFilesManifest)
    : undefined;
  const staleFiles = (previouslyManagedFiles || []).filter(
    (path) => !files.find((file) => file.path === path)
  );

  const fileCommands =
    files.length > 0 || staleFiles.length > 0
      ? [
          ...staleFiles.map((path) => `rm -f '${path}'`),
          ...files.flatMap((file) => [
            writeFileCommand(file.path, file.content, file.mode),
            // Optional command run immediately after the file is written (e.g.
            // trigger a freshly-written hotplug script so it applies now).
            ...(file.run_after ? [file.run_after] : []),
          ]),
          writeFileCommand(
            managedFilesManifest,
            files.map((file) => file.path).join("\n")
          ),
        ]
      : [];

  // Files are written before `uci commit` so a file-write failure aborts before
  // the UCI changes are committed (the revert is then effective), and so a
  // freshly-written hotplug script is in place when reload_config runs.
  return [
    ...packageCommands,
    ...resetCommands,
    ...uciBatchCommands(uciCommands),
    ...fileCommands,
    ...finaliseCommands,
  ];
};

/** The packages a provision would remove from this device, for reporting. */
export const getPackagesToRemove = ({
  state,
  installedPackages,
}: {
  state: OpenWrtState;
  installedPackages: string[];
}) =>
  (state.packagesToUninstall || []).filter((p) =>
    installedPackages.includes(p)
  );

/**
 * Everything `apk del --rdepends` would actually take with it.
 *
 * The named packages are only the start: `--rdepends` also removes whatever
 * depends on them. Removing `firewall4` on a stock image pulls 21 packages,
 * `uhttpd` and the whole LuCI stack among them. Reporting only what the config
 * names would understate that badly, so ask apk to simulate it.
 */
export const getRemovalCascade = async ({
  ssh,
  packages,
}: {
  ssh: NodeSSH;
  packages: string[];
}) => {
  if (packages.length === 0) {
    return [];
  }

  const result = await ssh.execCommand(
    `apk del --simulate --rdepends ${packages.join(" ")}`
  );

  const cascade = result.stdout
    .split("\n")
    .map((line) => line.match(/^\(\s*\d+\/\d+\)\s+Purging\s+(\S+)\s/))
    .flatMap((match) => (match ? [match[1]] : []));

  // If the simulation could not be parsed, fall back to the named packages
  // rather than reporting an empty, falsely reassuring list.
  return cascade.length > 0 ? cascade : packages;
};
