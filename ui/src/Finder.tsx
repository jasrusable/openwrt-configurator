// ⌘K (Ctrl+K), or the header's search button: find a setting, a page, a
// device or a client by name and go there; a setting opens its page at its
// row (form/landing.ts). Arrows move, Enter opens, Escape closes. What it
// searches is findable.ts.
import { ActionIcon, Box, Group, Kbd, Modal, ScrollArea, Text, TextInput, UnstyledButton } from "@mantine/core";
import { useDisclosure, useHotkeys, useOs } from "@mantine/hooks";
import { IconSearch } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { Intent } from "../../src/intent/schema";
import { useNetworkStatus } from "./data/status";
import { find, settingEntries, type Entry } from "./findable";
import { useDraftValue } from "./form/draft";
import { Hint } from "./kit/Hint";
import { settingsPages, statusPages } from "./pages";

const lower = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" ").toLowerCase();

/** The pages, shown before anything is typed, and found by name. */
const pageEntries: Entry[] = [
  ...statusPages.map((p) => ({ id: `status:${p.id}`, group: "Status" as const, title: p.label, url: `/${p.id}`, words: lower(p.label, "status") })),
  ...settingsPages.map((p) => ({ id: `settings:${p.id}`, group: "Settings" as const, title: p.label, url: `/settings/${p.id}`, words: lower(p.label, "settings") })),
];

const useEntries = (opened: boolean) => {
  const intent: Intent = useDraftValue();
  const clients = useNetworkStatus().data?.clientList;
  // Worked out as it opens, from the draft then: not on every keystroke elsewhere.
  return useMemo(() => {
    if (!opened) return [];
    const devices = intent.hardware.map((d) => ({
      id: `device:${d.name}`,
      group: "Device" as const,
      title: d.name,
      context: d.role === "router" ? "Router" : "Access point",
      url: `/devices/${encodeURIComponent(d.name)}`,
      words: lower(d.name, d.role, d.location, "device"),
    }));
    const known = (clients ?? []).map((c) => ({
      id: `client:${c.mac}`,
      group: "Client" as const,
      title: c.name ?? c.mac,
      context: [c.ipv4, c.state === "online" ? undefined : "away"].filter(Boolean).join(" · ") || undefined,
      url: `/clients/${encodeURIComponent(c.mac)}`,
      words: lower(c.name, c.mac, c.ipv4, c.model, "client"),
    }));
    return [...pageEntries, ...settingEntries(intent), ...devices, ...known];
  }, [opened, intent, clients]);
};

const Result = ({ entry, selected, onPick, onHover }: { entry: Entry; selected: boolean; onPick: () => void; onHover: () => void }) => (
  <UnstyledButton
    onClick={onPick}
    onMouseMove={onHover}
    className="onc-finder-row"
    data-selected={selected || undefined}
    id={`finder-${entry.id}`}
    role="option"
    aria-selected={selected}
  >
    <Group gap="sm" wrap="nowrap" justify="space-between">
      <Box style={{ minWidth: 0 }}>
        <Text size="sm" truncate>
          {entry.title}
          {entry.context && (
            <Text span size="xs" c="dimmed">
              {`  ${entry.context}`}
            </Text>
          )}
        </Text>
        {entry.detail && (
          <Text size="xs" c="dimmed" truncate>
            {entry.detail}
          </Text>
        )}
      </Box>
      <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
        {entry.group}
      </Text>
    </Group>
  </UnstyledButton>
);

export const Finder = () => {
  const [opened, { open, close, toggle }] = useDisclosure(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const navigate = useNavigate();
  const mac = useOs() === "macos";
  // In a field too: ⌘K is never typing.
  useHotkeys([["mod+K", toggle]], []);
  const entries = useEntries(opened);
  const shown = query.trim() ? find(entries, query) : pageEntries;
  const pick = (entry: Entry | undefined) => {
    if (!entry) return;
    close();
    setQuery("");
    navigate(entry.url);
  };
  const move = (by: number) => {
    const next = Math.max(0, Math.min(shown.length - 1, selected + by));
    setSelected(next);
    document.getElementById(`finder-${shown[next]?.id}`)?.scrollIntoView({ block: "nearest" });
  };
  return (
    <>
      <Hint label={`Find a setting, device or client (${mac ? "⌘" : "Ctrl+"}K)`} width={240}>
        <ActionIcon variant="subtle" color="gray" size="lg" onClick={open} aria-label="Find">
          <IconSearch size={18} />
        </ActionIcon>
      </Hint>
      <Modal opened={opened} onClose={close} withCloseButton={false} padding={0} size="lg" yOffset="12vh" radius="md">
        <TextInput
          data-autofocus
          placeholder="Find a setting, device or client"
          leftSection={<IconSearch size={16} />}
          rightSection={<Kbd size="xs">esc</Kbd>}
          rightSectionWidth={48}
          variant="unstyled"
          size="md"
          px="xs"
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            const by = { ArrowDown: 1, ArrowUp: -1 }[e.key];
            if (by) {
              e.preventDefault();
              move(by);
            } else if (e.key === "Enter") pick(shown[selected]);
          }}
          role="combobox"
          aria-expanded
          aria-controls="finder-results"
          aria-activedescendant={shown[selected] ? `finder-${shown[selected].id}` : undefined}
          style={{ borderBottom: "1px solid var(--onc-separator)" }}
        />
        <ScrollArea.Autosize mah="55vh" type="auto">
          <Box p={6} id="finder-results" role="listbox">
            {shown.length ? (
              shown.map((entry, i) => <Result key={entry.id} entry={entry} selected={i === selected} onPick={() => pick(entry)} onHover={() => setSelected(i)} />)
            ) : (
              <Text size="sm" c="dimmed" p="md">
                Nothing called that.
              </Text>
            )}
          </Box>
        </ScrollArea.Autosize>
      </Modal>
    </>
  );
};
