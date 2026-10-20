// What an apply does on one device, as data: the records each of the agent's
// step verbs is given (src/agent: prepare, stage, finalise, services, hooks),
// worked out from the device's state and what was read from it. How each
// step is done, and why in that order, is the agent's (src/agent/script.ts).
// For a dry run, `getDeviceScript` shows the verbs with their records, as
// they would be sent.
import { AgentRecord, encodeRecords } from "./agent/records";
import { filesKeepList } from "./agent/paths";
import { Redact } from "./secretOptions";
import { UciOperation, uciLine, uciOperations } from "./engine/getUciCommands";
import { changedConfigs, declaredConfigs, uciFileText, UciConfigs, wipeOperations } from "./engine/uci";
import { OpenWrtState } from "./engine/openWrtState";

// Manifest of files written by this tool, so files removed from config are
// removed from the device on the next provision (declarative, like UCI resets).
export const managedFilesManifest = "/etc/onc/managed_files";

/** The packages a run installs: those the state names that the device lacks (all of them, unread). */
export const packagesToAdd = ({ state, installedPackages }: { state: OpenWrtState; installedPackages?: string[] }) =>
  state.packages.add.filter((name) => !installedPackages?.includes(name));

/** The packages a run removes: those the state removes that the device has (all of them, unread). */
export const getPackagesToRemove = ({ state, installedPackages }: { state: OpenWrtState; installedPackages?: string[] }) =>
  state.packages.remove.filter((name) => !installedPackages || installedPackages.includes(name));

/** Declared configs nothing of which is kept: the ones the tool writes whole. */
const ownedConfigs = (state: OpenWrtState) => {
  return Object.entries(declaredConfigs(state.config)).filter(
    ([configKey, sections]) => sections.length > 0 && !state.keep.some((entry) => entry.config === configKey)
  );
};

/** Where prepare seeds: a file it finds missing is a change only the watchdog can undo. */
export const seededConfigPaths = (state: OpenWrtState) => ownedConfigs(state).map(([configKey]) => `/etc/config/${configKey}`);

/**
 * Prepare's records: every owned config, for the device to write where it
 * has none (not a config anything of which is kept: a package that makes its
 * own on first boot, ubihealthd, skips that when the file exists), then the
 * packages to remove and to install. Leaving `installedPackages` out removes
 * and installs every package the state names.
 */
export const prepareRecords = ({
  state,
  installedPackages,
  redact,
}: {
  state: OpenWrtState;
  /** From the installedPackages probe. */
  installedPackages?: string[];
  redact?: Redact;
}): AgentRecord[] => [
  ...ownedConfigs(state).map(
    ([configKey, sections]): AgentRecord => ({ kind: "seed", path: `/etc/config/${configKey}`, content: uciFileText(sections, redact) })
  ),
  ...getPackagesToRemove({ state, installedPackages }).map((name): AgentRecord => ({ kind: "remove", name })),
  ...packagesToAdd({ state, installedPackages }).map((name): AgentRecord => ({ kind: "add", name })),
];

/**
 * uci operations as stage takes them: each run of one-line operations one
 * `uci batch` (one uci process: ~0.1 ms an operation, not ~1.5), and one whose
 * value spans lines on its own (the batch is line-oriented and would misread
 * it), in place: lists are ordered, and hoisting the rest ahead of it would
 * move a list's items.
 */
const uciRecords = (operations: (string | UciOperation)[]): AgentRecord[] =>
  operations.reduce<AgentRecord[]>((records, operation) => {
    if (typeof operation !== "string" && operation.op !== "section" && operation.value.includes("\n")) {
      return [...records, { kind: operation.op, key: operation.key, value: operation.value }];
    }
    const line = typeof operation === "string" ? operation : uciLine(operation);
    const last = records[records.length - 1];
    if (last?.kind !== "batch") return [...records, { kind: "batch", operations: [line] }];
    last.operations.push(line);
    return records;
  }, []);

/**
 * Stage's records: the declared config over a wiped one, then the managed
 * files. The wipe deletes every section of `current` that
 * `configs_to_not_reset` does not keep, by exact name; `current` must be read
 * after prepare, or sections a package adds survive it. Then the files no
 * longer declared, each declared file, and the manifest of them. Leaving
 * `managedFiles` out prunes nothing.
 */
export const stageRecords = ({
  state,
  current,
  managedFiles,
  redact,
}: {
  state: OpenWrtState;
  current: UciConfigs;
  /** From the managedFiles probe: what the previous provision wrote. */
  managedFiles?: string[];
  /** Replace a secret before it is sent. */
  redact?: Redact;
}): AgentRecord[] => {
  const files = state.files || [];
  const stale = (managedFiles || []).filter((path) => !files.some((file) => file.path === path));
  const operations = [
    ...wipeOperations(current, state.keep),
    ...uciOperations({ openWrtConfig: state.config, redact }),
  ];
  // The manifest, and sysupgrade's list keeping the files and it through a
  // flash that keeps the config: a fix is not off from the flash to the
  // apply after it, and one no longer declared on the new release is still
  // pruned then, its stock file put back (the agent's remove-file).
  const manifest: AgentRecord[] =
    files.length > 0 || stale.length > 0
      ? [
          { kind: "write", path: managedFilesManifest, mode: "0644", content: files.map((file) => file.path).join("\n") },
          { kind: "write", path: filesKeepList, mode: "0644", content: `${[...files.map((file) => file.path), managedFilesManifest].sort().join("\n")}\n` },
        ]
      : [];
  return [
    ...uciRecords(operations),
    ...stale.map((path): AgentRecord => ({ kind: "remove-file", path })),
    ...files.map(
      (file): AgentRecord => ({
        kind: "write",
        path: file.path,
        // With no mode, 0644, as it always was.
        mode: file.mode ?? "0644",
        content: redact ? redact(file.content, { file }) : file.content,
        ...(file.runAfter ? { runAfter: redact ? redact(file.runAfter) : file.runAfter } : {}),
      })
    ),
    ...manifest,
  ];
};

/**
 * Protocols netifd may not know (it learns its handlers only as it starts):
 * a declared interface's, but never its built-ins (none, static) or the ones
 * every image ships (dhcp, dhcpv6). Listing those restarted the network on
 * every apply to any device with a VLAN network.
 */
const builtinProtocols = ["none", "static", "dhcp", "dhcpv6"];

export const refreshedProtocols = (state: OpenWrtState) => [
  ...new Set(
    (state.config.network?.interface ?? []).flatMap((i) =>
      typeof i.proto === "string" && !builtinProtocols.includes(i.proto) ? [i.proto] : []
    )
  ),
];

/**
 * Finalise's records: each config this run changes, committed by name (a
 * bare `uci commit` would commit staged changes this tool did not make: a
 * LuCI session's, an earlier failed run's), and the protocols to check after
 * the reload. Its post-reload hooks are a step of their own (hooks).
 */
export const finaliseRecords = ({
  state,
  current,
}: {
  state: OpenWrtState;
  /** The device's config as read after prepare. */
  current: UciConfigs;
}): AgentRecord[] => [
  ...changedConfigs({ current, declared: declaredConfigs(state.config), keep: state.keep }).map(
    (config): AgentRecord => ({ kind: "commit", config })
  ),
  ...refreshedProtocols(state).map((name): AgentRecord => ({ kind: "protocol", name })),
];

/** The config a service reads, where it is not its own name. */
const serviceConfigs: Record<string, string> = { dnsmasq: "dhcp", odhcpd: "dhcp", sysntpd: "system", log: "system" };
export const configOfService = (name: string) => serviceConfigs[name] ?? name;

/** Whether a package matches one of a service's `restartOnPackages`: by name, or by a prefix ending in `*`. */
const matchesPackage = (patterns: string[]) => (name: string) =>
  patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));

/**
 * Services' records: every declared service enabled and started, or (its
 * feature unused) stopped and disabled; and restarted after the reload when
 * this run changed its config and procd holds no reload trigger of its for
 * that config (`triggers`, per running service: which configs its triggers
 * watch), or a package it names was swapped. One procd does not know is
 * started afresh anyway, on the new config. Run over the first reconnect
 * after the commit, before the confirming one: a stopped firewall's new
 * rules take effect only as it starts, so a lockout there must still roll
 * back.
 */
export const servicesRecords = (
  state: OpenWrtState,
  triggers: Record<string, string[]> = {},
  /** The packages this run installs or removes. */
  changedPackages: string[] = []
): AgentRecord[] => {
  const enabled = state.services.filter((s) => s.enabled !== false);
  const swapped = (s: OpenWrtState["services"][number]) => changedPackages.some(matchesPackage(s.restartOnPackages ?? []));
  return [
    ...enabled.map((s): AgentRecord => ({ kind: "enable", name: s.name })),
    ...state.services.filter((s) => s.enabled === false).map((s): AgentRecord => ({ kind: "disable", name: s.name })),
    ...enabled.filter(swapped).map((s): AgentRecord => ({ kind: "restart", name: s.name })),
    ...enabled
      .filter((s) => !swapped(s) && s.name in triggers && !triggers[s.name].includes(configOfService(s.name)))
      .map((s): AgentRecord => ({ kind: "restart", name: s.name, config: configOfService(s.name) })),
  ];
};

/**
 * The hooks that need the new config live (run_after_reload, in file order),
 * run after the commit and reload over a reconnected session of their own:
 * reload_config is what can sever the link, and a hook after it in the same
 * verb would die with it.
 */
export const hookCommands = (state: OpenWrtState) =>
  state.files.flatMap((file) => (file.runAfterReload ? [file.runAfterReload] : []));

export const hookRecords = (commands: string[]): AgentRecord[] => commands.map((command) => ({ kind: "run", command }));

/** A heredoc delimiter that is none of the text's lines. */
const delimiterFor = (text: string, base = "ONC_DATA") => {
  const lines = new Set(text.split("\n"));
  let delimiter = base;
  while (lines.has(delimiter)) delimiter = `${delimiter}_`;
  return delimiter;
};

/** One verb with its records, as it is sent: what a dry run shows. */
export const renderVerb = (name: string, records: AgentRecord[]) => {
  const data = encodeRecords(records);
  const delimiter = delimiterFor(data);
  return `onc-agent ${name} <<'${delimiter}'\n${data}${delimiter}`;
};

/**
 * The whole run, for a dry run: each verb `provision` calls, with its
 * records, in order. `provision` reads the device's config between prepare
 * and stage; here `current` is read up front, so sections that packages
 * installed by this run would add are not shown being wiped. Leaving
 * `current` out wipes nothing. Services and hooks show only when there are any.
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
  redact?: Redact;
}) => {
  const changed = installedPackages
    ? [...packagesToAdd({ state, installedPackages }), ...getPackagesToRemove({ state, installedPackages })]
    : [];
  const services = servicesRecords(state, {}, changed);
  const hooks = hookRecords(hookCommands(state).map((command) => (redact ? redact(command) : command)));
  return [
    renderVerb("prepare", prepareRecords({ state, installedPackages, redact })),
    renderVerb("stage", stageRecords({ state, current, managedFiles, redact })),
    renderVerb("finalise", finaliseRecords({ state, current })),
    ...(services.length > 0 ? [renderVerb("services", services)] : []),
    ...(hooks.length > 0 ? [renderVerb("hooks", hooks)] : []),
  ];
};
