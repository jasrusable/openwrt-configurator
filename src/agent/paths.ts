// Where an apply keeps its state on a device: the contract between the agent
// (script.ts) and whatever else on the device must know an apply is running
// (the mesh rescue watcher, compiled into a device file). No imports, so the
// compiler can use it without depending on the engine.

/** The device's RAM: the agent's paths grow from here (ONC_TMP in tests). */
export const deviceTmp = "/tmp";
/** The agent script's name, before its run id: `onc-agent-<runId>.sh`. */
export const agentName = "onc-agent-";
/** A run's own directory's name, before its run id: snapshots, lists, markers. */
export const runDirName = "onc-run-";
/** The step verbs' own directory's name, before its run id: their records, while they work. */
export const stepsDirName = "onc-steps-";
/** In a run's directory while its watchdog runs: that watchdog's pid. */
export const watchdogPidFile = "watchdog.pid";

/** Where a run's agent lives on the device: per run, so two runs never touch each other's. */
export const agentPath = (runId: string) => `${deviceTmp}/${agentName}${runId}.sh`;

/** Every running apply's watchdog pid file, as a shell glob. */
export const watchdogPidGlob = `${deviceTmp}/${runDirName}*/${watchdogPidFile}`;

/**
 * Every apply's agent, as a shell glob: there from the start of a run on the
 * device until it is over (`done`, or its watchdog's own clean-up).
 */
export const agentGlob = `${deviceTmp}/${agentName}*.sh`;

/**
 * On a device an apply has confirmed: its settings are this app's, so an
 * image's first-boot script (src/firmware/firstBoot.ts) leaves them alone
 * after an upgrade that kept them. Kept through upgrades by its keep.d list.
 */
export const appliedMarker = "/etc/onc/applied";
/** What sysupgrade keeps for the marker (one list per package or purpose in keep.d). */
export const appliedKeepList = "/lib/upgrade/keep.d/onc-applied";
/**
 * What sysupgrade keeps of the managed files, written with them: kept as the
 * config is, so a fix in a file is not off from a flash until the apply after it.
 */
export const filesKeepList = "/lib/upgrade/keep.d/onc-files";
