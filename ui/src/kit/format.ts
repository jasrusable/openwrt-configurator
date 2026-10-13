// Amounts in words, one place for every page.

export const bitsWords = (bps?: number) =>
  bps === undefined
    ? "—"
    : bps >= 1e9
      ? `${(bps / 1e9).toFixed(1)} Gbit/s`
      : bps >= 1e6
        ? `${(bps / 1e6).toFixed(1)} Mbit/s`
        : bps >= 1e3
          ? `${Math.round(bps / 1e3)} kbit/s`
          : `${Math.round(bps)} bit/s`;

export const bytes = (n: number) =>
  n >= 1e12 ? `${(n / 1e12).toFixed(1)} TB` : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`;

/** A port's link speed (Mbit/s), short: "2.5 G", "100 M". */
export const linkWords = (mbps: number) => (mbps >= 1000 ? `${mbps / 1000} G` : `${mbps} M`);
