// Fixes: what this app layers over OpenWrt for known problems, each with why,
// what it changes, where it applies on each device, its sources, and when it
// goes. One can be turned off unless its absence breaks something silently;
// a fix (not a tuning) asks first. Your settings are never changed by a fix:
// a setting a fix overrides keeps your value, which applies again once the
// fix does not.
import { Badge, Button, Group, Stack, Switch, Text, Tooltip } from "@mantine/core";
import { useState } from "react";
import { placeName } from "../../../src/intent/places";
import type { FixView } from "../../../src/intent/patches/status";
import { FixStateBadge, References, useFixes, useFixSwitch } from "../fixes";
import { Section, SettingRow, SettingsPage } from "../kit/layout";

const Fix = ({ fix }: { fix: FixView }) => {
  const { isOff, turnOff, turnOn } = useFixSwitch();
  const [confirming, setConfirming] = useState(false);
  const off = isOff(fix.id);
  const toggle = () => {
    if (off) return turnOn(fix.id);
    // A fix holds off a known problem: say what turning it off brings back first.
    if (fix.kind === "fix") return setConfirming(true);
    turnOff(fix.id);
  };
  const control = (
    <Switch
      checked={!off}
      disabled={fix.required}
      onChange={toggle}
      aria-label={`${fix.title}: ${off ? "off" : "on"}`}
    />
  );
  return (
    <Section
      title={
        <Group gap={6}>
          {fix.title}
          <Badge variant="light" color={fix.kind === "fix" ? "orange" : "grape"} radius="sm" size="sm" style={{ textTransform: "none" }}>
            {fix.kind === "fix" ? "Fix" : "Tuning"}
          </Badge>
          {fix.required && (
            <Badge variant="outline" color="gray" radius="sm" size="sm" style={{ textTransform: "none" }}>
              Required
            </Badge>
          )}
        </Group>
      }
      description={fix.why}
      actions={
        fix.required ? (
          <Tooltip label="Without it something breaks silently, so it stays on." withArrow>
            <span>{control}</span>
          </Tooltip>
        ) : (
          control
        )
      }
    >
      {confirming && (
        <SettingRow
          label="Turn this fix off?"
          description={`What it holds off comes back, as OpenWrt ships it, on the next apply.`}
        >
          <Group gap="xs" wrap="nowrap">
            <Button variant="subtle" color="gray" size="compact-sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              color="red"
              size="compact-sm"
              onClick={() => {
                turnOff(fix.id);
                setConfirming(false);
              }}
            >
              Turn off
            </Button>
          </Group>
        </SettingRow>
      )}
      <SettingRow label="What it does" description={<Stack gap={2} component="span">{fix.effects.map((e) => <span key={e}>{e}</span>)}</Stack>} />
      <SettingRow label="Devices" description={fix.where ? `Applies ${fix.where}.` : "Applies on every device."}>
        <Group gap={4} justify="flex-end">
          {fix.devices.map((d) => (
            <FixStateBadge key={d.device} device={d.device} state={d.state} why={d.why} />
          ))}
        </Group>
      </SettingRow>
      <SettingRow label="Sources" description={<References references={fix.references} />} />
      <SettingRow label="Checked" description={`${fix.verified} (added ${fix.added}).`} />
      <SettingRow label="Goes when" description={`${fix.dropWhen}.`} />
    </Section>
  );
};

export const FixesPage = () => {
  const fixes = useFixes();
  return (
    <SettingsPage
      title={placeName("fixes")}
      description="What this app layers over OpenWrt for known problems, with the reason and sources for each. Fixes never change your settings: one a fix overrides keeps your value, which applies again once the fix goes."
    >
      {fixes.map((fix) => (
        <Fix key={fix.id} fix={fix} />
      ))}
      {!fixes.length && <Text c="dimmed">No fixes.</Text>}
    </SettingsPage>
  );
};
