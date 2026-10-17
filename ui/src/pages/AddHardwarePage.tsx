// Hardware › Add: guided. What is on the network and not in Hardware yet
// (seen before first), or an address typed in; the device picked is read
// (read-only: this app's key, else OpenWrt's default, never the admin
// password), and the name and role it suits are suggested. Add puts it in
// the draft like any edit and keeps its facts, so it is found by identity.
import { Alert, Badge, Button, Group, Loader, SegmentedControl, Text, TextInput } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { ReactNode, useState } from "react";
import { useNavigate } from "react-router";
import { availability } from "../../../src/intent/choices";
import { where } from "../../../src/intent/places";
import { Intent } from "../../../src/intent/schema";
import { namePattern } from "../../../src/intent/validators";
import type { Candidate, Inspected } from "../../../src/discover";
import { useAdopt, useCandidates, useInspect } from "../data/discover";
import { ago, bandsOf, modelOf, portsOf } from "../facts";
import { useDraft, useDraftValue } from "../form/draft";
import { EmptyState, Section, SettingRow, SettingsPage } from "../kit/layout";

const roles = [
  { value: "access-point", label: "Access point" },
  { value: "router", label: "Router" },
];

/** Something under way, said quietly. */
const Busy = ({ children }: { children: ReactNode }) => (
  <Group justify="center" gap={8} py="xl">
    <Loader size="xs" />
    <Text size="sm" c="dimmed">
      {children}
    </Text>
  </Group>
);

/** A device on the network: what it called itself, where it is, what is known of it. */
const CandidateRow = ({ candidate, onPick }: { candidate: Candidate; onPick: () => void }) => (
  <SettingRow
    label={candidate.seen?.hostname ?? candidate.name ?? candidate.address}
    description={[
      candidate.address,
      candidate.seen ? `${candidate.seen.model}, seen ${ago(candidate.seen.readAt)}` : undefined,
      candidate.mac,
    ]
      .filter(Boolean)
      .join(" · ")}
  >
    <Group gap={8} wrap="nowrap">
      {candidate.likelyOpenWrt && (
        <Badge variant="light" color="blue">
          {candidate.seen ? "Seen before" : "OpenWrt"}
        </Badge>
      )}
      <Button variant="subtle" color="gray" size="compact-sm" rightSection={<IconChevronRight size={14} />} onClick={onPick}>
        Read
      </Button>
    </Group>
  </SettingRow>
);

type Choice = { name: string; role: "router" | "access-point"; location: string };

/** The name dropbear's host key file has for a key type (ssh-ed25519: ed25519). */
const dropbearKeyName = (type: string) => (type.startsWith("ecdsa") ? "ecdsa" : type.replace(/^ssh-/, ""));

/**
 * Why a name will not do: checked against the draft, not only the saved
 * file, as its facts (its pinned key) are kept under it when added.
 */
const nameProblem = (intent: Intent, name: string) =>
  !name
    ? "Required."
    : !namePattern.test(name)
      ? "Lowercase letters, digits and -, like a hostname."
      : intent.hardware.some((d) => d.name === name)
        ? "Another device has this name."
        : undefined;

/** What the picked device is, and how it will be added (the page's Add takes it). */
const Found = ({
  device,
  choice,
  onChange,
}: {
  device: Inspected;
  choice: Choice;
  onChange: (choice: Choice) => void;
}) => {
  const intent: Intent = useDraftValue();
  const ports = portsOf(device.schema);
  const bands = bandsOf(device.schema);
  const router = intent.hardware.find((d) => d.role === "router");
  return (
    <>
      <Section title="Found" description={`Read from ${device.address}; nothing on it has changed.`}>
        <SettingRow label="Model">
          <Text size="sm" c="dimmed">{modelOf(device.schema)}</Text>
        </SettingRow>
        <SettingRow label="OpenWrt">
          <Text size="sm" c="dimmed">{device.schema.version}</Text>
        </SettingRow>
        <SettingRow label="Ports">
          <Text size="sm" c="dimmed" ff="monospace">
            {[...ports.wan.map((p) => `${p} (internet)`), ...ports.lan].join(", ") || "—"}
          </Text>
        </SettingRow>
        <SettingRow label="Wi-Fi">
          <Text size="sm" c="dimmed">{bands.length ? bands.join(", ") : "None"}</Text>
        </SettingRow>
        <SettingRow label="MAC" description="What the router knows it by.">
          <Text size="sm" c="dimmed" ff="monospace">
            {device.macs.join(", ") || "—"}
          </Text>
        </SettingRow>
        <SettingRow
          label="Host key"
          description={
            device.hostKey
              ? `Adding trusts this key from now on. To be sure it is your device, compare it with what its console prints for: dropbearkey -y -f /etc/dropbear/dropbear_${dropbearKeyName(device.hostKey.type)}_host_key`
              : "Its key was not recorded."
          }
        >
          <Text size="sm" c="dimmed" ff="monospace" style={{ wordBreak: "break-all" }}>
            {device.fingerprint ?? "—"}
          </Text>
        </SettingRow>
      </Section>
      {device.openLogin && (
        <Alert color="orange" title="Open to anyone on your network">
          It lets root in with any password, as OpenWrt does fresh. Applying closes it once password login is
          off ({where("system", "Authorized keys")}).
        </Alert>
      )}
      <Section title="Add it as">
        <SettingRow
          label="Name"
          description="Also its hostname, once applied."
          error={choice.name ? nameProblem(intent, choice.name) : undefined}
        >
          <TextInput
            value={choice.name}
            onChange={(e) => onChange({ ...choice, name: e.currentTarget.value.toLowerCase() })}
            w={260}
          />
        </SettingRow>
        <SettingRow
          label="Role"
          description={
            choice.role === "router" && router
              ? `${router.name} becomes an access point.`
              : choice.role === "router"
              ? "It connects to the internet and runs the networks."
              : bands.length
              ? "It broadcasts your Wi-Fi."
              : "It has no Wi-Fi: as an access point it only carries the networks over its ports."
          }
        >
          <SegmentedControl
            value={choice.role}
            onChange={(v) => onChange({ ...choice, role: v as Choice["role"] })}
            data={roles}
          />
        </SettingRow>
        <SettingRow label="Location" description="Where it is, for you.">
          <TextInput
            value={choice.location}
            onChange={(e) => onChange({ ...choice, location: e.currentTarget.value })}
            placeholder="Living room"
            w={260}
          />
        </SettingRow>
      </Section>
    </>
  );
};

/**
 * The likely ones (seen before, or looking like OpenWrt); everything else on
 * the network (phones, laptops) only on request, for a device that does not
 * look like OpenWrt yet.
 */
const CandidateList = ({ candidates, pick }: { candidates: Candidate[]; pick: (address: string) => void }) => {
  const [showAll, setShowAll] = useState(false);
  const likely = candidates.filter((c) => c.likelyOpenWrt);
  const others = candidates.filter((c) => !c.likelyOpenWrt);
  const shown = showAll ? candidates : likely;
  return (
    <>
      {shown.length ? (
        shown.map((c) => <CandidateRow key={c.address} candidate={c} onPick={() => pick(c.address)} />)
      ) : (
        <EmptyState>No OpenWrt device found that is not added yet. Enter its address below.</EmptyState>
      )}
      {others.length > 0 && (
        <Group justify="center" py={6}>
          <Button variant="subtle" color="gray" size="compact-sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "Only likely OpenWrt devices" : `Show ${others.length} other device${others.length === 1 ? "" : "s"}`}
          </Button>
        </Group>
      )}
    </>
  );
};

export const AddHardwarePage = () => {
  const navigate = useNavigate();
  const draft = useDraft();
  const intent: Intent = useDraftValue();
  const candidates = useCandidates();
  const read = useInspect();
  const adopt = useAdopt();
  const [typed, setTyped] = useState("");
  const [choice, setChoice] = useState<Choice>({ name: "", role: "access-point", location: "" });
  const pick = (address: string) =>
    read.mutate(address, {
      onSuccess: (device) => setChoice({ ...device.suggested, location: "" }),
    });
  const device = read.data;
  // Its facts are kept, then it joins the draft like any edit; as a router,
  // the role is handed over, as on any device's page.
  const add = () =>
    device &&
    adopt.mutate(
      { address: device.address, name: choice.name },
      {
        onSuccess: () => {
          const index = intent.hardware.length;
          const added: Intent = {
            ...intent,
            hardware: [
              ...intent.hardware,
              // Read just now, directly: cabled, as a first setup must be.
              {
                name: choice.name,
                role: "access-point",
                uplink: "cable",
                ...(choice.location ? { location: choice.location } : {}),
              },
            ],
          };
          const swap =
            choice.role === "router" ? availability(added, `hardware.${index}.role`).option("router").swap : undefined;
          draft.replace(swap ? swap.apply(added) : added);
          navigate(`/settings/hardware/${index}`);
        },
      }
    );
  return (
    <SettingsPage
      title={[{ label: "Hardware", onClick: () => navigate("/settings/hardware") }, { label: "Add" }]}
      description="A router or access point on your network. Pick it, and it is read to see what it is; nothing on it changes until you apply."
      actions={
        device ? (
          <Button onClick={add} loading={adopt.isPending} disabled={!!nameProblem(intent, choice.name)}>
            Add
          </Button>
        ) : (
          // The router's lists again (a device just plugged in): still no scan.
          !read.isPending && (
            <Button variant="default" onClick={() => candidates.refetch()} loading={candidates.isFetching}>
              Look again
            </Button>
          )
        )
      }
    >
      {/* What went wrong, here rather than as a toast. */}
      {(read.error || adopt.error) && (
        <Alert color="red" mb="md">
          {((adopt.error ?? read.error) as Error).message}
        </Alert>
      )}
      {device ? (
        <Found device={device} choice={choice} onChange={setChoice} />
      ) : read.isPending ? (
        <Section>
          <Busy>Reading {read.variables}…</Busy>
        </Section>
      ) : (
        <>
          <Section title="On your network" description="From the router's list of connected devices; nothing is scanned.">
            {candidates.isPending ? (
              <Busy>Looking…</Busy>
            ) : candidates.isError ? (
              <SettingRow label="Could not look" description={(candidates.error as Error).message} />
            ) : (
              <CandidateList candidates={candidates.data?.candidates ?? []} pick={pick} />
            )}
          </Section>
          <Section title="Or its address">
            <SettingRow label="Address" description="If it is not listed: its IP address (a name can be claimed by any device).">
              <Group gap={6} wrap="nowrap">
                <TextInput value={typed} onChange={(e) => setTyped(e.currentTarget.value)} placeholder="10.0.0.143" w={180} />
                <Button variant="default" disabled={!typed.trim()} onClick={() => pick(typed.trim())}>
                  Read
                </Button>
              </Group>
            </SettingRow>
          </Section>
        </>
      )}
    </SettingsPage>
  );
};
