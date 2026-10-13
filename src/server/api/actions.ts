// What a Status page can ask for (and only then, src/status/actions.ts):
// restart a service the settings declare on a device, reboot one, restart
// its Wi-Fi, ping from it, test the internet
// line's speed, survey the air around the access points, OpenWrt's latest
// release, and a mesh link's speed (src/meshSpeed.ts).
import { measureLink } from "../../meshSpeed";
import { fail } from "../../problem";
import { latestRelease, pingFrom, rebootDevice, restartService, restartWifi, speedTest, wifiSurvey } from "../../status/actions";
import { ApiContext, field, respond, Route, withBody } from "../router";

export const actionRoutes = ({ intentPath, platform, now }: ApiContext): Route[] => [
  {
    path: "/api/fix",
    POST: withBody(async (input) => {
      const [device, service] = [field(input, "device"), field(input, "service")];
      if (!device || !/^[A-Za-z0-9_-]+$/.test(service)) return respond(fail("invalid", "Give a device and a service."));
      return respond(await restartService({ intentPath, platform, hostname: device, service }));
    }),
  },
  {
    path: "/api/device/reboot",
    POST: withBody(async (input) => {
      const device = field(input, "device");
      return respond(device ? await rebootDevice({ intentPath, platform, hostname: device, now }) : fail("invalid", "Give a device."));
    }),
  },
  {
    path: "/api/device/wifi-restart",
    POST: withBody(async (input) => {
      const device = field(input, "device");
      return respond(device ? await restartWifi({ intentPath, platform, hostname: device }) : fail("invalid", "Give a device."));
    }),
  },
  {
    path: "/api/device/ping",
    POST: withBody(async (input) => {
      const [device, target] = [field(input, "device"), field(input, "target")];
      return respond(device ? await pingFrom({ intentPath, platform, hostname: device, target }) : fail("invalid", "Give a device."));
    }),
  },
  { path: "/api/internet/speed", POST: async () => respond(await speedTest({ intentPath, platform })) },
  { path: "/api/wifi/survey", POST: async () => respond(await wifiSurvey({ intentPath, platform })) },
  { path: "/api/firmware", GET: async () => respond(await latestRelease({ intentPath, platform, now })) },
  {
    path: "/api/mesh/speed",
    POST: withBody(async (input) => {
      const [from, to] = [field(input, "from"), field(input, "to")];
      if (!from || !to || from === to) return respond(fail("invalid", "Give two devices: from and to."));
      return respond(await measureLink({ intentPath, platform, from, to }));
    }),
  },
];
