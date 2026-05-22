import axios, { AxiosError, AxiosResponse } from "axios";
import { createHash } from "crypto";
import { createReadStream, createWriteStream } from "fs";
import { mkdir, unlink } from "fs/promises";
import { dirname } from "path";
import { z } from "zod";

const TRANSIENT_STATUSES = new Set([502, 503, 504, 529]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const withRetry = async <T>(
  fn: () => Promise<T>,
  {
    attempts = 4,
    baseMs = 1000,
    isTransient,
    label,
  }: {
    attempts?: number;
    baseMs?: number;
    isTransient: (e: unknown) => boolean;
    label: string;
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
          (e as Error).message
        } — retrying in ${wait}ms`
      );
      await sleep(wait);
    }
  }
  throw lastErr;
};

const axiosStatus = (e: unknown): number | undefined =>
  (e as AxiosError)?.response?.status;

const isTransientAxiosError = (e: unknown): boolean => {
  const status = axiosStatus(e);
  if (status !== undefined && TRANSIENT_STATUSES.has(status)) return true;
  const code = (e as AxiosError)?.code;
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ECONNABORTED" ||
    code === "EAI_AGAIN"
  );
};

const ASU_BASE = "https://sysupgrade.openwrt.org";
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
}: {
  version: string;
  modelId: string;
}): Promise<{ profile: string; target: string }> => {
  if (!overviewCache[version]) {
    const response = await axios.get(
      `${DOWNLOADS_BASE}/releases/${version}/.overview.json`,
      { responseType: "json" }
    );
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

export const requestBuild = async (
  req: BuildRequest
): Promise<{ requestHash: string }> => {
  const post = async (): Promise<AxiosResponse> =>
    axios.post(`${ASU_BASE}/api/v1/build`, req, {
      validateStatus: (s) => s === 200 || s === 202,
    });

  try {
    const response = await withRetry(post, {
      isTransient: isTransientAxiosError,
      label: "asu build",
    });
    const requestHash =
      response.data?.request_hash || response.headers["x-request-hash"];
    if (!requestHash) {
      throw new Error(
        `ASU build response missing request_hash: ${JSON.stringify(response.data)}`
      );
    }
    return { requestHash };
  } catch (e) {
    const ae = e as AxiosError;
    const status = ae.response?.status;
    const data = ae.response?.data;
    const dataStr =
      typeof data === "string" ? data : JSON.stringify(data);
    if (
      status === 400 &&
      typeof dataStr === "string" &&
      dataStr.toLowerCase().includes("defaults")
    ) {
      throw new Error(
        `ASU rejected uci-defaults (status 400): ${dataStr}. The server may have allow_defaults=false; if you control it, enable that setting.`
      );
    }
    throw new Error(
      `ASU build request failed: ${status} ${dataStr}`
    );
  }
};

export const pollBuild = async ({
  requestHash,
  timeoutMs = 10 * 60 * 1000,
  intervalMs = 3000,
}: {
  requestHash: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<BuildResult> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = await withRetry(
      () =>
        axios.get(`${ASU_BASE}/api/v1/build/${requestHash}`, {
          validateStatus: (s) =>
            s === 200 || s === 202 || s === 400 || s === 500,
        }),
      { isTransient: isTransientAxiosError, label: `asu poll ${requestHash}` }
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
    await sleep(intervalMs);
  }
  throw new Error(
    `ASU build did not complete within ${timeoutMs}ms (request_hash=${requestHash})`
  );
};

const HEAD_BYTES = 512;

const KNOWN_IMAGE_MAGICS: { name: string; offset: number; bytes: number[] }[] = [
  { name: "gzip", offset: 0, bytes: [0x1f, 0x8b] },
  { name: "uImage", offset: 0, bytes: [0x27, 0x05, 0x19, 0x56] },
  { name: "FIT/DTB", offset: 0, bytes: [0xd0, 0x0d, 0xfe, 0xed] },
  { name: "squashfs", offset: 0, bytes: [0x68, 0x73, 0x71, 0x73] },
  { name: "ELF", offset: 0, bytes: [0x7f, 0x45, 0x4c, 0x46] },
  // POSIX tar: "ustar" at offset 257. Sysupgrade for NAND/UBI targets ships .tar.
  { name: "tar", offset: 257, bytes: [0x75, 0x73, 0x74, 0x61, 0x72] },
];

const identifyMagic = (head: Buffer): string | undefined => {
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
}: {
  binDir: string;
  name: string;
  outPath: string;
  expectedSha256: string;
  expectedSize?: number;
}): Promise<{ sha256: string; size: number; magic: string }> => {
  await mkdir(dirname(outPath), { recursive: true });
  const url = `${ASU_BASE}/store/${binDir}/${name}`;
  const response = await axios.get(url, { responseType: "stream" });
  const contentLength = response.headers["content-length"]
    ? parseInt(response.headers["content-length"], 10)
    : undefined;
  const declaredSize = expectedSize ?? contentLength;

  const hash = createHash("sha256");
  let bytesWritten = 0;
  const head = Buffer.alloc(HEAD_BYTES);
  let headBytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(outPath);
      response.data.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        bytesWritten += chunk.length;
        if (headBytes < HEAD_BYTES) {
          const room = HEAD_BYTES - headBytes;
          const copyLen = Math.min(room, chunk.length);
          chunk.copy(head, headBytes, 0, copyLen);
          headBytes += copyLen;
        }
      });
      response.data.pipe(stream);
      stream.on("finish", () => resolve());
      stream.on("error", reject);
      response.data.on("error", reject);
    });

    if (declaredSize !== undefined && bytesWritten !== declaredSize) {
      throw new Error(
        `size mismatch for ${name}: expected ${declaredSize} bytes, got ${bytesWritten}`
      );
    }

    const sha256 = hash.digest("hex");
    if (sha256 !== expectedSha256) {
      throw new Error(
        `sha256 mismatch for ${name}: expected ${expectedSha256}, got ${sha256}`
      );
    }

    const headSlice = head.subarray(0, headBytes);
    const magic = identifyMagic(headSlice);
    if (!magic) {
      const firstHex = headSlice
        .subarray(0, 16)
        .toString("hex")
        .match(/.{1,2}/g)
        ?.join(" ");
      console.warn(
        `[downloadImage] ${name}: unrecognized format (first 16 bytes = ${firstHex}). sha256 verified, keeping file.`
      );
    }

    return { sha256, size: bytesWritten, magic: magic ?? "unknown" };
  } catch (e) {
    await unlink(outPath).catch(() => {});
    throw e;
  }
};

export const verifyImageFile = async ({
  path,
  expectedSha256,
}: {
  path: string;
  expectedSha256: string;
}): Promise<{ ok: boolean; actualSha256: string }> => {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  const actualSha256 = hash.digest("hex");
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
