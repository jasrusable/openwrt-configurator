// A list of things as a table: a title with actions at the top right, a row
// per item that opens it when clicked, and a friendly empty state.
import { Group, Paper, Table, Text } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { ReactNode } from "react";

export type Column = {
  header: string;
  /** The cell for row `index`. */
  cell: (index: number) => ReactNode;
  width?: number | string;
};

export const DataTable = ({
  title,
  actions,
  columns,
  rowCount,
  rowKey,
  onRowClick,
  rowMarker,
  empty,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  columns: Column[];
  rowCount: number;
  rowKey: (index: number) => string;
  onRowClick: (index: number) => void;
  /** Shown before the first cell, e.g. a mark on rows that need fixing. */
  rowMarker?: (index: number) => ReactNode;
  empty: ReactNode;
}) => (
  <div>
    {(title || actions) && (
      <Group justify="space-between" mb={6} px={4}>
        <Text fw={600} size="sm">
          {title}
        </Text>
        {actions}
      </Group>
    )}
    <Paper withBorder radius="lg" style={{ overflow: "hidden" }}>
      {rowCount === 0 ? (
        <Text c="dimmed" size="sm" ta="center" py="xl">
          {empty}
        </Text>
      ) : (
        <Table highlightOnHover verticalSpacing="sm" horizontalSpacing="md">
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
                style={{ cursor: "pointer" }}
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
                  <IconChevronRight size={16} color="var(--mantine-color-dimmed)" />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Paper>
  </div>
);
