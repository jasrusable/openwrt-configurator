// A radio's mode (htmode) from what it supports. The compiler, which knows no
// hardware, asks for "@best/<width>"; the engine resolves it per radio as
// OpenWrt's own setup (mac80211.uc) picks one: the newest standard the radio
// has (EHT, Wi-Fi 7; HE, 6; VHT, 5; HT, 4) at the widest width it supports up
// to the one asked for.

const families = ["EHT", "HE", "VHT", "HT"];

/** "@best/80" → 80; anything else is a mode as given. */
export const bestWidth = (htmode: unknown) => {
  const match = typeof htmode === "string" ? /^@best\/(\d+)$/.exec(htmode) : null;
  return match ? Number(match[1]) : undefined;
};

/**
 * The mode for `htmode` on a radio supporting `modes` (board.json's list, e.g.
 * HE80, VHT160). A radio whose modes are not known (no board.json `wlan`)
 * gets HE at the width, as before modes were read; one supporting none at
 * or below it gets none, leaving OpenWrt's default.
 */
export const resolveHtmode = (htmode: unknown, modes?: string[]) => {
  const width = bestWidth(htmode);
  if (width === undefined) return htmode as string | undefined;
  if (!modes) return `HE${width}`;
  const widths = [
    ...new Set(
      modes.flatMap((mode) => {
        const m = /^(?:EHT|HE|VHT|HT)(\d+)$/.exec(mode);
        return m ? [Number(m[1])] : [];
      })
    ),
  ]
    .filter((w) => w <= width)
    .sort((a, b) => b - a);
  for (const w of widths) {
    const family = families.find((f) => modes.includes(`${f}${w}`));
    if (family) return `${family}${w}`;
  }
  return undefined;
};
