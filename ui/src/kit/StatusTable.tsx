// A Status list as a table: fixed columns that line up, sorted by any of
// them (the choice kept in this browser), each row opening its item's page.
// On a phone, each row is two lines instead: its name and what matters,
// and a value at the right.
import { Group, Stack, Table, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconChevronDown, IconChevronRight, IconChevronUp } from "@tabler/icons-react";
import { ReactNode, useState } from "react";
import { EmptyState } from "./layout";

export type StatusColumn<T> = {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** What it sorts by; unsortable without. Undefined sorts last either way. */
  sort?: (row: T) => number | string | undefined;
  /** Numbers line up at the right. */
  align?: "right";
  width?: number | string;
};

type Sort = { key: string; descending: boolean };

const stored = (id: string): Sort | undefined => {
  try {
    const value = JSON.parse(localStorage.getItem(`onc-sort-${id}`) ?? "null");
    return value && typeof value.key === "string" ? { key: value.key, descending: !!value.descending } : undefined;
  } catch {
    return undefined;
  }
};

const store = (id: string, sort: Sort) => {
  try {
    localStorage.setItem(`onc-sort-${id}`, JSON.stringify(sort));
  } catch {
    // Storage blocked: the sort lasts this page.
  }
};

const compare = (a: number | string | undefined, b: number | string | undefined) =>
  a === undefined ? (b === undefined ? 0 : 1) : b === undefined ? -1 : typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));

export const StatusTable = <T,>({
  id,
  rows,
  columns,
  rowKey,
  onOpen,
  initialSort,
  empty,
  phone,
}: {
  /** Names the kept sort. */
  id: string;
  rows: T[];
  columns: StatusColumn<T>[];
  rowKey: (row: T) => string;
  onOpen?: (row: T) => void;
  initialSort?: Sort;
  empty: ReactNode;
  /** A row on a phone: its leading cell, the line under it, and the value at the right. */
  phone: (row: T) => { lead: ReactNode; sub?: ReactNode; end?: ReactNode };
}) => {
  const narrow = useMediaQuery("(max-width: 37.5em)");
  const [sort, setSort] = useState<Sort | undefined>(() => {
    const kept = stored(id);
    return kept && columns.some((c) => c.key === kept.key && c.sort) ? kept : initialSort;
  });
  const by = columns.find((c) => c.key === sort?.key)?.sort;
  // Stable: ties keep the order given (the page's own: online first, say).
  const sorted = by
    ? rows
        .map((row, i) => ({ row, i }))
        .sort((a, b) => {
          const [x, y] = [by(a.row), by(b.row)];
          // Unknown last in either direction.
          const order = x === undefined || y === undefined ? compare(x, y) : sort!.descending ? compare(y, x) : compare(x, y);
          return order || a.i - b.i;
        })
        .map(({ row }) => row)
    : rows;
  const choose = (key: string) => {
    const next = { key, descending: sort?.key === key ? !sort.descending : false };
    setSort(next);
    store(id, next);
  };
  if (!rows.length) return <EmptyState>{empty}</EmptyState>;
  if (narrow) {
    return (
      <Stack gap={0}>
        {sorted.map((row) => {
          const { lead, sub, end } = phone(row);
          return (
            <button key={rowKey(row)} type="button" className="onc-list-row" onClick={() => onOpen?.(row)} disabled={!onOpen}>
              <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                {lead}
                {sub && (
                  <Text component="div" size="xs" c="dimmed" truncate>
                    {sub}
                  </Text>
                )}
              </Stack>
              {end}
              {onOpen && <IconChevronRight size={16} color="var(--onc-label-2)" style={{ flexShrink: 0 }} />}
            </button>
          );
        })}
      </Stack>
    );
  }
  return (
    <Table.ScrollContainer minWidth={640} type="native">
      <Table verticalSpacing={8} horizontalSpacing="md" withRowBorders={false}>
        <Table.Thead>
          <Table.Tr>
            {columns.map((c) => (
              <Table.Th key={c.key} w={c.width} ta={c.align} aria-sort={sort?.key === c.key ? (sort.descending ? "descending" : "ascending") : undefined}>
                {c.sort ? (
                  <button type="button" className="onc-sort" onClick={() => choose(c.key)}>
                    <Text span size="xs" c="dimmed" fw={500}>
                      {c.header}
                    </Text>
                    {sort?.key === c.key ? (
                      sort.descending ? <IconChevronDown size={12} aria-hidden /> : <IconChevronUp size={12} aria-hidden />
                    ) : null}
                  </button>
                ) : (
                  <Text span size="xs" c="dimmed" fw={500}>
                    {c.header}
                  </Text>
                )}
              </Table.Th>
            ))}
            {onOpen && <Table.Th w={28} />}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {sorted.map((row) => (
            <Table.Tr
              key={rowKey(row)}
              className={onOpen ? "onc-table-row" : undefined}
              onClick={onOpen && (() => onOpen(row))}
              tabIndex={onOpen ? 0 : undefined}
              onKeyDown={onOpen && ((e) => e.key === "Enter" && onOpen(row))}
            >
              {columns.map((c) => (
                <Table.Td key={c.key} ta={c.align}>
                  <Group gap={8} wrap="nowrap" justify={c.align === "right" ? "flex-end" : undefined}>
                    {c.cell(row)}
                  </Group>
                </Table.Td>
              ))}
              {onOpen && (
                <Table.Td>
                  <IconChevronRight size={16} color="var(--onc-label-2)" />
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
};
