import { createTheme } from "@mantine/core";

// Close to Apple's system look: the system font, soft corners, iOS blue.
export const theme = createTheme({
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif',
  headings: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif',
    fontWeight: "600",
  },
  primaryColor: "blue",
  defaultRadius: "md",
  colors: {
    blue: [
      "#e5f1ff",
      "#cce3ff",
      "#99c7ff",
      "#66abff",
      "#338fff",
      "#007aff",
      "#0062cc",
      "#004999",
      "#003166",
      "#001833",
    ],
  },
  primaryShade: 5,
});
