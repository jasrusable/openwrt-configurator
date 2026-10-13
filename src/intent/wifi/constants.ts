// Wi-Fi's numbers, written once: the compiler writes them (compile.ts,
// airtime.ts) and the explainers quote them (fields.ts).

/** dBm. The driver still caps it at what the country allows. */
export const txpower = { low: 10, medium: 15, high: 20 } as const;

/**
 * Wi-Fi queue limits (AQL, in µs: low and high water mark per access
 * category). Lower keeps less queued in the radio, so a call stays snappy
 * while something downloads; higher fills the air better.
 */
export const aqlLimits = {
  balanced: [5000, 12000], // the kernel's own
  latency: [2000, 4000],
  throughput: [8000, 20000],
} as const;
