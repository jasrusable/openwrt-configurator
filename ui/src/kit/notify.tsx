// Toasts, one style for all: a short line, an icon, gone on their own.
import { notifications } from "@mantine/notifications";
import { IconAlertCircle, IconCheck } from "@tabler/icons-react";

export const notify = {
  success: (message: string) =>
    notifications.show({ message, color: "green", icon: <IconCheck size={16} />, autoClose: 2500 }),
  error: (message: string) =>
    notifications.show({ message, color: "red", icon: <IconAlertCircle size={16} />, autoClose: 6000 }),
};
