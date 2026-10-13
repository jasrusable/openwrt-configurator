// Adding hardware, guided (src/discover.ts): what is on the network and not
// in Hardware (GET /api/discover), a read of the device picked (POST
// /api/discover/inspect {address}), and taking it on under a name (POST
// /api/discover/adopt {address, name}).
import { adopt, discover, inspectAt } from "../../discover";
import { map } from "../../result";
import { ApiContext, field, respond, Route, withBody } from "../router";

export const discoverRoutes = ({ intentPath, platform, now }: ApiContext): Route[] => [
  {
    path: "/api/discover",
    GET: async () => respond(map(await discover({ intentPath, platform }), (candidates) => ({ candidates }))),
  },
  {
    path: "/api/discover/inspect",
    POST: withBody(async (input) => respond(await inspectAt({ intentPath, platform, address: field(input, "address") }))),
  },
  {
    path: "/api/discover/adopt",
    POST: withBody(async (input) =>
      respond(await adopt({ intentPath, platform, address: field(input, "address"), name: field(input, "name"), now }))
    ),
  },
];
