// The internet feature's numbers, written once: the compiler writes them
// (compile.ts) and the explainers quote them (fields.ts).

/** How often dynamic DNS checks the address. */
export const ddnsCheckMinutes = 10;

/**
 * Where miniupnpd asks for its outer address when the line's own may be a
 * private one (behind another router): a public STUN server.
 */
export const stunServer = { host: "stun.cloudflare.com", port: 3478 };
