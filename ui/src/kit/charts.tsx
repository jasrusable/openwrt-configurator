// Small, quiet visuals for the Status pages, in plain SVG: signal bars and a
// port faceplate (charts over time are TimeChart's). Colours come from
// Mantine's palette variables, so dark mode holds, and say state only.
import { Box, Group, Stack, Text } from "@mantine/core";
import { tone } from "../../../src/status/health";
import { Hint } from "./Hint";
import { linkWords } from "./format";
import { toneColor } from "./status";

/** Four bars for a Wi-Fi signal, filled by strength, with the dBm on hover. */
export const SignalBars = ({ dbm }: { dbm?: number }) => {
  if (dbm === undefined) return null;
  const level = dbm >= -55 ? 4 : dbm >= -67 ? 3 : dbm >= -75 ? 2 : 1;
  const color = toneColor[tone.signal(dbm)];
  return (
    <Hint label={`${dbm} dBm`}>
      <svg width={18} height={14} viewBox="0 0 18 14" aria-label={`signal ${dbm} dBm`}>
        {[0, 1, 2, 3].map((i) => (
          <rect
            key={i}
            x={i * 4.5}
            y={10 - i * 3}
            width={3}
            height={4 + i * 3}
            rx={0.8}
            fill={i < level ? `var(--mantine-color-${color}-6)` : "var(--onc-separator)"}
          />
        ))}
      </svg>
    </Hint>
  );
};

/** A device's ports as a faceplate: lit when connected, with the speed under each; each opens nothing, it only says. */
export const PortFace = ({ ports }: { ports: { name: string; up: boolean; speed?: number }[] }) => (
  <Group gap={8}>
    {ports.map((p) => (
      <Stack key={p.name} gap={3} align="center">
        <Hint label={p.up ? `${p.name}: connected${p.speed ? ` at ${linkWords(p.speed)}` : ""}` : `${p.name}: nothing connected`}>
          <Box
            w={34}
            h={26}
            style={{
              borderRadius: 5,
              border: "1.5px solid var(--onc-separator)",
              // Lit when connected; its speed is written under it, as colour here says how it is, not how fast.
              background: p.up ? "var(--mantine-color-green-6)" : "var(--onc-page)",
              boxShadow: "inset 0 -5px 0 var(--onc-separator)",
            }}
          />
        </Hint>
        <Text size="10px" c="dimmed">
          {p.name}
        </Text>
        <Text size="10px" c={p.up ? undefined : "dimmed"} fw={500}>
          {p.up ? (p.speed ? linkWords(p.speed) : "up") : "—"}
        </Text>
      </Stack>
    ))}
  </Group>
);

