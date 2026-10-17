// The review before an apply: the change plan made on the server
// (src/applyPlan.ts), as one surface. Its verdict first; what must be
// acknowledged, only when something warrants it; then every change, the most
// noticed first, by change or by device. Nothing to change says so (the
// sheet's button then applies again anyway).
import { Alert, Badge, Checkbox, Group, Loader, SegmentedControl, Stack, Text, UnstyledButton } from "@mantine/core";
import type { UseQueryResult } from "@tanstack/react-query";
import { useState } from "react";
import { ApplyPlan, needWords, PlanNeed } from "../../../src/applyPlan";
import { durationWords } from "../../../src/applyImpact";
import { canonical } from "../../../src/json";
import type { Change } from "../../../src/intent/diff";
import { ago } from "../facts";
import { Hint } from "../kit/Hint";
import { Section, SettingRow } from "../kit/layout";
import { ChangeRow, ChangeRows } from "./ChangeRows";

/** An acknowledgement's key: the whole consequence, so a tick never carries over to another. */
export const needKey = (need: PlanNeed) => canonical(need);

/** Whether every acknowledgement the plan needs is ticked, and nothing refuses it. */
export const readyToApply = (plan: ApplyPlan | undefined, acked: ReadonlySet<string>) =>
  !!plan && !plan.summary.blocked && plan.needs.every((need) => acked.has(needKey(need)));

const chip = { variant: "light", radius: "sm", style: { textTransform: "none" } } as const;

/** What applying is, in a glance: where, how long, that it rolls back, and how old the read is. */
const Chips = ({ plan, query }: { plan: ApplyPlan; query: UseQueryResult<ApplyPlan> }) => (
  <Group gap={6}>
    {plan.summary.devices > 0 && (
      <Hint label={plan.devices.map((d) => d.device).join(", ")}>
        <Badge {...chip} tabIndex={0} color="gray">
          {plan.summary.devices} device{plan.summary.devices === 1 ? "" : "s"}
        </Badge>
      </Hint>
    )}
    {plan.summary.devices > 0 && (
      <Hint label={`Applying takes ${durationWords(plan.devices.map((d) => d.seconds))}, from what changes on each device.`}>
        <Badge {...chip} tabIndex={0} color="gray">
          ~{plan.summary.minutes} min
        </Badge>
      </Hint>
    )}
    <Hint label="If any device cannot be reached afterwards, every device puts its previous settings back on its own.">
      <Badge {...chip} tabIndex={0} color="green">
        Rolls back on its own if unreachable
      </Badge>
    </Hint>
    {/* Flex like Hint's wrapper, so this badge lines up with the others (a button's line-height would push it down). */}
    <UnstyledButton
      onClick={() => void query.refetch()}
      disabled={query.isFetching}
      aria-label="Read the devices again"
      style={{ display: "inline-flex" }}
    >
      <Badge {...chip} color="gray" leftSection={query.isFetching ? <Loader size={10} /> : undefined}>
        {query.isFetching ? "Reading the devices…" : `Read ${ago(plan.readAt)} · read again`}
      </Badge>
    </UnstyledButton>
  </Group>
);

const Needs = ({ needs, acked, onAck }: { needs: PlanNeed[]; acked: ReadonlySet<string>; onAck: (key: string, on: boolean) => void }) => (
  <Section title="Before applying" description="Tick each to apply.">
    {needs.map((need) => (
      <SettingRow key={needKey(need)} label={needWords(need)}>
        <Checkbox
          aria-label={needWords(need)}
          checked={acked.has(needKey(need))}
          onChange={(e) => onAck(needKey(need), e.currentTarget.checked)}
        />
      </SettingRow>
    ))}
  </Section>
);

/** Each change, tagged with where it comes from, opening onto its lines. */
const ByChange = ({ plan }: { plan: ApplyPlan }) => (
  <Section title="What changes" description="The most noticed first. Passwords and keys are hidden.">
    {plan.items.map((item) => (
      <ChangeRow key={item.id} item={item} tagged />
    ))}
  </Section>
);

/** Each device, what it notices, and its changes with only its own lines. */
const ByDevice = ({ plan }: { plan: ApplyPlan }) => (
  <Stack gap="lg">
    {plan.devices.map(({ device, effects }) => (
      <Section key={device} title={device} description={effects.length ? effects.map((e) => e.text).join(" ") : "Nothing there is interrupted."}>
        {plan.items
          .filter((item) => item.devices.includes(device))
          .map((item) => (
            <ChangeRow
              key={item.id}
              item={{ ...item, devices: [], effect: { ...item.effect, notices: [] }, lines: item.lines.filter((l) => l.device === device) }}
              tagged
            />
          ))}
      </Section>
    ))}
  </Stack>
);

export const Review = ({
  query,
  draft,
  acked,
  onAck,
  stale,
}: {
  query: UseQueryResult<ApplyPlan>;
  /** Edits not saved yet: not in the plan, read from the saved settings, until saved and read again. */
  draft: Change[];
  acked: ReadonlySet<string>;
  onAck: (key: string, on: boolean) => void;
  /** The last start was refused: a device changed since this was reviewed. */
  stale: boolean;
}) => {
  const [view, setView] = useState<"change" | "device">("change");
  const plan = query.data;
  if (!plan) {
    return query.isError ? (
      <Alert color="red" title="Could not read the devices">
        {(query.error as Error).message}
      </Alert>
    ) : (
      <Group gap="sm">
        <Loader size="sm" />
        <Text size="sm" c="dimmed">
          Reading the devices…
        </Text>
      </Group>
    );
  }
  return (
    <Stack gap="lg">
      {stale && (
        <Alert color="orange" title="A device changed since you reviewed">
          Nothing was applied. Review the changes again, as they are now.
        </Alert>
      )}
      <Stack gap="xs">
        <Text fw={500}>{plan.summary.verdict}</Text>
        <Chips plan={plan} query={query} />
        {query.isError && (
          <Text size="xs" c="red">
            Could not read the devices again: {(query.error as Error).message}
          </Text>
        )}
      </Stack>
      {plan.summary.blocked && (
        <Alert color="red" title="This cannot be applied">
          {plan.summary.blocked}
        </Alert>
      )}
      {plan.needs.length > 0 && <Needs needs={plan.needs} acked={acked} onAck={onAck} />}
      {draft.length > 0 && (
        <Section title="Not saved yet" description="Save them to see what they change on the devices, then apply.">
          <ChangeRows changes={draft} />
        </Section>
      )}
      {plan.items.length > 0 && (
        <Stack gap="xs">
          <SegmentedControl
            size="xs"
            w="fit-content"
            value={view}
            onChange={(v) => setView(v as "change" | "device")}
            data={[
              { value: "change", label: "By change" },
              { value: "device", label: "By device" },
            ]}
          />
          {view === "change" ? <ByChange plan={plan} /> : <ByDevice plan={plan} />}
        </Stack>
      )}
      {plan.unread.length > 0 && (
        <Section title="Not read">
          {plan.unread.map((u) => (
            <SettingRow key={u.device} label={u.device} description={`${u.error}. What applying changes there is not known.`} />
          ))}
        </Section>
      )}
    </Stack>
  );
};
