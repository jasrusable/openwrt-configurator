import { NetworkError, Platform } from "../../platform";
import { fileExists, fileSize, readTextFile, removeFile } from "./files";
import { spawn, tmpPath, which } from "./process";

// curl exit codes for failures worth retrying: DNS, connect, timeout, TLS
// handshake, empty reply, send/receive errors.
const transientCurlCodes = new Set([5, 6, 7, 28, 35, 52, 55, 56]);

const curl = async (args: string[], url: string, stdin?: string) => {
  if (!which("curl")) {
    throw new Error("HTTP requests need curl, which is not installed.");
  }
  const result = await spawn(["curl", "-sS", ...args, url], { stdin });
  if (result.code !== 0) {
    const error: NetworkError = Object.assign(
      new Error(
        `${url}: ${result.stderr.trim() || `curl exited ${result.code}`}`
      ),
      { transient: transientCurlCodes.has(result.code ?? -1) }
    );
    throw error;
  }
  return result;
};

/** Headers of the last response, after any redirects or 100-continue. */
const parseHeaders = (raw: string) => {
  const blocks = raw.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
  const headers: Record<string, string> = {};
  for (const line of (blocks[blocks.length - 1] || "")
    .split(/\r?\n/)
    .slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line
        .slice(colon + 1)
        .trim();
    }
  }
  return headers;
};

export const http: Platform["http"] = {
  request: async ({ method, url, json }) => {
    const headersPath = tmpPath("headers");
    const bodyPath = tmpPath("body");
    try {
      // The payload goes over stdin (an unlinked temp file), never a named
      // one: a build request carries the UCI-defaults script, secrets and all.
      const result = await curl(
        [
          "-X",
          method,
          "-D",
          headersPath,
          "-o",
          bodyPath,
          "-w",
          "%{http_code}",
          ...(json === undefined
            ? []
            : ["-H", "content-type: application/json", "--data-binary", "@-"]),
        ],
        url,
        json === undefined ? undefined : JSON.stringify(json)
      );
      return {
        status: Number(result.stdout.trim()),
        headers: parseHeaders(readTextFile(headersPath)),
        body: fileExists(bodyPath) ? readTextFile(bodyPath) : "",
      };
    } finally {
      removeFile(headersPath);
      removeFile(bodyPath);
    }
  },
  download: async (url, path) => {
    const headersPath = tmpPath("headers");
    try {
      // -f: a non-2xx status fails rather than saving an error page.
      await curl(["-f", "-L", "-D", headersPath, "-o", path], url);
      const declared = parseHeaders(readTextFile(headersPath))[
        "content-length"
      ];
      return {
        bytes: fileSize(path),
        contentLength: declared ? parseInt(declared, 10) : undefined,
      };
    } finally {
      removeFile(headersPath);
    }
  },
};
