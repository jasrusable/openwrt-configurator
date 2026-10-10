// A list in the intent (Wi-Fi networks, devices), declared once as a
// ListSpec and shown as two pages: the table at /<page>, and one item's
// detail page at /<page>/<index>. The detail page's fields edit the draft
// directly, so Save and Revert in the header cover them like any other.
import { Button, Group, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconAlertCircle, IconPlus } from "@tabler/icons-react";
import { ReactNode } from "react";
import { useState } from "react";
import {
  FieldArray,
  FieldArrayPath,
  FormProvider,
  UseFieldArrayReturn,
  useFieldArray,
  useFormState,
  useWatch,
} from "react-hook-form";
import { useLocation, useNavigate, useParams } from "react-router";
import { Intent } from "../../../src/intent/schema";
import { Column, DataTable } from "../kit/DataTable";
import { SettingsPage } from "../kit/layout";
import { applyIntent, useIntentForm, useIntentFormState } from "./IntentForm";

/** A copy of `value` with the dotted `path` set. */
const setIn = <T,>(value: T, path: string, next: unknown): T => {
  const [head, ...rest] = path.split(".");
  const node = (value ?? {}) as Record<string, unknown>;
  return {
    ...node,
    [head]: rest.length ? setIn(node[head], rest.join("."), next) : next,
  } as T;
};

type ListName = FieldArrayPath<Intent>;
type Item<N extends ListName> = FieldArray<Intent, N>;

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
  /**
   * When adding item `index` changes other settings too (a network's zone):
   * the whole intent after the add. The item is already in the list.
   */
  onAdd?: (intent: Intent, index: number) => Intent;
  /** The whole intent with item `index` removed, if more than the item goes. */
  onRemove?: (intent: Intent, index: number) => Intent;
  /** Item `index`'s name, for its page title and breadcrumb. */
  itemTitle: (index: number) => ReactNode;
  columns: Column[];
  /**
   * Item `index`'s page: its fields (named `${name}.${index}.<field>`) in
   * titled Sections, grouped by what they are about.
   */
  editor: (index: number) => ReactNode;
  empty: ReactNode;
};

/** Declares a list: only for type inference, it returns its argument. */
export const defineList = <N extends ListName>(spec: ListSpec<N>) => spec;

type Fields<N extends ListName> = UseFieldArrayReturn<Intent, N>;

/** A page the table sits in, under other settings (LuCI's zones table). */
export type HostPage = {
  title: ReactNode;
  description?: ReactNode;
  before?: ReactNode;
};

const ListTable = <N extends ListName>({
  list,
  fields,
  base,
  page,
}: {
  list: ListSpec<N>;
  fields: Fields<N>;
  base: string;
  page?: HostPage;
}) => {
  const navigate = useNavigate();
  const { errors } = useFormState<Intent>({ name: list.name });
  const hasErrors = (index: number) =>
    !!(errors as Record<string, unknown[] | undefined>)[list.name]?.[index];
  const add = (
    <Button
      variant="light"
      leftSection={<IconPlus size={16} />}
      // Nothing is added yet: the new item's page adds it, on confirm.
      onClick={() => navigate(`${base}/new`)}
    >
      {list.addLabel}
    </Button>
  );
  const table = (
    <DataTable
      columns={list.columns}
      rowCount={fields.fields.length}
      rowKey={(index) => fields.fields[index].id}
      onRowClick={(index) => navigate(`${base}/${index}`)}
      rowMarker={(index) =>
        hasErrors(index) && (
          <ThemeIcon size={18} radius="xl" color="red" variant="light">
            <IconAlertCircle size={14} />
          </ThemeIcon>
        )
      }
      empty={list.empty}
    />
  );
  return page ? (
    <SettingsPage title={page.title} description={page.description}>
      {page.before}
      <Stack gap={6}>
        <Group justify="space-between" px={4}>
          <Text fw={600} size="sm">
            {list.title}
          </Text>
          {add}
        </Group>
        {table}
      </Stack>
    </SettingsPage>
  ) : (
    <SettingsPage
      title={list.title}
      description={list.description}
      actions={add}
    >
      {table}
    </SettingsPage>
  );
};

const ListItemPage = <N extends ListName>({
  list,
  fields,
  index,
  base,
}: {
  list: ListSpec<N>;
  fields: Fields<N>;
  index: number;
  base: string;
}) => {
  const navigate = useNavigate();
  const draft = useIntentForm();
  const item = useWatch({ name: `${list.name}.${index}` as never }) as Item<N>;
  const removable = !list.canRemove || list.canRemove(item);
  const back = () => navigate(base);
  // Same width and header position as the list: only the title grows a
  // step, "Networks / Home", whose first part leads back.
  return (
    <SettingsPage
      title={[
        { label: list.title, onClick: back },
        { label: list.itemTitle(index) },
      ]}
      actions={
        removable && (
          <Button
            variant="light"
            color="red"
            onClick={() => {
              if (list.onRemove) {
                applyIntent(draft, list.onRemove(draft.getValues(), index));
              } else {
                fields.remove(index);
              }
              back();
            }}
          >
            Remove
          </Button>
        )
      }
    >
      {list.editor(index)}
    </SettingsPage>
  );
};

/**
 * A new item's page. It edits a copy of the draft with the item appended,
 * through the same editor, so the item is checked against everything else
 * (a VLAN already taken, say); only Add puts it into the draft. Leaving, or
 * Cancel, adds nothing.
 */
const NewItemPage = <N extends ListName>({
  list,
  fields,
  base,
}: {
  list: ListSpec<N>;
  fields: Fields<N>;
  base: string;
}) => {
  const navigate = useNavigate();
  const draft = useIntentForm();
  const [{ copy, index }] = useState(() => {
    const intent = draft.getValues();
    const items = draft.getValues(list.name) as Item<N>[];
    return {
      copy: setIn(intent, list.name, [...items, list.newItem(items, intent)]),
      index: items.length,
    };
  });
  const form = useIntentFormState(copy);
  const back = () => navigate(base);
  const add = async () => {
    const path = `${list.name}.${index}` as never;
    // What adding implies (a network's zone) first, so the check sees it.
    if (list.onAdd) applyIntent(form, list.onAdd(form.getValues(), index));
    // Only a complete item is added; otherwise its errors show here.
    if (!(await form.trigger(path))) return;
    if (list.onAdd) {
      // Everything the new item's page changed, and what adding implied.
      applyIntent(draft, form.getValues());
    } else {
      fields.append(form.getValues(path) as never);
    }
    back();
  };
  return (
    <FormProvider {...form}>
      <SettingsPage
        title={[
          { label: list.title, onClick: back },
          { label: list.itemTitle(index) },
        ]}
        actions={
          <>
            <Button variant="default" onClick={back}>
              Cancel
            </Button>
            <Button onClick={add}>{list.addLabel}</Button>
          </>
        }
      >
        {list.editor(index)}
      </SettingsPage>
    </FormProvider>
  );
};

/**
 * The list's table, or one item's page when the URL names an index (or
 * "new"). `sub` is that last part of the URL, when the list is nested in a
 * section (/firewall/zones/1); otherwise it is the route's own splat.
 */
export const ListPage = <N extends ListName>({
  list,
  sub: given,
  page,
  base: givenBase,
}: {
  list: ListSpec<N>;
  sub?: string;
  /** The table sits in this page, under its other settings. */
  page?: HostPage;
  /** Where the items live, when not under the table's own URL. */
  base?: string;
}) => {
  // One field array for every view, so they never disagree.
  const fields = useFieldArray<Intent, N>({ name: list.name });
  const splat = useParams()["*"];
  const sub = given ?? splat ?? "";
  const { pathname } = useLocation();
  // The table's own URL: where its rows lead from, and items lead back to.
  const base =
    givenBase ??
    (sub ? pathname.slice(0, pathname.length - sub.length) : pathname).replace(
      /\/+$/,
      "",
    );
  const props = { list, fields, base };
  if (sub === "new") return <NewItemPage {...props} />;
  const index = /^\d+$/.test(sub) ? Number(sub) : undefined;
  return index !== undefined && index < fields.fields.length ? (
    <ListItemPage {...props} index={index} />
  ) : (
    <ListTable {...props} page={page} />
  );
};
