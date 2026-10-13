import { z } from "zod";
import { messageOf } from "./result";
import { dirname } from "./posixPath";
import { HttpResponse, Platform } from "./platform";

type Http = Pick<Platform, "http" | "sleep">;

const TRANSIENT_STATUSES = new Set([502, 503, 504, 529]);

const withRetry = async <T>(
  fn: () => Promise<T>,
  {
    attempts = 4,
    baseMs = 1000,
    isTransient,
    label,
    sleep,
  }: {
    attempts?: number;
    baseMs?: number;
    isTransient: (e: unknown) => boolean;
    label: string;
    sleep: (ms: number) => Promise<void>;
  }
): Promise<T> => {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransient(e) || i === attempts - 1) throw e;
      const wait = baseMs * Math.pow(2, i);
      console.warn(
        `[${label}] transient error (attempt ${i + 1}/${attempts}): ${
          messageOf(e)
        } — retrying in ${wait}ms`
      );
      await sleep(wait);
    }
  }
  throw lastErr;
};

type HttpError = Error & {
  transient: boolean;
  status?: number;
  data?: unknown;
};

const parseBody = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
};

/**
 * One HTTP call. A status outside `accept` throws, and is retryable only if it
 * is one of `TRANSIENT_STATUSES`; network failures carry their own flag.
 */
const request = async ({
  method,
  url,
  json,
  accept,
  platform,
}: {
  method: "GET" | "POST";
  url: string;
  json?: unknown;
  accept: number[];
  platform: Http;
}): Promise<HttpResponse & { data: unknown }> => {
  const response = await platform.http.request({ method, url, json });
  const data = parseBody(response.body);
  if (!accept.includes(response.status)) {
    throw Object.assign(
      new Error(`${method} ${url} failed with status ${response.status}`),
      {
        transient: TRANSIENT_STATUSES.has(response.status),
        status: response.status,
        data,
      }
    );
  }
  return { ...response, data };
};

const isTransient = (e: unknown) => (e as HttpError)?.transient === true;

const ASU_BASE = "https://sysupgrade.openwrt.org";

/** Where ASU serves a built image: what a device upgrading itself downloads. */
export const asuImageUrl = (binDir: string, name: string) => `${ASU_BASE}/store/${binDir}/${name}`;
const DOWNLOADS_BASE = "https://downloads.openwrt.org";

const overviewSchema = z.object({
  profiles: z.array(
    z.object({
      id: z.string(),
      target: z.string(),
    })
  ),
});

let overviewCache: Record<string, Record<string, string>> = {};

export const getProfileTarget = async ({
  version,
  modelId,
  platform,
}: {
  version: string;
  modelId: string;
  platform: Http;
}): Promise<{ profile: string; target: string }> => {
  if (!overviewCache[version]) {
    const response = await request({
      method: "GET",
      url: `${DOWNLOADS_BASE}/releases/${version}/.overview.json`,
      platform,
      accept: [200],
    });
    const parsed = overviewSchema.parse(response.data);
    overviewCache[version] = parsed.profiles.reduce<Record<string, string>>(
      (acc, p) => ({ ...acc, [p.id]: p.target }),
      {}
    );
  }
  const profileId = modelId.replace(",", "_");
  const target = overviewCache[version][profileId];
  if (!target) {
    throw new Error(
      `No profile "${profileId}" found in OpenWrt ${version} releases. Check the model_id and version.`
    );
  }
  return { profile: profileId, target };
};

const buildImageSchema = z.object({
  name: z.string(),
  sha256: z.string(),
  type: z.string(),
  size: z.number().optional(),
});

const buildResultSchema = z.object({
  bin_dir: z.string(),
  images: z.array(buildImageSchema),
});

export type BuildResult = z.infer<typeof buildResultSchema>;

export type BuildRequest = {
  version: string;
  target: string;
  profile: string;
  packages: string[];
  defaults: string;
};

export const requestBuild = async ({
  req,
  platform,
}: {
  req: BuildRequest;
  platform: Http;
}): Promise<{ requestHash: string }> => {
  const post = () =>
    request({
      method: "POST",
      url: `${ASU_BASE}/api/v1/build`,
      json: req,
      accept: [200, 202],
      platform,
    });

  try {
    const response = await withRetry(post, {
      isTransient,
      label: "asu build",
      sleep: platform.sleep,
    });
    const requestHash =
      (response.data as { request_hash?: string })?.request_hash ||
      response.headers["x-request-hash"];
    if (!requestHash) {
      throw new Error(
        `ASU build response missing request_hash: ${JSON.stringify(
          response.data
        )}`
      );
    }
    return { requestHash };
  } catch (e) {
    const he = e as HttpError;
    const status = he.status;
    const data = he.status === undefined ? he.message : he.data;
    const dataStr = typeof data === "string" ? data : JSON.stringify(data);
    if (
      status === 400 &&
      typeof dataStr === "string" &&
      dataStr.toLowerCase().includes("defaults")
    ) {
      throw new Error(
        `ASU rejected uci-defaults (status 400): ${dataStr}. The server may have allow_defaults=false; if you control it, enable that setting.`
      );
    }
    throw new Error(`ASU build request failed: ${status} ${dataStr}`);
  }
};

export const pollBuild = async ({
  requestHash,
  timeoutMs = 10 * 60 * 1000,
  intervalMs = 3000,
  platform,
}: {
  requestHash: string;
  timeoutMs?: number;
  intervalMs?: number;
  platform: Http;
}): Promise<BuildResult> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = await withRetry(
      () =>
        request({
          method: "GET",
          url: `${ASU_BASE}/api/v1/build/${requestHash}`,
          accept: [200, 202, 400, 500],
          platform,
        }),
      { isTransient, label: `asu poll ${requestHash}`, sleep: platform.sleep }
    );
    if (response.status === 200) {
      return buildResultSchema.parse(response.data);
    }
    if (response.status >= 400) {
      throw new Error(
        `ASU build failed (status ${response.status}): ${
          typeof response.data === "string"
            ? response.data
            : JSON.stringify(response.data)
        }`
      );
    }
    await platform.sleep(intervalMs);
  }
  throw new Error(
    `ASU build did not complete within ${timeoutMs}ms (request_hash=${requestHash})`
  );
};

const HEAD_BYTES = 512;

const KNOWN_IMAGE_MAGICS: { name: string; offset: number; bytes: number[] }[] =
  [
    { name: "gzip", offset: 0, bytes: [0x1f, 0x8b] },
    { name: "uImage", offset: 0, bytes: [0x27, 0x05, 0x19, 0x56] },
    { name: "FIT/DTB", offset: 0, bytes: [0xd0, 0x0d, 0xfe, 0xed] },
    { name: "squashfs", offset: 0, bytes: [0x68, 0x73, 0x71, 0x73] },
    { name: "ELF", offset: 0, bytes: [0x7f, 0x45, 0x4c, 0x46] },
    // POSIX tar: "ustar" at offset 257. Sysupgrade for NAND/UBI targets ships .tar.
    { name: "tar", offset: 257, bytes: [0x75, 0x73, 0x74, 0x61, 0x72] },
  ];

const identifyMagic = (head: Uint8Array): string | undefined => {
  for (const { name, offset, bytes } of KNOWN_IMAGE_MAGICS) {
    if (
      head.length >= offset + bytes.length &&
      bytes.every((b, i) => head[offset + i] === b)
    ) {
      return name;
    }
  }
  return undefined;
};

export const downloadImage = async ({
  binDir,
  name,
  outPath,
  expectedSha256,
  expectedSize,
  platform,
}: {
  binDir: string;
  name: string;
  outPath: string;
  expectedSha256: string;
  expectedSize?: number;
  platform: Pick<
    Platform,
    "http" | "mkdirp" | "sha256File" | "readFileHead" | "removeFile"
  >;
}): Promise<{ sha256: string; size: number; magic: string }> => {
  platform.mkdirp(dirname(outPath));
  const url = asuImageUrl(binDir, name);

  try {
    const { bytes, contentLength } = await platform.http.download(url, outPath);
    const declaredSize = expectedSize ?? contentLength;

    if (declaredSize !== undefined && bytes !== declaredSize) {
      throw new Error(
        `size mismatch for ${name}: expected ${declaredSize} bytes, got ${bytes}`
      );
    }

    const sha256 = await platform.sha256File(outPath);
    if (sha256 !== expectedSha256) {
      throw new Error(
        `sha256 mismatch for ${name}: expected ${expectedSha256}, got ${sha256}`
      );
    }

    const head = platform.readFileHead(outPath, HEAD_BYTES);
    const magic = identifyMagic(head);
    if (!magic) {
      const firstHex = Array.from(head.subarray(0, 16))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      console.warn(
        `[downloadImage] ${name}: unrecognized format (first 16 bytes = ${firstHex}). sha256 verified, keeping file.`
      );
    }

    return { sha256, size: bytes, magic: magic ?? "unknown" };
  } catch (e) {
    platform.removeFile(outPath);
    throw e;
  }
};

export const verifyImageFile = async ({
  path,
  expectedSha256,
  platform,
}: {
  path: string;
  expectedSha256: string;
  platform: Pick<Platform, "sha256File">;
}): Promise<{ ok: boolean; actualSha256: string }> => {
  const actualSha256 = await platform.sha256File(path);
  return { ok: actualSha256 === expectedSha256, actualSha256 };
};

export const pickSysupgradeImage = (result: BuildResult) => {
  const sysupgrades = result.images.filter((i) => i.type === "sysupgrade");
  if (sysupgrades.length === 0) {
    throw new Error(
      `Build result has no sysupgrade image. Available types: ${result.images
        .map((i) => i.type)
        .join(", ")}`
    );
  }
  const squashfs = sysupgrades.find((i) => /squashfs/i.test(i.name));
  if (squashfs) return squashfs;
  if (sysupgrades.length > 1) {
    console.warn(
      `[pickSysupgradeImage] no squashfs sysupgrade found; falling back to ${
        sysupgrades[0].name
      }. Available: ${sysupgrades.map((i) => i.name).join(", ")}`
    );
  }
  return sysupgrades[0];
};
