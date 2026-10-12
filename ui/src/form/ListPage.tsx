// A list in the intent (Wi-Fi networks, devices), declared once as a
// ListSpec and shown as two pages: the table at /<page>, and one item's
// detail page at /<page>/<index>. The detail page's fields edit the draft
// directly, so Save and Revert in the header cover them like any other.
import { Button, Group, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconAlertCircle, IconPlus } from "@tabler/icons-react";
import { ReactNode, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { Intent } from "../../../src/intent/schema";
import { Column, DataTable } from "../kit/DataTable";
import { SettingsPage } from "../kit/layout";
import { RemoveButton } from "./RemoveButton";
import {
  Draft,
  DraftProvider,
  getIn,
  issuesOf,
  ItemOf,
  ListPath,
  setIn,
  useDraft,
  useDraftValue,
  useIssues,
} from "./draft";

type ListName = ListPath;
type Item<N extends ListName> = ItemOf<N>;

export type ListSpec<N extends ListName> = {
  /** Which list in the intent. */
  name: N;
  title: string;
  description?: ReactNode;
  addLabel: string;
  /** More actions beside Add, e.g. Hardware's "Read from devices". */
  actions?: ReactNode;
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


/** A page the table sits in, under other settings (LuCI's zones table). */
export type HostPage = {
  title: ReactNode;
  description?: ReactNode;
  before?: ReactNode;
};

const ListTable = <N extends ListName>({
  list,
  base,
  page,
}: {
  list: ListSpec<N>;
  base: string;
  page?: HostPage;
}) => {
  const navigate = useNavigate();
  const items: unknown[] = useDraftValue(list.name) ?? [];
  const issues = useIssues();
  const hasErrors = (index: number) =>
    issues.some(
      (issue) =>
        issue.path === `${list.name}.${index}` || issue.path.startsWith(`${list.name}.${index}.`)
    );
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
      rowCount={items.length}
      rowKey={(index) => String(index)}
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
      actions={
        <>
          {list.actions}
          {add}
        </>
      }
    >
      {table}
    </SettingsPage>
  );
};

const ListItemPage = <N extends ListName>({
  list,
  index,
  base,
}: {
  list: ListSpec<N>;
  index: number;
  base: string;
}) => {
  const navigate = useNavigate();
  const item = useDraftValue(`${list.name}.${index}` as never) as Item<N>;
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
          <RemoveButton
            path={`${list.name}.${index}`}
            remove={(intent) => {
              const items: unknown[] = getIn(intent, list.name) ?? [];
              return list.onRemove
                ? list.onRemove(intent, index)
                : setIn(intent, list.name, items.filter((_, i) => i !== index));
            }}
            onRemoved={back}
          />
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
  base,
}: {
  list: ListSpec<N>;
  base: string;
}) => {
  const navigate = useNavigate();
  const main = useDraft();
  // Its own draft, over a copy with the item appended. Problems show only
  // once a field is edited, or Add is pressed: not on a blank form.
  const [{ copy, index }] = useState(() => {
    const items: Item<N>[] = main.get(list.name) ?? [];
    const value = setIn(main.value, list.name, [...items, list.newItem(items, main.value)]);
    return { copy: new Draft(main.value, value, false), index: items.length };
  });
  const back = () => navigate(base);
  const add = () => {
    // What adding implies (home networks reach it) first, so the check sees it.
    const next = list.onAdd ? list.onAdd(copy.value, index) : copy.value;
    const path = `${list.name}.${index}`;
    const incomplete = issuesOf(next).some(
      (issue) => issue.path === path || issue.path.startsWith(`${path}.`)
    );
    if (incomplete) {
      copy.reveal();
      return;
    }
    main.replace(next);
    back();
  };
  return (
    <DraftProvider draft={copy}>
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
    </DraftProvider>
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
  const items: unknown[] = useDraftValue(list.name) ?? [];
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
  const props = { list, base };
  if (sub === "new") return <NewItemPage {...props} />;
  const index = /^\d+$/.test(sub) ? Number(sub) : undefined;
  return index !== undefined && index < items.length ? (
    <ListItemPage {...props} index={index} />
  ) : (
    <ListTable {...props} page={page} />
  );
};
