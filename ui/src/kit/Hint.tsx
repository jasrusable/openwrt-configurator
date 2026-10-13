// The app's one floating help card: the ⓘ explainers, chips' details, why a
// choice is greyed out. A card (not Mantine's dark Tooltip) that opens on
// hover, on keyboard focus and on a tap, and stays open while the pointer is
// on it, so a link in it can be followed.
import { Popover, Text } from "@mantine/core";
import { ReactElement, ReactNode, useEffect, useRef, useState } from "react";

const openDelay = 150;
const closeDelay = 200;

export const Hint = ({
  label,
  children,
  width = 320,
}: {
  label: ReactNode;
  /** The target: one element that can hold a ref and take focus (give a plain element tabIndex). */
  children: ReactElement;
  /** The card's widest; short labels stay narrower. */
  width?: number;
}) => {
  const [opened, setOpened] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const later = (open: boolean, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpened(open), ms);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const hover = {
    onMouseEnter: () => later(true, openDelay),
    onMouseLeave: () => later(false, closeDelay),
  };
  return (
    <Popover opened={opened} onChange={setOpened} withArrow shadow="md" position="top" withinPortal>
      <Popover.Target>
        <span
          style={{ display: "inline-flex" }}
          {...hover}
          onFocus={() => later(true, 0)}
          onBlur={() => later(false, 0)}
          // A tap on a phone, where there is no hover.
          onTouchStart={() => setOpened((o) => !o)}
        >
          {children}
        </span>
      </Popover.Target>
      <Popover.Dropdown maw={width} p="xs" {...hover}>
        {typeof label === "string" ? <Text size="xs">{label}</Text> : label}
      </Popover.Dropdown>
    </Popover>
  );
};
