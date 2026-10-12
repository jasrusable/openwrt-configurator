import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { persistDeviceReads } from "./data/persist";
import { cssVariables, theme } from "./kit/theme";

const queryClient = new QueryClient({
  // One user editing one file: refetching behind their back would only
  // fight with what they are typing.
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});
// What the devices last said, shown at once after a reload while it is read again.
persistDeviceReads(queryClient);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider theme={theme} cssVariablesResolver={cssVariables} defaultColorScheme="auto">
      <Notifications position="bottom-right" />
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>
);
