// What each feature module contributes to the plan (src/plan/types.ts), and
// how the pieces are combined. Features never see device facts: anything
// that depends on the device is left to a condition (`when`) or a
// placeholder the engine resolves against the live device.
import { Fragment, Plan, Section, Service } from "../plan/types";
import { when, When } from "../plan/when";
import { hostIn } from "./addresses";
import { Intent } from "./schema";

export type Feature = (intent: Intent) => Fragment;

export const everyDevice = when.always;
export const onRouter = when.role("router");
export const onAccessPoints = when.role("access-point");
/** A router with a radio. */
export const onRouterRadios = when.all(onRouter, when.any(when.radio("2g"), when.radio("5g"), when.radio("6g")));
/** Where Wi-Fi's packages and radios go: access points, and a router with a radio. */
export const onRadioDevices = when.any(onAccessPoints, onRouterRadios);
/** Whether the router broadcasts the SSIDs (where it has radios): unless its Wi-Fi is off. */
export const routerBroadcasts = (intent: Pick<Intent, "hardware">) => intent.hardware.find((d) => d.role === "router")?.wifi !== false;
/** Where the SSIDs go out: every access point, and the router unless its Wi-Fi is off. */
export const onBroadcasting = (intent: Pick<Intent, "hardware">) => (routerBroadcasts(intent) ? onRadioDevices : onAccessPoints);
export const onDevice = when.device;
/** A swconfig switch (VLANs tagged in the switch), or DSA (a bridge that filters VLANs). */
export const onSwConfig = when.swConfig(true);
export const onDsa = when.swConfig(false);

/** Sections for the router alone (one with its own condition: there, and only on the router). */
export const routerOnly = (sections: Section[]): Section[] => sections.map((s) => ({ ...s, when: when.all(onRouter, s.when ?? when.always) }));

export type Network = Intent["networks"][number];

/** Whether a network is the main one: untagged, the one devices are managed over. */
export const isMain = (network: Pick<Network, "vlan">) => network.vlan === undefined;

/** The main network. */
export const mainNetwork = (intent: Pick<Intent, "networks">) => intent.networks.find(isMain)!;

/** The router takes the first address of each network. */
export const gatewayOf = (network: Pick<Network, "subnet">) => hostIn(network.subnet, 1);

/** The router's address on the main network: how it is managed. */
export const routerAddress = (intent: Intent) => gatewayOf(mainNetwork(intent));

type Merged = Omit<Plan, "version">;

/** Fragments in order: lists concatenated, sections appended under their config and type. */
export const merge = (fragments: Fragment[]): Merged =>
  fragments.reduce<Merged>(
    (acc, fragment) => ({
      devices: [...acc.devices, ...(fragment.devices || [])],
      packages: [...acc.packages, ...(fragment.packages || [])],
      keep: [...acc.keep, ...(fragment.keep || [])],
      services: [...acc.services, ...(fragment.services || [])],
      files: [...acc.files, ...(fragment.files || [])],
      config: Object.entries(fragment.config || {}).reduce(
        (config, [configKey, types]) => ({
          ...config,
          [configKey]: Object.entries(types).reduce(
            (sections, [type, list]) => ({ ...sections, [type]: [...(sections[type] || []), ...list] }),
            config[configKey] || {}
          ),
        }),
        acc.config
      ),
    }),
    { devices: [], packages: [], keep: [], services: [], files: [], config: {} }
  );

/**
 * A service its feature runs when used, else installed but off: stopped and
 * disabled. An empty or disabled config is not always nothing (https-dns-proxy
 * kept a resolver and a firewall table, usteer ran despite enabled 0, mwan3
 * marked every packet; verified on 25.12.5).
 */
export const serviceWhen = (condition: When, name: string, used: boolean): Service =>
  used ? { when: condition, name, running: true } : { when: condition, name, enabled: false };

/**
 * How every DHCP client the app declares (a line, an access point's own
 * address) holds on to what it was given, IPv4 and IPv6 alike:
 * - the MAC as its identity (25.12.6's `sendclientid`; older releases ignore
 *   it): a flash's first boot writes a random dhcp_default_duid (base-files'
 *   14_network-generate-duid; see networks/compile.ts on globals), which would
 *   otherwise be sent as the client-id until the next apply wipes it;
 * - no release when it stops (`norelease`): netifd's clients release on every
 *   stop, so an apply that restarts the interface, or a reboot, hands the
 *   address or delegated prefix back, and the next request may get another.
 * Seen on the user's network, 25.12.6: an access point moved address on a
 * flash and again on an apply, and the router's prefix changed across its
 * flash, leaving clients with dead IPv6 addresses.
 */
export const dhcpClient = { sendclientid: "hardware", norelease: true } as const;
