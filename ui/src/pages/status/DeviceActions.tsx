// What can be done to one device from Status › Devices: ping or trace the
// route from it, restart its Wi-Fi, reboot it. Each asks first and says what it will do; nothing
// here changes a setting.
import { ActionIcon, Button, Group, Menu, Modal, Stack, Table, Text, TextInput } from "@mantine/core";
import { IconDots } from "@tabler/icons-react";
import { useState } from "react";
import type { DeviceView } from "../../../../src/status/views";
import { usePing, useReboot, useRestartWifi, useTraceroute } from "../../data/status";

type Action = "ping" | "traceroute" | "wifi" | "reboot";

const failure = (error: unknown) => (error ? <Text size="sm" c="red">{(error as Error).message}</Text> : null);

const Confirm = ({
  device,
  action,
  onClose,
}: {
  device: DeviceView;
  action: "wifi" | "reboot";
  onClose: () => void;
}) => {
  const reboot = useReboot();
  const wifi = useRestartWifi();
  const mutation = action === "reboot" ? reboot : wifi;
  const words =
    action === "reboot"
      ? {
          title: `Reboot ${device.name}?`,
          body:
            device.role === "router"
              ? `${device.name} restarts, which takes a minute or so; meanwhile nothing on your network reaches the internet.`
              : `${device.name} restarts, which takes a minute or so; meanwhile its Wi-Fi and wired clients are off the network.`,
          button: "Reboot",
        }
      : {
          title: `Restart ${device.name}'s Wi-Fi?`,
          body: "Its Wi-Fi clients disconnect and join again within a minute; a mesh link through it drops for as long.",
          button: "Restart Wi-Fi",
        };
  return (
    <Modal opened onClose={onClose} title={words.title} centered>
      <Stack gap="md">
        <Text size="sm">{words.body}</Text>
        {failure(mutation.error)}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button color="red" loading={mutation.isPending} onClick={() => mutation.mutate(device.name, { onSuccess: onClose })}>
            {words.button}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};

const Ping = ({ device, onClose }: { device: DeviceView; onClose: () => void }) => {
  const [target, setTarget] = useState("1.1.1.1");
  const ping = usePing();
  const result = ping.data;
  return (
    <Modal opened onClose={onClose} title={`Ping from ${device.name}`} centered>
      <Stack gap="md">
        <TextInput
          label="Address or name"
          value={target}
          onChange={(e) => setTarget(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && ping.mutate({ device: device.name, target })}
        />
        {result && (
          <Text size="sm">
            {result.received} of {result.sent} answered
            {result.averageMs !== undefined ? ` · ${Math.round(result.averageMs * 10) / 10} ms on average` : ""}
          </Text>
        )}
        {failure(ping.error)}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Close
          </Button>
          <Button loading={ping.isPending} disabled={!target.trim()} onClick={() => ping.mutate({ device: device.name, target: target.trim() })}>
            Ping
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};

/** Each hop: who answered, the best of its times, and how many probes went unanswered. */
const Traceroute = ({ device, onClose }: { device: DeviceView; onClose: () => void }) => {
  const [target, setTarget] = useState("1.1.1.1");
  const trace = useTraceroute();
  const run = () => target.trim() && trace.mutate({ device: device.name, target: target.trim() });
  const hops = trace.data?.hops;
  return (
    <Modal opened onClose={onClose} title={`Route from ${device.name}`} centered size="lg">
      <Stack gap="md">
        <TextInput label="Address or name" value={target} onChange={(e) => setTarget(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && run()} />
        {trace.isPending && (
          <Text size="sm" c="dimmed">
            Tracing: up to half a minute where hops do not answer.
          </Text>
        )}
        {hops && (
          <Table fz="sm" verticalSpacing={4} style={{ fontVariantNumeric: "tabular-nums" }}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={48}>Hop</Table.Th>
                <Table.Th>Answered by</Table.Th>
                <Table.Th ta="right">Time</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {hops.map((h) => (
                <Table.Tr key={h.hop}>
                  <Table.Td c="dimmed">{h.hop}</Table.Td>
                  <Table.Td ff="monospace">{h.address ?? <Text span size="sm" c="dimmed">no answer</Text>}</Table.Td>
                  <Table.Td ta="right">
                    {h.ms.length ? `${Math.min(...h.ms) < 1 ? "<1" : Math.round(Math.min(...h.ms))} ms` : "—"}
                    {h.lost > 0 && h.ms.length > 0 && <Text span size="xs" c="dimmed">{` · ${h.lost} lost`}</Text>}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        {hops && (
          <Text size="xs" c="dimmed">
            A hop that does not answer is often a router that ignores these probes, not a problem: what matters is whether the hops after it answer.
          </Text>
        )}
        {failure(trace.error)}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Close
          </Button>
          <Button loading={trace.isPending} disabled={!target.trim()} onClick={run}>
            Trace
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};

/** The device's actions menu, and the confirmation of the one picked. */
export const DeviceActions = ({ device }: { device: DeviceView }) => {
  const [open, setOpen] = useState<Action | undefined>();
  const close = () => setOpen(undefined);
  return (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon variant="subtle" color="gray" aria-label={`Actions for ${device.name}`} disabled={!device.reachable}>
            <IconDots size={18} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={() => setOpen("ping")}>Ping from here…</Menu.Item>
          <Menu.Item onClick={() => setOpen("traceroute")}>Traceroute from here…</Menu.Item>
          <Menu.Item onClick={() => setOpen("wifi")}>Restart Wi-Fi…</Menu.Item>
          <Menu.Item color="red" onClick={() => setOpen("reboot")}>
            Reboot…
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      {open === "ping" && <Ping device={device} onClose={close} />}
      {open === "traceroute" && <Traceroute device={device} onClose={close} />}
      {(open === "wifi" || open === "reboot") && <Confirm device={device} action={open} onClose={close} />}
    </>
  );
};
