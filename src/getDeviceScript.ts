import { getUciCommands } from "./getUciCommands";
import {
  changedConfigs,
  declaredConfigs,
  uciFileText,
  UciConfigs,
  wipeOperations,
} from "./uci";
import { OpenWrtState } from "./openWrtConfigSchema";
import { dirname } from "./paths";
import { shellQuote } from "./shell";

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
 * Discard every staged UCI change on the device, whoever made it.
 *
 * The tool owns the device's config, so a run starts and ends from committed
 * state. Three reasons it has to be everything, not just the configs this run
 * writes:
 *
 * - A run that dies without reverting (the link drops mid-configure) leaves
 *   its deltas in /tmp/.uci, and the watchdog restores /etc/config without
 *   touching them; the next commit would re-apply a rolled-back provision.
 * - `default_postinst` ends with a bare `uci commit` for any package shipping
 *   /etc/uci-defaults, so installing a package mid-run would commit whatever
 *   was staged anywhere — including someone's unfinished `uci set`.
 * - A rollback's own reload_config reads deltas on top of the restored files.
 *
 * The package list is read on the device, so it covers packages nothing here
 * knows about. LuCI's unsaved edits are not affected: rpcd stages those per
 * session under /var/run/rpcd/uci-<session>, which `uci changes` does not see
 * (verified on 25.12.5).
 *
 * Guarded, because `uci revert` exits 1 on a config file that does not exist
 * and these run under `set -e`. Used before staging, on abort, and by the
 * rollback watchdog.
 */
export const revertPendingCommands = [
  `for pkg in $(uci changes | sed 's/^[-+]//; s/[.=].*//' | sort -u); do if [ -f "/etc/config/$pkg" ]; then uci revert "$pkg"; fi; done`,
];

/**
 * The trailing commands that make staged UCI changes take effect.
 *
 * The commit names each config explicitly rather than being a bare
 * `uci commit`, which commits *every* package — including staged changes this
 * tool did not make. That swept up whatever a LuCI session happened to have
 * pending, and leftovers from an earlier failed run.
 *
 * Stops at the reload. `run_after_reload` hooks follow, but `provision` runs
 * them as their own step rather than as part of this one — see
 * `getPostReloadCommands`.
 */
export const getFinaliseCommands = ({
  state,
  current,
}: {
  state: OpenWrtState;
  /** The device's config as read after the package step. */
  current: UciConfigs;
}) => [
  ...forEachExistingConfig(
    changedConfigs({
      current,
      declared: declaredConfigs(state.config),
      keep: state.configsToNotReset || [],
    }),
    "commit"
  ),
  "reload_config",
  ...protocolRefreshCommands(state),
];

/**
 * netifd learns its protocol handlers (/lib/netifd/proto/*.sh) only when it
 * starts: one a package installed by this run (wireguard, batadv) is unknown
 * to it, and reload_config does not change that, so the interface would stay
 * down until a reboot (verified on 25.12.5). So when a declared interface's
 * protocol is one netifd does not know, it is restarted, once, here: inside
 * the confirm window, so a restart that cut the device off is rolled back.
 */
export const protocolRefreshCommands = (state: OpenWrtState) => {
  const protos = [
    ...new Set(
      (state.config.network?.interface ?? []).flatMap((i: { proto?: unknown }) =>
        typeof i.proto === "string" ? [i.proto] : []
      )
    ),
  ];
  return protos.length
    ? [
        `for p in ${protos.map(shellQuote).join(" ")}; do ubus call network get_proto_handlers | grep -q "\\"$p\\":" || { /etc/init.d/network restart; break; }; done`,
      ]
    : [];
};

/**
 * Hooks that must not run until the new config is actually live.
 *
 * Unlike `run_after`, which fires as soon as its file is written, these run
 * after `uci commit` and `reload_config`, so they can rely on interfaces and
 * services the new config creates.
 *
 * `provision` runs them over a *reconnected* session rather than appending
 * them to the finalise script. `reload_config` is the step that can sever the
 * link, and once dropbear exits, the next marker `printf` in `execScript`
 * takes SIGPIPE and kills the script — so a hook sitting after the reload in
 * the same script would be silently dropped on exactly the runs that reshape
 * networking, while the tool still reported success. Running them once the
 * device has been reconnected to makes that impossible.
 */
export const getPostReloadCommands = (state: OpenWrtState) => [
  ...servicesCommands(state),
  ...(state.files || []).flatMap((file) =>
    file.run_after_reload ? [file.run_after_reload] : []
  ),
];

/**
 * Every declared service enabled at boot and started. A package enables its
 * service only when first installed, so one disabled since stays off after a
 * reboot; and a stopped service has no reload triggers in procd, so changes
 * to its config are ignored until something starts it. "Started" is procd
 * knowing the service at all (it then holds its triggers), not a running
 * process: sqm and the firewall have none, and starting them again would
 * re-apply them for nothing. An init script the device lacks (ubihealthd
 * without UBI flash) is skipped. A failure is reported, not fatal: the
 * config is already live, and the check after says what is not running.
 */
export const servicesCommands = (state: OpenWrtState) => {
  const names = (state.services || []).map((s) => shellQuote(s.name));
  return names.length === 0
    ? []
    : [
        [
          `for s in ${names.join(" ")}; do`,
          '  [ -x "/etc/init.d/$s" ] || continue',
          '  "/etc/init.d/$s" enabled || "/etc/init.d/$s" enable || echo "could not enable $s" >&2',
          `  ubus call service list '{"name":"'"$s"'"}' 2>/dev/null | grep -q "^[[:space:]]*\\"$s\\"" || "/etc/init.d/$s" start || echo "could not start $s" >&2`,
          "done",
        ].join("\n"),
      ];
};

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
    `mkdir -p ${shellQuote(dirname(path))}`,
    `cat > ${shellQuote(path)} <<'${delimiter}'`,
    `${body}${delimiter}`,
    ...(mode ? [`chmod ${shellQuote(mode)} ${shellQuote(path)}`] : []),
  ].join("\n");
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

const packageCommands = ({
  state,
  installedPackages,
}: {
  state: OpenWrtState;
  installedPackages?: string[];
}) => {
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

  return [
    ...(packagesToUninstall && packagesToUninstall.length > 0
      ? [`apk del --rdepends ${packagesToUninstall.map(shellQuote).join(" ")}`]
      : []),
    ...(packagesToInstall && packagesToInstall.length > 0
      ? [
          `apk add --update-cache ${packagesToInstall
            .map((p) => shellQuote(p.packageName))
            .join(" ")}`,
        ]
      : []),
  ];
};

/**
 * Everything that changes the device's config behind our back, run before the
 * config is read: discard pending changes, install and remove packages (their
 * postinst and uci-defaults add sections and whole configs), then refresh the
 * reload baseline. Leaving `installedPackages` out installs and removes every
 * package the state names, unfiltered.
 */
export const getPrepareCommands = ({
  state,
  installedPackages,
  redact,
}: {
  state: OpenWrtState;
  /** From the installedPackages probe. */
  installedPackages?: string[];
  redact?: (value: string) => string;
}) => {
  const packages = packageCommands({ state, installedPackages });
  return [
    ...revertPendingCommands,
    ...(packages.length ? [...seedCommands({ state, redact }), ...packages, ...stockConfigCleanup(state)] : []),
    ...baselineRefreshCommands,
  ];
};

/** Declared configs nothing of which is kept: the ones the tool writes whole. */
const ownedConfigs = (state: OpenWrtState) => {
  const keep = (state.configsToNotReset || []).map((entry) => entry.replace(/^\?/, "").split(".")[0]);
  return Object.entries(declaredConfigs(state.config)).filter(
    ([configKey, sections]) => sections.length > 0 && !keep.includes(configKey)
  );
};

/**
 * Each owned config the device does not have yet (checked there), written
 * before packages are installed, so a package never starts on its stock
 * config: apk keeps a config file that exists, setting its own aside as
 * <name>.apk-new, and the service's first start reads ours. https-dns-proxy's
 * stock config, for one, rewrites dnsmasq and captures clients' DNS the
 * moment it starts. Not a config anything of which is kept: a package that
 * makes its own on first boot (ubihealthd) skips that when the file exists.
 * The wipe and verify still follow, as for any config; a rollback restores
 * /etc/config whole, seeded files included.
 */
export const seedCommands = ({
  state,
  redact,
}: {
  state: OpenWrtState;
  redact?: (value: string) => string;
}) =>
  ownedConfigs(state).map(([configKey, sections]) => {
    const path = shellQuote(`/etc/config/${configKey}`);
    const text = uciFileText(sections, redact);
    const delimiter = heredocDelimiter(text);
    // Owner-only, like the provision script: a config can hold secrets, and
    // a new file would otherwise take the shell's umask.
    return [`if [ ! -e ${path} ]; then`, `(umask 077; cat > ${path}) <<'${delimiter}'`, `${text}${delimiter}`, "fi"].join("\n");
  });

/** The stock configs apk set aside for an owned config: never used. */
const stockConfigCleanup = (state: OpenWrtState) => {
  const paths = ownedConfigs(state).map(([configKey]) => shellQuote(`/etc/config/${configKey}.apk-new`));
  return paths.length ? [`rm -f ${paths.join(" ")}`] : [];
};

/**
 * Stage the declared config over a wiped one, in a single `uci batch`: delete
 * every section of `current` that `configs_to_not_reset` does not keep, by
 * exact name, then set every declared section. `current` must be read after
 * the prepare step, or sections a package adds survive the wipe. Then write
 * the managed files. Leaving `managedFiles` out prunes nothing.
 */
export const getStageCommands = ({
  state,
  current,
  managedFiles,
  redact,
}: {
  state: OpenWrtState;
  current: UciConfigs;
  /** From the managedFiles probe: what the previous provision wrote. */
  managedFiles?: string[];
  /** Replace a resolved secret before it is written into the script. */
  redact?: (value: string) => string;
}) => {
  const hide = (value: string) => (redact ? redact(value) : value);
  const wipe = wipeOperations(current, state.configsToNotReset || []).map(
    (operation) => `uci ${operation}`
  );
  const uciCommands = getUciCommands({ openWrtConfig: state.config, redact });

  const files = state.files || [];
  const staleFiles = (managedFiles || []).filter(
    (path) => !files.find((file) => file.path === path)
  );

  const fileCommands =
    files.length > 0 || staleFiles.length > 0
      ? [
          ...staleFiles.map((path) => `rm -f ${shellQuote(path)}`),
          ...files.flatMap((file) => [
            writeFileCommand(file.path, hide(file.content), file.mode),
            // Optional command run immediately after the file is written (e.g.
            // trigger a freshly-written hotplug script so it applies now).
            ...(file.run_after ? [hide(file.run_after)] : []),
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
  return [...uciBatchCommands([...wipe, ...uciCommands]), ...fileCommands];
};

/**
 * The whole run as one script, for a dry run. `provision` runs it in parts
 * (see devicePhases), reading the device's config between the prepare and
 * stage steps; here `current` is read up front, so sections that packages
 * installed by this run would add are not shown being wiped. Leaving
 * `current` out wipes nothing.
 */
export const getDeviceScript = ({
  state,
  installedPackages,
  managedFiles,
  current = {},
  redact,
}: {
  state: OpenWrtState;
  installedPackages?: string[];
  managedFiles?: string[];
  current?: UciConfigs;
  redact?: (value: string) => string;
}) => [
  ...getPrepareCommands({ state, installedPackages, redact }),
  ...getStageCommands({ state, current, managedFiles, redact }),
  ...getFinaliseCommands({ state, current }),
  // Printed so a dry run shows the whole sequence, but `provision` runs these
  // over a reconnected session. See `getPostReloadCommands`.
  ...getPostReloadCommands(state).map((command) =>
    redact ? redact(command) : command
  ),
];

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
