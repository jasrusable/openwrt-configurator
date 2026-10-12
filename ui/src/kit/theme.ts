import { Badge, createTheme, CSSVariablesResolver } from "@mantine/core";

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
  components: {
    // Sentence case, as Apple's UI writes labels, not Mantine's capitals.
    Badge: Badge.extend({ styles: { root: { textTransform: "none" } } }),
  },
});

/**
 * Mantine derives its "light" tints (light buttons, badges, list icons)
 * from the palette's far shades: navy text in light mode, near-black fills
 * in dark. These are Apple's system blue and greys instead.
 */
export const cssVariables: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    "--mantine-color-blue-light": "rgba(0, 122, 255, 0.12)",
    "--mantine-color-blue-light-hover": "rgba(0, 122, 255, 0.18)",
    "--mantine-color-blue-light-color": "#007aff",
  },
  dark: {
    "--mantine-color-blue-light": "rgba(10, 132, 255, 0.2)",
    "--mantine-color-blue-light-hover": "rgba(10, 132, 255, 0.28)",
    "--mantine-color-blue-light-color": "#4da3ff",
    "--mantine-color-gray-light": "rgba(235, 235, 245, 0.12)",
    "--mantine-color-gray-light-hover": "rgba(235, 235, 245, 0.18)",
    "--mantine-color-gray-light-color": "#d1d1d6",
  },
});
