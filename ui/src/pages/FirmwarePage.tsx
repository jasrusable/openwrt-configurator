// System › Firmware: which OpenWrt the devices run. The network follows a
// series (its newest release) or one release; each device follows it, holds
// what it runs, or is pinned to another. Where each stands comes from the
// draft, its facts and OpenWrt's releases (src/firmware/target.ts).
import { Alert } from "@mantine/core";
import { defaultSeries, newerSeries, newestStable, Releases } from "../../../src/firmware/target";
import type { Intent } from "../../../src/intent/schema";
import { placeName } from "../../../src/intent/places";
import { isSeries, uncheckedSeries } from "../../../src/release";
import { useFirmwareRows, useReleases } from "../data/firmware";
import { ago } from "../facts";
import { useDraftValue } from "../form/draft";
import { SelectField } from "../form/fields";
import { Section, SettingsPage } from "../kit/layout";
import { UpgradeSection } from "../firmware/UpgradeSection";
import { allReleases, DeviceFirmwareField, withHeld } from "../firmware/DeviceFirmware";

const newestOf = (series: string, releases?: Releases) => releases?.series[series]?.[0];

/** Said beside a release of a series this app has not been checked against. */
const unchecked = (version?: string) => (version && uncheckedSeries(version) ? " · new series, not yet checked by this app" : "");

const seriesLabel = (series: string, releases?: Releases) => {
  const newest = newestOf(series, releases);
  return `Latest ${series}.x${newest ? ` (${newest})` : ""}${unchecked(newest)}`;
};

const NetworkRelease = ({ releases, error, checkedAt }: { releases?: Releases; error?: string; checkedAt?: number }) => {
  const intent: Intent = useDraftValue();
  // Unset is the default series: offered as the empty choice, not again.
  const series = Object.keys(releases?.series ?? {}).filter((s) => s !== defaultSeries);
  const stable = newestStable(releases);
  const values = withHeld([...series, ...allReleases(releases)], [intent.system.firmware?.release]).filter((v) => v !== "stable");
  const options = [
    { value: "stable", label: `Latest OpenWrt${stable ? ` (${stable})` : ""}${unchecked(stable)}` },
    ...values.map((v) => ({ value: v, label: isSeries(v) ? seriesLabel(v, releases) : `${v}${unchecked(v)}` })),
  ];
  const newer = newerSeries(intent, releases);
  const checked = checkedAt ? `Checked with OpenWrt ${ago(checkedAt)}.` : "Not checked with OpenWrt yet.";
  return (
    <Section
      title="Release"
      description={
        <>
          {error ? `${error} ` : ""}
          {checked}
          {newer.length > 0 && ` OpenWrt ${newer[0]} is out, a new series: choose it here, or Latest OpenWrt, to move to it.`}
          {" Release candidates and snapshots never count as the latest; nothing is flashed until you upgrade below."}
        </>
      }
    >
      <SelectField name="system.firmware.release" emptyLabel={seriesLabel(defaultSeries, releases)} options={options} />
    </Section>
  );
};

/** Each device's choice, in the table every device shares (each also on its own page in Hardware). */
const Devices = () => {
  const rows = useFirmwareRows();
  return (
    <Section title="Devices" description="Each follows the network's release, unless it holds or has its own.">
      {rows.map((row, i) => (
        <DeviceFirmwareField key={row.device} index={i} label={row.device} />
      ))}
    </Section>
  );
};

export const FirmwarePage = () => {
  const answer = useReleases();
  const releases = answer.data?.releases;
  const error = answer.data?.error ?? (answer.error ? (answer.error as Error).message : undefined);
  const self = answer.data?.selfUpgrade;
  return (
    <SettingsPage title={placeName("firmware")} description="Which OpenWrt your devices run, and upgrading them with their settings kept.">
      {self && Date.now() - self.at < 24 * 3_600_000 && (
        <Alert color={self.ok ? "green" : "red"} title={self.ok ? "The router upgraded itself" : "The router's upgrade did not finish"}>
          {self.message}
        </Alert>
      )}
      <NetworkRelease releases={releases} error={error} checkedAt={releases?.at} />
      <UpgradeSection />
      <Devices />
    </SettingsPage>
  );
};
