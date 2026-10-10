// A button that asks first, for actions that change real things.
import { Button, ButtonProps, Group, Modal, Text } from "@mantine/core";
import { ReactNode, useState } from "react";

export const ConfirmButton = ({
  children,
  title,
  message,
  confirmLabel,
  onConfirm,
  ...button
}: ButtonProps & {
  children: ReactNode;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button {...button} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Modal opened={open} onClose={() => setOpen(false)} title={title} centered>
        <Text size="sm">{message}</Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            color={button.color}
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </Group>
      </Modal>
    </>
  );
};
