import { createHash } from "node:crypto";
import { extname } from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { AppError } from "../errors/app-error.js";
import {
  getAgentObservability,
  toObservationErrorCode,
  type AgentObservability
} from "../observability/agent-observability.js";
import { getS3Bucket, getS3Client, getS3ObjectUrl } from "../storage/s3-client.js";

export type ToolResourceType = "image" | "video";

export interface StoreRemoteToolResourceInput {
  url: string;
  type: ToolResourceType;
  mime?: string;
}

export interface StoredToolResource {
  url: string;
  mime?: string;
  name: string;
  size: number;
  relativePath: string;
}

export interface ToolResourceStorage {
  storeRemoteResource(input: StoreRemoteToolResourceInput): Promise<StoredToolResource>;
}

export class PassthroughToolResourceStorage implements ToolResourceStorage {
  async storeRemoteResource(input: StoreRemoteToolResourceInput): Promise<StoredToolResource> {
    return {
      url: input.url,
      mime: input.mime,
      name: getFileNameFromUrl(input.url) ?? "remote-resource",
      size: 0,
      relativePath: ""
    };
  }
}

interface S3ToolResourceStorageOptions {
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  observability?: AgentObservability;
  s3Client?: { send(command: PutObjectCommand): Promise<unknown> };
  bucket?: string;
  objectUrlFactory?: (key: string) => string;
}

const defaultMaxBytes = 200 * 1024 * 1024;
const defaultTimeoutMs = 60_000;
const tracer = trace.getTracer("tool-resource-storage");

const mimeExtensions: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov"
};

export class S3ToolResourceStorage implements ToolResourceStorage {
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly observability: AgentObservability;

  constructor(private readonly options: S3ToolResourceStorageOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxBytes = options.maxBytes ?? defaultMaxBytes;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.observability = options.observability ?? getAgentObservability();
  }

  async storeRemoteResource(input: StoreRemoteToolResourceInput): Promise<StoredToolResource> {
    const startedAt = Date.now();
    let mime = normalizeMime(input.mime) ?? getDefaultMime(input.type);
    let bytes: number | undefined;

    return tracer.startActiveSpan(`resource.store.${input.type}`, async (span) => {
      span.setAttributes({
        "resource.type": input.type,
        "resource.mime": mime
      });

      try {
        const parsedUrl = this.parseHttpUrl(input.url);
        const response = await this.fetchImpl(parsedUrl, {
          signal: AbortSignal.timeout(this.timeoutMs)
        });

        if (!response.ok) {
          throw new AppError(
            "TOOL_EXECUTION_ERROR",
            `工具资源转储失败，下载远端资源返回 HTTP ${response.status}`,
            502
          );
        }

        mime = normalizeMime(input.mime) ?? normalizeMime(response.headers.get("content-type")) ?? getDefaultMime(input.type);
        span.setAttribute("resource.mime", mime);
        const contentLength = Number(response.headers.get("content-length"));

        if (Number.isFinite(contentLength) && contentLength > this.maxBytes) {
          throw new AppError("VALIDATION_ERROR", `工具资源超过最大转储限制 ${this.maxBytes} 字节`, 413);
        }

        const buffer = await readResponseBody(response, this.maxBytes);
        bytes = buffer.length;
        const extension = getExtension(mime, parsedUrl);
        const contentHash = createHash("md5").update(buffer).digest("hex");
        const fileName = `${contentHash}${extension}`;
        const s3Key = `resources/${input.type}s/${fileName}`;

        // S3 putObject 对相同 key 是幂等覆盖，不需要本地文件系统的 "wx" 去重逻辑。
        await this.getS3Client().send(
          new PutObjectCommand({
            Bucket: this.getS3Bucket(),
            Key: s3Key,
            Body: buffer,
            ContentType: mime
          })
        );

        this.observability.recordResourceTransfer({
          resourceType: input.type,
          mime,
          status: "succeeded",
          durationMs: this.durationSince(startedAt),
          bytes
        });
        span.setAttributes({
          "resource.bytes": bytes,
          "resource.duration_ms": this.durationSince(startedAt)
        });

        return {
          url: this.getS3ObjectUrl(s3Key),
          mime,
          name: fileName,
          size: buffer.length,
          relativePath: s3Key
        };
      } catch (error) {
        const errorCode = toObservationErrorCode(error, "TOOL_EXECUTION_ERROR");
        this.observability.recordResourceTransfer({
          resourceType: input.type,
          mime,
          status: "failed",
          durationMs: this.durationSince(startedAt),
          bytes,
          errorCode
        });
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : errorCode });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private parseHttpUrl(url: string): URL {
    let parsedUrl: URL;

    try {
      parsedUrl = new URL(url);
    } catch {
      throw new AppError("VALIDATION_ERROR", "工具资源 URL 格式不正确，无法转储", 400);
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new AppError("VALIDATION_ERROR", "工具资源只支持 http 或 https 地址转储", 400);
    }

    return parsedUrl;
  }

  private getS3Client() {
    return this.options.s3Client ?? getS3Client();
  }

  private getS3Bucket() {
    return this.options.bucket ?? getS3Bucket();
  }

  private getS3ObjectUrl(key: string) {
    return this.options.objectUrlFactory?.(key) ?? getS3ObjectUrl(key);
  }

  private durationSince(startedAt: number) {
    return Math.max(0, Date.now() - startedAt);
  }
}

async function readResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    return Buffer.from(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    const chunk = Buffer.from(value);
    totalBytes += chunk.length;

    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new AppError("VALIDATION_ERROR", `工具资源超过最大转储限制 ${maxBytes} 字节`, 413);
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function normalizeMime(value?: string | null): string | undefined {
  return value?.split(";")[0]?.trim().toLowerCase() || undefined;
}

function getDefaultMime(type: ToolResourceType): string {
  return type === "video" ? "video/mp4" : "image/png";
}

function getExtension(mime: string, url: URL): string {
  const extensionFromMime = mimeExtensions[mime];

  if (extensionFromMime) {
    return extensionFromMime;
  }

  const extensionFromUrl = extname(url.pathname);

  return extensionFromUrl || ".bin";
}

function getFileNameFromUrl(url: string): string | undefined {
  try {
    const parsedUrl = new URL(url);
    const fileName = parsedUrl.pathname.split("/").filter(Boolean).at(-1);
    return fileName || undefined;
  } catch {
    return undefined;
  }
}

