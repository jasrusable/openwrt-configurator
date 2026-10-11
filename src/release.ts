// The OpenWrt releases this tool provisions. It drives apk, OpenWrt's package
// manager from 25.12 on (and in snapshots since late 2024); older releases
// have opkg and other package names, so a device on one is refused before
// anything is touched, rather than failing partway, at the package step.
export const supportedRelease = (version: string) => {
  if (/^SNAPSHOT/i.test(version)) return true;
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 25 || (major === 25 && minor >= 12);
};

export const assertSupportedRelease = (hostname: string, version: string) => {
  if (!supportedRelease(version)) {
    throw new Error(
      `${hostname} runs OpenWrt ${version}; this tool needs 25.12 or later ` +
        `(it installs packages with apk). build-images can make an image to upgrade it.`
    );
  }
};
