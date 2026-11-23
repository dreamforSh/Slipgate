import { S3Client } from "bun";
import { DB_BACKUP_DEFAULT_PREFIX, type BackupS3Config } from "@slipgate/contracts";

/** The S3 target with its decrypted secret (never persisted or returned in this form). */
export interface ResolvedS3Target extends BackupS3Config {
  secretAccessKey: string;
}

/** Object storage as the backup service uses it: whole objects only (parts stay below the 5 GiB PUT limit). */
export interface BackupObjectStore {
  /** Uploads a local file as one object (streamed from disk with its length). */
  uploadFile(key: string, path: string, contentType: string): Promise<void>;
  /** Streams one object; rejects with S3RequestError when it cannot be read. */
  download(key: string): Promise<ReadableStream<Uint8Array>>;
  /** Deletes one object (a missing object is not an error). */
  delete(key: string): Promise<void>;
  /** Presigned GET link (`attachment` disposition with `downloadName`). */
  presignGet(key: string, expiresInSeconds: number, downloadName: string): string;
  /** Writes and deletes a small probe object under the prefix: checks bucket, credentials and write/delete permission. */
  probe(prefix: string): Promise<void>;
}

export type BackupObjectStoreFactory = (target: ResolvedS3Target) => BackupObjectStore;

export class S3RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly s3Code: string,
  ) {
    super(message);
    this.name = "S3RequestError";
  }
}

/** bucket, access key and secret are all set. */
export function isS3Configured(cfg: { bucket: string; accessKeyId: string } | null, secretSet: boolean): boolean {
  return Boolean(cfg && cfg.bucket && cfg.accessKeyId && secretSet);
}

/** Key prefix without leading/trailing slashes; "" = `backups`. */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  return trimmed || DB_BACKUP_DEFAULT_PREFIX;
}

function isIpOrLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
}

/**
 * Bun S3Client options for a target. Path style keeps `endpoint/bucket/key`; virtual-hosted style
 * moves the bucket into the host name (`bucket.endpoint/key`), except for IP / localhost endpoints
 * where only path style can work.
 */
export function s3ClientOptions(t: ResolvedS3Target) {
  const region = t.region || "us-east-1";
  let endpoint = t.endpoint.trim().replace(/\/+$/, "");
  let virtualHostedStyle = false;
  if (!t.forcePathStyle) {
    const url = new URL(endpoint || `https://s3.${region}.amazonaws.com`);
    if (!isIpOrLocalHost(url.hostname)) {
      url.hostname = `${t.bucket}.${url.hostname}`;
      endpoint = url.toString().replace(/\/+$/, "");
      virtualHostedStyle = true;
    }
  }
  return {
    accessKeyId: t.accessKeyId,
    secretAccessKey: t.secretAccessKey,
    bucket: t.bucket,
    region,
    ...(endpoint ? { endpoint } : {}),
    virtualHostedStyle,
  };
}

/** `<Code>` / `<Message>` of an S3 XML error body (secrets never appear there). */
function parseS3Error(status: number, body: string): S3RequestError {
  const code = /<Code>([^<]{1,100})<\/Code>/.exec(body)?.[1] ?? `HTTP${status}`;
  const message = /<Message>([^<]{1,300})<\/Message>/.exec(body)?.[1] ?? (body.trim().slice(0, 200) || `HTTP ${status}`);
  return new S3RequestError(`${code}: ${message}`, status, code);
}

async function failure(res: Response): Promise<S3RequestError> {
  let text = "";
  try {
    text = (await res.text()).slice(0, 4096);
  } catch {
    // Body unreadable: the status alone has to do.
  }
  return parseS3Error(res.status, text);
}

const PRESIGN_OP_SECONDS = 3600;
const UPLOAD_ATTEMPTS = 3;

/**
 * Bun's S3Client signs every request (SigV4 presigned URLs); `fetch` carries it, so the requests
 * follow HTTP(S)_PROXY / NO_PROXY like every other outbound call of the BFF (Bun's native S3
 * transport ignores NO_PROXY, which breaks endpoints on the local network behind an egress proxy).
 * Objects are written with single PUTs streamed from disk; the service keeps every object (part)
 * below the 5 GiB single-PUT limit, the same layout Linksyncx uses.
 */
export function createBunObjectStore(target: ResolvedS3Target, fetchImpl: typeof fetch = fetch): BackupObjectStore {
  const client = new S3Client(s3ClientOptions(target));

  async function put(key: string, body: BodyInit, contentType: string): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
      try {
        const res = await fetchImpl(client.presign(key, { method: "PUT", expiresIn: PRESIGN_OP_SECONDS }), {
          method: "PUT",
          body,
          headers: { "Content-Type": contentType },
        });
        if (res.ok) {
          await res.body?.cancel().catch(() => undefined);
          return;
        }
        lastError = await failure(res);
        if (res.status < 500) break;
      } catch (err) {
        lastError = err;
      }
      if (attempt < UPLOAD_ATTEMPTS) await Bun.sleep(250 * attempt);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function del(key: string): Promise<void> {
    const res = await fetchImpl(client.presign(key, { method: "DELETE", expiresIn: PRESIGN_OP_SECONDS }), { method: "DELETE" });
    if (res.ok || res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      return;
    }
    throw await failure(res);
  }

  return {
    async uploadFile(key, path, contentType) {
      await put(key, Bun.file(path), contentType);
    },

    async download(key) {
      const res = await fetchImpl(client.presign(key, { method: "GET", expiresIn: PRESIGN_OP_SECONDS }));
      if (!res.ok || !res.body) throw await failure(res);
      return res.body as ReadableStream<Uint8Array>;
    },

    delete: del,

    presignGet(key, expiresInSeconds, downloadName) {
      const safeName = downloadName.replace(/["\\\r\n]/g, "_");
      return client.presign(key, {
        method: "GET",
        expiresIn: expiresInSeconds,
        contentDisposition: `attachment; filename="${safeName}"`,
      });
    },

    async probe(prefix) {
      const key = `${normalizePrefix(prefix)}/.slipgate-write-test-${crypto.randomUUID()}`;
      await put(key, "slipgate backup connection test", "text/plain");
      await del(key);
    },
  };
}
