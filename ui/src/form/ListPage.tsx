// A list in the intent (Wi-Fi networks, devices), declared once as a
// ListSpec and shown as two pages: the table at /<page>, and one item's
// detail page at /<page>/<index>. The detail page's fields edit the draft
// directly, so Save and Revert in the header cover them like any other.
import { Anchor, Button, Group, ThemeIcon } from "@mantine/core";
import { IconAlertCircle, IconChevronLeft, IconPlus } from "@tabler/icons-react";
import { ReactNode } from "react";
import {
  FieldArrayPath,
  UseFieldArrayReturn,
  useFieldArray,
  useFormState,
  useWatch,
} from "react-hook-form";
import { useLocation, useNavigate, useParams } from "react-router";
import { Intent } from "../../../src/intent/schema";
import { Column, DataTable } from "../kit/DataTable";
import { Section, SettingsPage } from "../kit/layout";
import { useIntentForm } from "./IntentForm";

type ListName = FieldArrayPath<Intent>;
type Item<N extends ListName> = Intent[N] extends (infer I)[] ? I : never;

export type ListSpec<N extends ListName> = {
  /** Which list in the intent. */
  name: N;
  title: string;
  description?: ReactNode;
  addLabel: string;
  /** What Add creates, given the items already there and the whole draft. */
  newItem: (items: Item<N>[], intent: Intent) => Item<N>;
  /** Whether an item may be removed (the main network may not). */
  canRemove?: (item: Item<N>) => boolean;
  /** Item `index`'s name, for its page title and breadcrumb. */
  itemTitle: (index: number) => ReactNode;
  columns: Column[];
  /** The fields of item `index`, named `${name}.${index}.<field>`. */
  editor: (index: number) => ReactNode;
  empty: ReactNode;
};

/** Declares a list: only for type inference, it returns its argument. */
export const defineList = <N extends ListName>(spec: ListSpec<N>) => spec;

type Fields<N extends ListName> = UseFieldArrayReturn<Intent, N>;

const ListTable = <N extends ListName>({
  list,
  fields,
}: {
  list: ListSpec<N>;
  fields: Fields<N>;
}) => {
  const navigate = useNavigate();
  const { getValues } = useIntentForm();
  const { errors } = useFormState<Intent>({ name: list.name });
  const hasErrors = (index: number) =>
    !!(errors as Record<string, unknown[] | undefined>)[list.name]?.[index];
  return (
    <SettingsPage title={list.title} description={list.description} wide>
      <DataTable
        actions={
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            onClick={() => {
              fields.append(
                list.newItem(getValues(list.name) as Item<N>[], getValues()) as never
              );
              // Its own page, marked new: Cancel there discards it.
              navigate(String(fields.fields.length), { state: { created: true } });
            }}
          >
            {list.addLabel}
          </Button>
        }
        columns={list.columns}
        rowCount={fields.fields.length}
        rowKey={(index) => fields.fields[index].id}
        onRowClick={(index) => navigate(String(index))}
        rowMarker={(index) =>
          hasErrors(index) && (
            <ThemeIcon size={18} radius="xl" color="red" variant="light">
              <IconAlertCircle size={14} />
            </ThemeIcon>
          )
        }
        empty={list.empty}
      />
    </SettingsPage>
  );
};

const ListItemPage = <N extends ListName>({
  list,
  fields,
  index,
}: {
  list: ListSpec<N>;
  fields: Fields<N>;
  index: number;
}) => {
  const navigate = useNavigate();
  const created = !!(useLocation().state as { created?: boolean } | null)?.created;
  const { trigger } = useIntentForm();
  const item = useWatch({ name: `${list.name}.${index}` as never }) as Item<N>;
  const removable = !list.canRemove || list.canRemove(item);
  const back = () => navigate("..", { relative: "path" });
  const discard = () => {
    fields.remove(index);
    back();
  };
  return (
    <SettingsPage
      title={list.itemTitle(index)}
      breadcrumbs={
        <Anchor size="sm" onClick={back}>
          <Group gap={2}>
            <IconChevronLeft size={16} />
            {list.title}
          </Group>
        </Anchor>
      }
    >
      <Section>{list.editor(index)}</Section>
      {created ? (
        <Group justify="flex-end">
          <Button variant="default" onClick={discard}>
            Cancel
          </Button>
          <Button
            onClick={async () => {
              // Only a complete item is added; otherwise its errors show here.
              if (await trigger(`${list.name}.${index}` as never)) back();
            }}
          >
            {list.addLabel}
          </Button>
        </Group>
      ) : (
        <Group justify={removable ? "space-between" : "flex-end"}>
          {removable && (
            <Button variant="subtle" color="red" onClick={discard}>
              Remove
            </Button>
          )}
          <Button variant="default" onClick={back}>
            Back to {list.title}
          </Button>
        </Group>
      )}
    </SettingsPage>
  );
};

/** The list's table, or one item's page when the URL names an index. */
export const ListPage = <N extends ListName>({ list }: { list: ListSpec<N> }) => {
  // One field array for both views, so they never disagree.
  const fields = useFieldArray<Intent, N>({ name: list.name });
  const sub = useParams()["*"];
  const index = sub && /^\d+$/.test(sub) ? Number(sub) : undefined;
  return index !== undefined && index < fields.fields.length ? (
    <ListItemPage list={list} fields={fields} index={index} />
  ) : (
    <ListTable list={list} fields={fields} />
  );
};
