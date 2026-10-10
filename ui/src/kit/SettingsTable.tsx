// Settings for a fixed set of things, side by side: a row per thing (a band,
// say), a column per setting, each cell its control. For when every row has
// the same few settings and a list of detail pages would be too much.
import { Paper, Table, Text } from "@mantine/core";
import { ReactNode } from "react";

export const SettingsTable = <K extends string>({
  rows,
  columns,
}: {
  rows: { key: K; label: ReactNode; description?: ReactNode }[];
  columns: { header: string; cell: (key: K) => ReactNode }[];
}) => (
  <Paper withBorder radius="lg" style={{ overflow: "auto" }}>
    <Table verticalSpacing="sm" horizontalSpacing="md">
      <Table.Thead>
        <Table.Tr>
          <Table.Th />
          {columns.map((column) => (
            <Table.Th key={column.header}>
              <Text size="xs" c="dimmed" fw={500}>
                {column.header}
              </Text>
            </Table.Th>
          ))}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((row) => (
          <Table.Tr key={row.key}>
            <Table.Td>
              <Text size="sm" fw={500}>
                {row.label}
              </Text>
              {row.description && (
                <Text size="xs" c="dimmed">
                  {row.description}
                </Text>
              )}
            </Table.Td>
            {columns.map((column) => (
              <Table.Td key={column.header}>{column.cell(row.key)}</Table.Td>
            ))}
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  </Paper>
);
