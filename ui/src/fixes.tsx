// The fixes this app layers over OpenWrt (src/intent/patches), as the pages
// show them: worked out from the draft and the devices' facts, so turning
// one off shows at once. What each state is called, and its colour.
import { Anchor, Badge, Group } from "@mantine/core";
import { IconBook, IconBug, IconClipboardCheck, IconGitCommit, IconGitPullRequest, IconMessages } from "@tabler/icons-react";
import { useMemo } from "react";
import type { Reference } from "../../src/intent/patches/patch";
import { FixState, patchStatus } from "../../src/intent/patches/status";
import { useDevices } from "./data/devices";
import { useDraft, useDraftValue } from "./form/draft";

/** The devices' facts, as last read (empty until then: fixes then say "not read yet"). */
export const useFacts = () => useDevices().data?.facts ?? {};

/** Every fix, with its state on each device, for the draft as it is. */
export const useFixes = () => {
  const intent = useDraftValue();
  const facts = useFacts();
  return useMemo(() => patchStatus(intent, facts), [intent, facts]);
};

/** Turn a fix off, or back on: a decision in the intent (system.patches.off), saved like any other. */
export const useFixSwitch = () => {
  const draft = useDraft();
  const off = useDraftValue("system.patches.off") ?? [];
  return {
    isOff: (id: string) => off.includes(id),
    turnOff: (id: string) => draft.set("system.patches.off", [...off.filter((x) => x !== id), id]),
    turnOn: (id: string) => draft.set("system.patches.off", off.filter((x) => x !== id)),
  };
};

export const fixStates: Record<FixState, { label: string; color: string }> = {
  active: { label: "On", color: "green" },
  off: { label: "Turned off", color: "gray" },
  unused: { label: "Not needed", color: "gray" },
  elsewhere: { label: "Not for it", color: "gray" },
  fixed: { label: "Fixed upstream", color: "blue" },
  unknown: { label: "Not read yet", color: "yellow" },
};

/** A device's state for a fix: its name and the state, why in its title. */
export const FixStateBadge = ({ device, state, why }: { device?: string; state: FixState; why?: string }) => (
  <Badge variant="light" color={fixStates[state].color} radius="sm" style={{ textTransform: "none" }} title={why}>
    {device ? `${device}: ` : ""}
    {fixStates[state].label}
  </Badge>
);

const referenceIcons: Record<Reference["kind"], typeof IconBug> = {
  issue: IconBug,
  pr: IconGitPullRequest,
  commit: IconGitCommit,
  forum: IconMessages,
  docs: IconBook,
  report: IconClipboardCheck,
};

/** A fix's sources: each a link with what it is, and what it shows. */
export const References = ({ references }: { references: Reference[] }) => (
  <Group gap={4} component="span" style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start" }}>
    {references.map((r) => {
      const Icon = referenceIcons[r.kind];
      return (
        <Anchor key={`${r.kind}${r.url}${r.note}`} href={r.url} target="_blank" rel="noreferrer" size="xs">
          <Group gap={4} wrap="nowrap" component="span" style={{ display: "inline-flex" }}>
            <Icon size={13} stroke={1.6} aria-label={r.kind} />
            {r.note ?? r.url}
          </Group>
        </Anchor>
      );
    })}
  </Group>
);
