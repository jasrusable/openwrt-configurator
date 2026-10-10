// The firewall, on the router, one to one with fw4: defaults, the zones (the
// WAN zone covering the internet interfaces), forwardings, rules in their
// order, and port forwards (DNAT) into the zone of their target's network.
import { wanZone, Zone } from "../firewall";
import { Feature, onRouter } from "../fragment";

type Section = Record<string, unknown>;

const upper = (policy: string) => policy.toUpperCase();

export const firewall: Feature = (intent) => {
  const { defaults, zones, forwardings, rules, port_forwards } = intent.firewall;
  const { connection, ipv6 } = intent.internet;
  const routerOnly = (sections: Section[]) =>
    sections.map((section) => ({ ".if": onRouter, ...section }));
  // The interfaces the internet connection makes (features/internet.ts).
  const wanInterfaces = ipv6 && connection.type === "dhcp" ? ["wan", "wan6"] : ["wan"];
  const zoneOfNetwork = (id: string) => zones.find((z) => z.networks.includes(id))?.id;
  // The zone of the network an address is on: where a port forward lands.
  const zoneOfAddress = (address: string) => {
    const prefix = address.split(".").slice(0, 3).join(".");
    const network = intent.networks.find((n) => n.subnet.startsWith(`${prefix}.`));
    return network && zoneOfNetwork(network.id);
  };

  return {
    config: {
      firewall: {
        defaults: routerOnly([
          {
            input: upper(defaults.input),
            output: upper(defaults.output),
            forward: upper(defaults.forward),
            synflood_protect: defaults.syn_flood_protection,
            drop_invalid: defaults.drop_invalid,
          },
        ]),
        zone: routerOnly(
          zones.map((zone: Zone) => ({
            name: zone.id,
            input: upper(zone.input),
            output: upper(zone.output),
            forward: upper(zone.forward),
            ...(zone.masquerade ? { masq: true } : {}),
            ...(zone.mss_clamping ? { mtu_fix: true } : {}),
            network: zone.id === wanZone ? wanInterfaces : zone.networks,
          }))
        ),
        forwarding: routerOnly(forwardings.map((f) => ({ src: f.from, dest: f.to }))),
        rule: routerOnly(
          rules.map(
            (rule): Section => ({
              name: rule.name,
              ...(rule.enabled ? {} : { enabled: false }),
              src: rule.from,
              // "router" is fw4's input: a rule with no destination zone.
              ...(rule.to === "router" ? {} : { dest: rule.to }),
              ...(rule.source_addresses?.length ? { src_ip: rule.source_addresses } : {}),
              ...(rule.source_port ? { src_port: rule.source_port } : {}),
              ...(rule.destination_addresses?.length
                ? { dest_ip: rule.destination_addresses }
                : {}),
              ...(rule.destination_port ? { dest_port: rule.destination_port } : {}),
              proto: rule.protocols,
              ...(rule.icmp_types?.length ? { icmp_type: rule.icmp_types } : {}),
              ...(rule.limit ? { limit: rule.limit } : {}),
              ...(rule.family !== "any" ? { family: rule.family } : {}),
              target: upper(rule.action),
            })
          )
        ),
        redirect: routerOnly(
          port_forwards.map((forward) => ({
            name: forward.name,
            ...(forward.enabled ? {} : { enabled: false }),
            target: "DNAT",
            src: wanZone,
            src_dport: forward.external_port,
            proto: forward.protocol === "tcp+udp" ? ["tcp", "udp"] : [forward.protocol],
            ...(forward.source_addresses?.length
              ? { src_ip: forward.source_addresses }
              : {}),
            dest: zoneOfAddress(forward.internal_address),
            dest_ip: forward.internal_address,
            dest_port: forward.internal_port ?? forward.external_port,
            family: "ipv4",
            reflection: forward.reflection,
          }))
        ),
      },
    },
  };
};
