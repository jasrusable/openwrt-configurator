// Addresses, ranges and ports: what each must be to reach the devices intact.
// Checked properly rather than by shape, because fw4 hands a range to nft as
// written: a prefix too long for its family makes nft refuse the whole ruleset
// (fw4 still exits 0, so the router keeps the old rules until a reboot, then
// has none), and an octet over 255 makes fw4 skip the rule (verified on
// 25.12.5).

/** An IPv4 address as a number, or undefined if it is not one. */
export const parseIpv4 = (address: string) => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  const octets = match?.slice(1).map(Number);
  return octets && octets.every((o) => o <= 255)
    ? octets.reduce((n, o) => n * 256 + o, 0)
    : undefined;
};

/** Whether `address` is an IPv6 address: hex groups, at most one "::". */
export const isIpv6Address = (address: string) => {
  const halves = address.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half === "" ? [] : half.split(":")));
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return false;
  return halves.length === 2 ? groups.length <= 7 : groups.length === 8;
};

/** Whether an address (or range) is IPv6: what decides a rule's family. */
export const isIpv6 = (address: string) => address.includes(":");

/** An IPv4 or IPv6 address. */
export const isIpAddress = (address: string) =>
  parseIpv4(address) !== undefined || isIpv6Address(address);

/** An address, or a range as address/prefix with a prefix its family allows. */
export const isAddressOrRange = (value: string) => {
  const [address, length, ...rest] = value.split("/");
  if (rest.length) return false;
  const bits = parseIpv4(address) !== undefined ? 32 : isIpv6Address(address) ? 128 : undefined;
  if (bits === undefined) return false;
  return length === undefined || (/^\d{1,3}$/.test(length) && Number(length) <= bits);
};

/** A port: 1 to 65535. */
export const isPort = (port: string) => /^\d{1,5}$/.test(port) && +port >= 1 && +port <= 65535;

/** A port or a range: "443", "8000-8100". */
export const isPortRange = (value: string) => {
  const [from, to, ...rest] = value.split("-");
  return !rest.length && isPort(from) && (to === undefined || (isPort(to) && +to >= +from));
};

/** A prefix length as a netmask: 24 -> 255.255.255.0. */
export const netmask = (length: number) => {
  const bits = 2 ** 32 - 2 ** (32 - length);
  return [24, 16, 8, 0].map((shift) => Math.floor(bits / 2 ** shift) % 256).join(".");
};

/** A range as numbers: its first address and its size; undefined if it is not one. */
export const parseCidr = (cidr: string) => {
  const [address, length] = cidr.split("/");
  const start = parseIpv4(address ?? "");
  const bits = Number(length);
  if (start === undefined || !Number.isInteger(bits) || bits < 8 || bits > 32) return undefined;
  const size = 2 ** (32 - bits);
  return start % size === 0 ? { start, size } : undefined;
};

/** Whether two IPv4 ranges share any address. */
export const overlaps = (a: string, b: string) => {
  const [x, y] = [parseCidr(a), parseCidr(b)];
  return !!x && !!y && x.start < y.start + y.size && y.start < x.start + x.size;
};

/** The network (of those given) whose subnet holds an IPv4 address. */
export const networkHolding = <N extends { subnet: string }>(networks: N[], address: string) =>
  parseIpv4(address) === undefined ? undefined : networks.find((n) => overlaps(n.subnet, `${address}/32`));
