// What a device's status read says, as the app's own types (never raw ubus).

export type InterfaceStatus = {
  /** The UCI interface: lan, guest, wan, wan6... */
  id: string;
  up: boolean;
  /** Seconds up. */
  uptime?: number;
  /** The Linux device it runs on, e.g. br-lan.20 or eth1. */
  device?: string;
  ipv4: string[];
  ipv6: string[];
};

export type WifiClient = {
  mac: string;
  signal?: number;
  rxBytes?: number;
  txBytes?: number;
  /** Seconds since it associated. */
  connected?: number;
};

export type WifiInterface = {
  /** hostapd's interface, e.g. phy1-ap0. */
  ifname: string;
  ssid?: string;
  /** MHz. */
  freq?: number;
  channel?: number;
  /** From iwinfo: the mode and width (HE80), transmit power (dBm), noise floor (dBm). */
  htmode?: string;
  txpower?: number;
  noise?: number;
  clients: WifiClient[];
};

/** A port's link: up, and at what speed (Mbit/s) when it says. */
export type PortLink = { name: string; up: boolean; speed?: number };

/** Router advertisements sent and solicitations heard, per device, since it came up. */
/**
 * Router adverts sent and solicitations heard on a device since it came up,
 * and the counts a little while before (`before`, `seconds` ago), so silence
 * can be told now rather than since boot.
 */
export type Adverts = { device: string; sent: number; solicits: number; before?: { sent: number; solicits: number; seconds: number } };

/** The kernel's neighbour table: who answered on which address lately. */
/** One entry of the router's neighbour table, with the interface it was seen on. */
export type NeighbourEntry = { address: string; mac: string; state: string; device?: string };

/** odhcpd's IPv6 leases: by DUID, the MAC where the DUID holds one. */
export type Ipv6Lease = { duid: string; mac?: string; hostname?: string; addresses: string[] };

/** Read only for the Performance view: how the line is doing from the router. */
export type InternetCheck = {
  /** Average round trip to a public resolver, ms; undefined when none answered. */
  latencyMs?: number;
  /** The address the internet sees (another NAT may sit before the router's WAN). */
  publicIpv4?: string;
  /** The router's own DNS (dnsmasq, and its upstream) answering. */
  dnsOk: boolean;
  /** Smart queueing on each device it shapes: bytes sent and packets it dropped (to keep latency down). */
  queues: { device: string; sentBytes: number; dropped: number }[];
};

/** Read only for the Activity view: a device's own log, the lines worth telling. */
export type LogLine = { at: number; text: string };

export type Lease = { mac: string; address: string; name?: string; /** s since the epoch */ expires: number };

/** A device heard over mDNS (the router's umdns): what it calls itself, where, and what it is. */
export type MdnsDevice = {
  /** Its host name, without .local. */
  host: string;
  /** What it calls itself: a naming service's instance ("Jason's iPhone"), else its host name. */
  name: string;
  addresses: string[];
  /** Where it says: Apple's device-info model ("iPhone15,2"), a Cast device's ("Chromecast"). */
  model?: string;
  services: string[];
};

export type DeviceStatus = {
  hostname: string;
  readAt: number;
  /** Seconds since boot. */
  uptime: number;
  /** 1, 5 and 15 minute load averages. */
  load: [number, number, number];
  memory: { total: number; available: number };
  interfaces: InterfaceStatus[];
  wifi: WifiInterface[];
  leases: Lease[];
  /** mwan3's view of each line, where it runs (a router with several connections). */
  lines: LineStatus[];
  /** Its mesh neighbours, where batman-adv runs: each directly linked node and the link's quality. */
  mesh: MeshNeighbour[];
  /**
   * The largest frame the mesh over cables carries whole here: the smallest
   * MTU of its VLAN and the bridge's ports (a bridge may claim more than its
   * ports take). Undefined where there is none.
   */
  meshWiredMtu?: number;
  /**
   * Over that VLAN, how many nodes answered a small ping and how many a
   * full-size one (all on-link, ff02::1): fewer for the large means a switch
   * between drops the mesh's larger frames, which would lose packets.
   */
  meshWiredPath?: { small: number; large: number };
  /** Its link splits batman's frames by design (a switch's): an MTU under the mesh's is no fault there. */
  meshWiredSplits?: true;
  /** Its WireGuard peers: when each last completed a handshake. */
  wireguard: WireguardPeer[];
  /** Free and total space where packages and config live (the overlay), KiB. */
  storage?: { availableKb: number; totalKb: number };
  /** The hottest thermal zone, °C, where it has any. */
  temperature?: number;
  /** Each network device's link (Wi-Fi interfaces too; the UI picks the ports). */
  links: PortLink[];
  adverts: Adverts[];
  neighbours: NeighbourEntry[];
  ipv6Leases: Ipv6Lease[];
  /** Of the services the settings say must run, those that are not (or are not installed). */
  notRunning: { name: string; missing: boolean }[];
  /** What it answered that could not be read (hostapd, mwan3, …): left out, rather than the whole device. */
  unread: string[];
  internet?: InternetCheck;
  log?: LogLine[];
  /** Bytes received and sent on each network device since it came up: rates come from two reads. */
  counters: Record<string, { rx: number; tx: number }>;
  /** Processor cores: a load of 1 per core is busy. */
  cores?: number;
  /** nlbwmon's traffic per client MAC since its database began (the router). */
  traffic: Record<string, { rx: number; tx: number }>;
  /** Devices heard over mDNS (the router). */
  mdns: MdnsDevice[];
  /** usteer's view of each client: which of its nodes hear it, how well, which it is on. */
  heardBy: { mac: string; node: string; signal?: number; connected: boolean }[];
};

export type WireguardPeer = {
  /** The WireGuard interface: vpn, sites, tun1. */
  iface: string;
  publicKey: string;
  /** Seconds since its last handshake; undefined if it has never made one. */
  since?: number;
};

export type MeshNeighbour = {
  /** The node, by its batman address (its first interface's MAC). */
  originator: string;
  /** The next hop to it: the MAC of the neighbour's interface on the link. */
  mac: string;
  /** BATMAN_V's estimate of the route's throughput, in Mbit/s. */
  throughput: number;
  /** Seconds since it was last heard. */
  lastSeen: number;
};

export type LineStatus = {
  /** The connection's interface: wan, wanb. */
  id: string;
  /** online, offline, connecting (coming back), disconnecting (failing), or mwan3's other words. */
  state: string;
  /** Seconds in that state: online for, or offline for. */
  since: number;
};
