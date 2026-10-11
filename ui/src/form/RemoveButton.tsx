// Remove, saying first what else goes with the item, and what it leaves
// needing a fix: worked out from the draft before and after the removal,
// not written per list.
import { Button, List, Modal, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { describePath } from "../../../src/intent/diff";
import { Intent } from "../../../src/intent/schema";
import { settingPages } from "../settingPages";
import { getIn, issuesOf, useDraft } from "./draft";

const json = (value: unknown) => JSON.stringify(value);

/** What an item is, as opposed to what it holds: an edited item is the same item. */
const identity = (item: any) => String(item?.id ?? item?.ssid ?? item?.name ?? json(item));

/** Items of every list that `after` no longer has, other than `itself`. */
const removedWith = (before: Intent, after: Intent, itself: string) =>
  settingPages
    .filter((s) => s.item && Array.isArray(getIn(before, s.path)))
    .flatMap(({ path }) => {
      // Counted, so one of two same-named rules going is still seen.
      const left = new Map<string, number>();
      ((getIn(after, path) ?? []) as unknown[]).forEach((item) =>
        left.set(identity(item), (left.get(identity(item)) ?? 0) + 1)
      );
      return ((getIn(before, path) ?? []) as unknown[]).flatMap((item, i) => {
        const key = identity(item);
        const count = left.get(key) ?? 0;
        if (count > 0) {
          left.set(key, count - 1);
          return [];
        }
        const at = `${path}.${i}`;
        return at === itself ? [] : [describePath(at.split("."), before).join(" › ")];
      });
    });

/** Problems `after` has that `before` did not. */
const brokenBy = (before: Intent, after: Intent) => {
  const was = new Set(issuesOf(before).map((i) => i.message + describePath(i.path.split("."), before).join()));
  return issuesOf(after)
    .filter((i) => !was.has(i.message + describePath(i.path.split("."), after).join()))
    .map((i) => `${describePath(i.path.split("."), after).join(" › ")}: ${i.message}`);
};

export const RemoveButton = ({
  path,
  remove,
  onRemoved,
}: {
  /** The item's path, like "networks.1". */
  path: string;
  /** The whole intent without it. */
  remove: (intent: Intent) => Intent;
  onRemoved: () => void;
}) => {
  const draft = useDraft();
  const [pending, setPending] = useState<{ after: Intent; also: string[]; broken: string[] }>();
  const apply = (after: Intent) => {
    draft.replace(after);
    setPending(undefined);
    onRemoved();
  };
  return (
    <>
      <Button
        variant="light"
        color="red"
        onClick={() => {
          const after = remove(draft.value);
          const also = removedWith(draft.value, after, path);
          const broken = brokenBy(draft.value, after);
          if (also.length || broken.length) setPending({ after, also, broken });
          else apply(after);
        }}
      >
        Remove
      </Button>
      <Modal opened={!!pending} onClose={() => setPending(undefined)} title="Remove" centered>
        {pending && (
          <Stack gap="md">
            {pending.also.length > 0 && (
              <div>
                <Text size="sm" fw={500}>
                  Also removed:
                </Text>
                <List size="sm">
                  {pending.also.map((label) => (
                    <List.Item key={label}>{label}</List.Item>
                  ))}
                </List>
              </div>
            )}
            {pending.broken.length > 0 && (
              <div>
                <Text size="sm" fw={500}>
                  Will need fixing:
                </Text>
                <List size="sm">
                  {pending.broken.map((label) => (
                    <List.Item key={label}>{label}</List.Item>
                  ))}
                </List>
              </div>
            )}
            <Text size="xs" c="dimmed">
              Nothing changes on your devices until you save and provision.
            </Text>
            <Stack gap={6} align="flex-end">
              <Button.Group>
                <Button variant="default" onClick={() => setPending(undefined)}>
                  Cancel
                </Button>
                <Button color="red" onClick={() => apply(pending.after)}>
                  Remove
                </Button>
              </Button.Group>
            </Stack>
          </Stack>
        )}
      </Modal>
    </>
  );
};
