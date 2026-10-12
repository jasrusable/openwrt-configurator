// A provider's .ovpn is pasted from elsewhere and run by OpenVPN as root:
// a line that runs a program, loads a plugin, reads another config or
// writes a file there would run whatever the file's author chose. Such a
// file is refused, not edited, so the user sees why; ovpnFile also drops
// them and ends with script-security 1, in case one slips past.
export const ovpnUnsafeDirectives = [
  "script-security",
  "up",
  "down",
  "route-up",
  "route-pre-down",
  "ipchange",
  "tls-verify",
  "auth-user-pass-verify",
  "client-connect",
  "client-disconnect",
  "learn-address",
  "plugin",
  "iproute",
  "management",
  "config",
  "cd",
  "chroot",
  "daemon",
  "log",
  "log-append",
  "writepid",
  "status",
  "tmp-dir",
  "setenv",
  "setenv-safe",
];

const unsafeLine = new RegExp(`^\\s*(?:--)?(${ovpnUnsafeDirectives.join("|")})(?:\\s|$)`, "i");

/** The directives in `config` that would run or write something, each once. */
export const ovpnUnsafe = (config: string) => [
  ...new Set(config.split(/\r?\n/).flatMap((line) => unsafeLine.exec(line)?.[1].toLowerCase() ?? [])),
];

/** The file without them. */
export const ovpnSafeLines = (config: string) => config.split(/\r?\n/).filter((line) => !unsafeLine.test(line));
