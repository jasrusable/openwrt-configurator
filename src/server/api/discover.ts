// Adding hardware, guided (src/discover.ts): what is on the network and not
// in Hardware (GET /api/discover), a read of the device picked (POST
// /api/discover/inspect {address}), and taking it on under a name (POST
// /api/discover/adopt {address, name}); a device in Hardware that was reset,
// read again with its old key forgotten and taken back under its own name
// (inspect-reset, readopt {address, name}).
import { adopt, discover, inspectAt, inspectReset, readopt } from "../../discover";
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
    // A device in Hardware that was reset: read with its address's old key forgotten, then taken back by name.
    path: "/api/discover/inspect-reset",
    POST: withBody(async (input) =>
      respond(await inspectReset({ intentPath, platform, address: field(input, "address"), name: field(input, "name") }))
    ),
  },
  {
    path: "/api/discover/readopt",
    POST: withBody(async (input) =>
      respond(await readopt({ intentPath, platform, address: field(input, "address"), name: field(input, "name"), now }))
    ),
  },
  {
    path: "/api/discover/adopt",
    POST: withBody(async (input) =>
      respond(await adopt({ intentPath, platform, address: field(input, "address"), name: field(input, "name"), now }))
    ),
  },
];
