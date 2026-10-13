// A fake network of devices for locating and reading them without SSH: each
// answers the probes as a device does, and connect checks host keys as the
// real platforms do.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { checkHostKey, formatKnownHost, parseKnownHosts } from "../../knownHosts";
import { Platform, Session, SshTarget } from "../../platform";
import { nodePlatform } from "../../platforms/node";
import { tempDir } from "./tempDir";

/** A machine on the fake network: its board, MACs, host key, and (a router) its tables. */
export type Machine = { board: string; macs: string[]; key: string; leases?: string; neighbours?: string; ip?: string };

export const board = (id: string) =>
  JSON.stringify({ model: { id, name: id }, network: { lan: { ports: ["lan1"], protocol: "static" } } });

/** Answers the probes the way a device does: each output, then its exit marker. */
export const session = (m: Machine): Session => ({
  execCommand: async (command: string) => {
    const parts = command.split(/\n\) 2>\/dev\/null; printf '\\n__ONC_PROBE__%s\\n' "\$\?"\n?/).filter((p) => p.trim());
    const answer = (part: string) =>
      part.includes("board.json")
        ? m.board
        : part.includes("ubus call uci get")
        ? '{"values":{}}'
        : part.includes("ubus call system board")
        ? JSON.stringify({ board_name: JSON.parse(m.board).model.id, release: { version: "25.12.5" } })
        : part.includes("/sys/class/net")
        ? m.macs.join("\n")
        : part.includes("dhcp.leases")
        ? m.leases ?? ""
        : part.includes("neigh")
        ? m.neighbours ?? ""
        : part.includes("SSH_CONNECTION")
        ? m.ip ?? ""
        : "";
    return { stdout: parts.map((p) => `${answer(p)}\n__ONC_PROBE__0\n`).join(""), stderr: "", code: 0 };
  },
  dispose: () => {},
});

/** A network of machines by address; connect checks host keys as the real platforms do. */
export const network = (machines: Record<string, Machine>) => {
  const knownHosts = join(tempDir("locate"), "known_hosts");
  writeFileSync(knownHosts, "");
  const tried: string[] = [];
  const platform: Platform = {
    ...nodePlatform,
    env: (name) => (name === "ONC_KNOWN_HOSTS" ? knownHosts : undefined),
    connect: async (target: SshTarget) => {
      const host = target.host ?? "";
      tried.push(host);
      const m = machines[host];
      if (!m) throw new Error("connect ECONNREFUSED");
      const offered = { host, type: "ssh-ed25519", key: m.key };
      // A pinned key is checked by the client itself; the file is not involved.
      if (target.hostKey) {
        if (target.hostKey.key !== m.key || target.hostKey.type !== offered.type) throw new Error("host key changed");
        return session(m);
      }
      const seen = checkHostKey(parseKnownHosts(readFileSync(knownHosts, "utf8")), offered);
      if (seen === "changed") throw new Error("host key changed");
      if (seen === "new") writeFileSync(knownHosts, readFileSync(knownHosts, "utf8") + formatKnownHost(offered));
      return session(m);
    },
  };
  return { platform, tried, knownHosts };
};

