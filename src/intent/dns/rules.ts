// What the DNS settings may be, given the rest.
import type { Choice } from "../feature";
import { where } from "../places";

export const dnsRules: Choice[] = [
  {
    path: "dns.upstream.type",
    values: ["provider"],
    unavailable: (intent) => {
      const bare = intent.internet.lines.find((l) => l.type === "static" && !l.static.dns?.length);
      return (
        bare &&
        `${bare.name || "An internet line"} is set by hand, without DNS servers: add them under ${where("internet")} first.`
      );
    },
    // Reported at the line's DNS servers, where they are missing.
    refuses: false,
  },
];
