// A list of things as a table: a row per item that opens it when clicked, and
// a friendly empty state. Its title and Add live in the page's header.
import { Group, Table, Text } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { ReactNode, useContext } from "react";
import { EmptyState, InCard } from "./layout";

export type Column = {
  header: string;
  /** The cell for row `index`. */
  cell: (index: number) => ReactNode;
  width?: number | string;
};

export const DataTable = ({
  columns,
  rowCount,
  rowKey,
  onRowClick,
  rowMarker,
  empty,
}: {
  columns: Column[];
  rowCount: number;
  rowKey: (index: number) => string;
  onRowClick: (index: number) => void;
  /** Shown before the first cell, e.g. a mark on rows that need fixing. */
  rowMarker?: (index: number) => ReactNode;
  empty: ReactNode;
}) => (
  <div className={useContext(InCard) ? undefined : "onc-card"}>
    {rowCount === 0 ? (
      <EmptyState>{empty}</EmptyState>
    ) : (
      // Scrolls sideways on a phone rather than squeezing its columns.
      <Table.ScrollContainer minWidth={520} type="native">
        <Table verticalSpacing="sm" horizontalSpacing="md" withRowBorders={false}>
          <Table.Thead>
            <Table.Tr>
              {columns.map((column) => (
                <Table.Th key={column.header} w={column.width}>
                  <Text size="xs" c="dimmed" fw={500}>
                    {column.header}
                  </Text>
                </Table.Th>
              ))}
              <Table.Th w={32} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {Array.from({ length: rowCount }, (_, index) => (
              <Table.Tr
                key={rowKey(index)}
                onClick={() => onRowClick(index)}
                // Openable from the keyboard too.
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && onRowClick(index)}
                style={{ cursor: "pointer", transition: "background 120ms" }}
              >
                {columns.map((column, c) => (
                  <Table.Td key={column.header}>
                    <Group gap={8} wrap="nowrap">
                      {c === 0 && rowMarker?.(index)}
                      {column.cell(index)}
                    </Group>
                  </Table.Td>
                ))}
                <Table.Td>
                  <IconChevronRight size={16} color="var(--onc-label-2)" />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    )}
  </div>
);
