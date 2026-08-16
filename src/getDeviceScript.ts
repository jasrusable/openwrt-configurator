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

/**
 * A per-config `uci` operation that tolerates the config not being there.
 *
 * `uci commit <pkg>` and `uci revert <pkg>` both exit 1 when the config file
 * does not exist (verified on 25.12.5), and this script runs under `set -e`. A
 * config can legitimately be absent — a built-in this image does not ship, or
 * one whose package `apk del` removed earlier in this same run — and a missing
 * config must not abort the provision or, worse, stop the remaining reverts
 * partway through a rollback.
 */
const forEachExistingConfig = (configKeys: string[], operation: string) =>
  configKeys.map(
    (configKey) =>
      `if [ -f /etc/config/${configKey} ]; then uci ${operation} ${configKey}; fi`
  );

/**
 * Every config this run stages changes in: what it sets, plus what it resets.
 *
 * Only configs with at least one real operation count. Resolving a config for a
 * device routinely leaves a package behind with no sections — one whose
 * sections were all filtered out by `.if`, so it applies to other devices but
 * not this one. Committing those would defeat the point of naming configs
 * explicitly, since it would commit whatever staged changes happened to be
 * sitting in a package this run never touches, and reverting them would discard
 * someone else's staged edits for no reason.
 */
const touchedConfigs = (state: OpenWrtState) => {
  const written = Object.keys(state.config || {}).filter((configKey) =>
    Object.values((state.config as any)[configKey] || {}).some(
      (sections) => ((sections as any[]) || []).length > 0
    )
  );
  const reset = Object.keys(state.configSectionsToReset || {}).filter(
    (configKey) => (state.configSectionsToReset?.[configKey] || []).length > 0
  );
  return [...new Set([...written, ...reset])].sort();
};

/**
 * Discard any staged UCI changes in the configs this run is about to write.
 *
 * A run that dies without being able to revert — the link drops mid-configure,
 * so the tool's own `uci revert` never reaches the device — leaves its staged
 * deltas in /tmp/.uci. The watchdog restores /etc/config but does not touch the
 * delta directory, so those changes survive the rollback and the next run's
 * commit would pick them up, silently re-applying part of a provision that was
 * deliberately rolled back.
 *
 * Clearing the staging area up front fixes that deterministically, without
 * racing an abandoned script that may still be running. Only the configs this
 * run writes are reverted, so unrelated staged changes (a half-finished LuCI
 * edit, say) are left alone rather than discarded.
 *
 * This runs before the packages step because `default_postinst` ends with a
 * bare `uci commit` for any package shipping /etc/uci-defaults — which would
 * otherwise commit the very leftovers we are trying to drop.
 */
export const getStartCleanCommands = (state: OpenWrtState) =>
  forEachExistingConfig(touchedConfigs(state), "revert");

/**
 * The trailing commands that make staged UCI changes take effect.
 *
 * The commit names each config explicitly rather than being a bare
 * `uci commit`, which commits *every* package — including staged changes this
 * tool did not make. That swept up whatever a LuCI session happened to have
 * pending, and leftovers from an earlier failed run.
 *
 * `run_after_reload` hooks come last: unlike `run_after`, which fires as soon
 * as its file is written, these run once the config is actually live, so they
 * can rely on interfaces and services the new config creates.
 */
export const getFinaliseCommands = (state: OpenWrtState) => [
  ...forEachExistingConfig(touchedConfigs(state), "commit"),
  "reload_config",
  ...(state.files || []).flatMap((file) =>
    file.run_after_reload ? [file.run_after_reload] : []
  ),
];

/**
 * Enter every existing config into procd's change baseline, before staging.
 *
 * `reload_config` fires `config.change` only for configs listed in
 * /var/run/config.md5 — it diffs with `md5sum -c`, which never looks at a file
 * that is not already in that list. The list is written by /etc/init.d/boot and
 * by `reload_config` itself; those are the only callers in the whole OpenWrt
 * tree. Installing a package does **not** refresh it, because `default_postinst`
 * runs `kmodloader`, `sysctl restart`, uci-defaults and `<init> enable/start`,
 * but never `reload_config`.
 *
 * So without this, a package installed by this run ships /etc/config/<pkg>, apk
 * starts its service on the shipped defaults, we configure it, and the closing
 * `reload_config` fires nothing for it: the service keeps its defaults until a
 * reboot or the next provision, while `uci show` reports the intended config.
 *
 * This has to run *before* anything is staged. `reload_config` compares
 * `uci show`, which includes uncommitted deltas, so refreshing the baseline
 * after staging would record our own changes as the baseline and the closing
 * reload would then fire nothing at all.
 *
 * It also applies any drift since boot, but the closing `reload_config` would
 * have applied that same drift anyway — this only makes it happen earlier, with
 * the rollback watchdog already armed.
 */
export const baselineRefreshCommands = ["reload_config"];

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

  // Guarded, because `uci revert` exits 1 on a config that is not present and
  // the revert script runs under `set -e` — one absent config would otherwise
  // abort every remaining revert, which is the worst possible moment for it.
  return forEachExistingConfig(touched, "revert");
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
    ...getStartCleanCommands(state),
    ...packageCommands,
    ...baselineRefreshCommands,
    ...resetCommands,
    ...uciBatchCommands(uciCommands),
    ...fileCommands,
    ...getFinaliseCommands(state),
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
