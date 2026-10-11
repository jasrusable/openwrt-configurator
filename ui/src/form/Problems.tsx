// What is wrong with the draft, wherever it is: a button in the header that
// lists every problem in people's terms, each leading to its page; and a
// count per page for the sidebar. All of it read off the draft's problems.
import { Badge, Button, Popover, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { describePath } from "../../../src/intent/diff";
import { whereIs } from "../settingPages";
import { useDraft, useIssues } from "./draft";

export const ProblemsButton = () => {
  const issues = useIssues();
  const draft = useDraft();
  const navigate = useNavigate();
  const [opened, setOpened] = useState(false);
  if (issues.length === 0) return null;
  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" width={380} shadow="md">
      <Popover.Target>
        <Button
          variant="light"
          color="red"
          leftSection={<IconAlertCircle size={16} />}
          onClick={() => setOpened((o) => !o)}
        >
          {issues.length} to fix
        </Button>
      </Popover.Target>
      <Popover.Dropdown p={6}>
        <Stack gap={2}>
          {issues.map((issue) => {
            const where = whereIs(issue.path);
            const label = describePath(issue.path.split("."), draft.value);
            return (
              <UnstyledButton
                key={`${issue.path}:${issue.message}`}
                p={8}
                style={{ borderRadius: 8 }}
                className="onc-problem"
                onClick={() => {
                  setOpened(false);
                  if (where) navigate(where.url);
                }}
              >
                <Text size="sm" fw={500}>
                  {label.length ? label.join(" › ") : issue.path}
                </Text>
                <Text size="xs" c="red">
                  {issue.message}
                </Text>
              </UnstyledButton>
            );
          })}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
};

/** How many problems a page's settings have. */
export const usePageProblems = () => {
  const issues = useIssues();
  return (page: string) => issues.filter((issue) => whereIs(issue.path)?.page === page).length;
};

export const ProblemCount = ({ count }: { count: number }) =>
  count > 0 ? (
    <Badge size="sm" circle color="red" variant="filled">
      {count}
    </Badge>
  ) : null;
