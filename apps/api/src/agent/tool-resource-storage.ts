import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { Readable } from "node:stream";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { AppError } from "../errors/app-error.js";
import {
  getAgentObservability,
  toObservationErrorCode,
  type AgentObservability
} from "../observability/agent-observability.js";
import { getS3Bucket, getS3Client, getS3ObjectUrl } from "../storage/s3-client.js";

export type ToolResourceType = "image" | "video" | "document";

export interface StoreRemoteToolResourceInput {
  url: string;
  type: ToolResourceType;
  mime?: string;
}

export interface StoreGeneratedToolResourceInput {
  bytes: Buffer | Uint8Array | ArrayBuffer | string;
  type: ToolResourceType;
  mime?: string;
  fileName?: string;
}

export interface StoreGeneratedToolResourceStreamInput {
  stream: Readable;
  size: number;
  type: ToolResourceType;
  mime?: string;
  fileName?: string;
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
  storeGeneratedResource?(input: StoreGeneratedToolResourceInput): Promise<StoredToolResource>;
  storeGeneratedResourceStream?(input: StoreGeneratedToolResourceStreamInput): Promise<StoredToolResource>;
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

  async storeGeneratedResource(input: StoreGeneratedToolResourceInput): Promise<StoredToolResource> {
    const buffer = toBuffer(input.bytes);
    const mime = normalizeMime(input.mime) ?? getDefaultMime(input.type);
    const name = normalizeGeneratedFileName(input.fileName, getExtension(mime));

    return {
      url: `data:${mime};base64,${buffer.toString("base64")}`,
      mime,
      name,
      size: buffer.length,
      relativePath: ""
    };
  }

  async storeGeneratedResourceStream(input: StoreGeneratedToolResourceStreamInput): Promise<StoredToolResource> {
    const buffer = await readReadableStream(input.stream);
    return this.storeGeneratedResource({
      bytes: buffer,
      type: input.type,
      mime: input.mime,
      fileName: input.fileName
    });
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
  "video/quicktime": ".mov",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/markdown": ".md",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx"
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
        const s3Key = this.buildResourceKey(input.type, fileName);

        await this.putBuffer(s3Key, buffer, mime);

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

  async storeGeneratedResource(input: StoreGeneratedToolResourceInput): Promise<StoredToolResource> {
    const startedAt = Date.now();
    const mime = normalizeMime(input.mime) ?? getDefaultMime(input.type);
    let bytes: number | undefined;

    return tracer.startActiveSpan(`resource.store.${input.type}`, async (span) => {
      span.setAttributes({
        "resource.type": input.type,
        "resource.mime": mime
      });

      try {
        const buffer = toBuffer(input.bytes);
        bytes = buffer.length;

        if (bytes > this.maxBytes) {
          throw new AppError("VALIDATION_ERROR", `工具资源超过最大转储限制 ${this.maxBytes} 字节`, 413);
        }

        const extension = getExtension(mime, undefined, input.fileName);
        const contentHash = createHash("md5").update(buffer).digest("hex");
        const objectName = `${contentHash}${extension}`;
        const s3Key = this.buildResourceKey(input.type, objectName);
        const name = normalizeGeneratedFileName(input.fileName, extension);

        await this.putBuffer(s3Key, buffer, mime, name);

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
          name,
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

  async storeGeneratedResourceStream(input: StoreGeneratedToolResourceStreamInput): Promise<StoredToolResource> {
    const startedAt = Date.now();
    const mime = normalizeMime(input.mime) ?? getDefaultMime(input.type);
    let bytes: number | undefined = input.size;

    return tracer.startActiveSpan(`resource.store.${input.type}`, async (span) => {
      span.setAttributes({
        "resource.type": input.type,
        "resource.mime": mime
      });

      try {
        if (input.size > this.maxBytes) {
          throw new AppError("VALIDATION_ERROR", `工具资源超过最大转储限制 ${this.maxBytes} 字节`, 413);
        }

        const extension = getExtension(mime, undefined, input.fileName);
        const objectName = `${randomUUID()}${extension}`;
        const s3Key = this.buildResourceKey(input.type, objectName);
        const name = normalizeGeneratedFileName(input.fileName, extension);

        await this.putStream(s3Key, input.stream, mime, input.size, name);

        this.observability.recordResourceTransfer({
          resourceType: input.type,
          mime,
          status: "succeeded",
          durationMs: this.durationSince(startedAt),
          bytes
        });
        span.setAttributes({
          "resource.bytes": input.size,
          "resource.duration_ms": this.durationSince(startedAt)
        });

        return {
          url: this.getS3ObjectUrl(s3Key),
          mime,
          name,
          size: input.size,
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

  private buildResourceKey(type: ToolResourceType, fileName: string) {
    return `resources/${type}s/${fileName}`;
  }

  private async putBuffer(s3Key: string, buffer: Buffer, mime: string, fileName?: string) {
    // S3 putObject 对相同 key 是幂等覆盖，不需要本地文件系统的 "wx" 去重逻辑。
    await this.getS3Client().send(
      new PutObjectCommand({
        Bucket: this.getS3Bucket(),
        Key: s3Key,
        Body: buffer,
        ContentType: mime,
        ContentDisposition: fileName ? buildContentDisposition(fileName) : undefined
      })
    );
  }

  private async putStream(s3Key: string, stream: Readable, mime: string, size: number, fileName?: string) {
    await this.getS3Client().send(
      new PutObjectCommand({
        Bucket: this.getS3Bucket(),
        Key: s3Key,
        Body: stream,
        ContentType: mime,
        ContentLength: size,
        ContentDisposition: fileName ? buildContentDisposition(fileName) : undefined
      })
    );
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
  if (type === "video") {
    return "video/mp4";
  }

  if (type === "document") {
    return "application/octet-stream";
  }

  return "image/png";
}

function getExtension(mime: string, url?: URL, fileName?: string): string {
  const extensionFromMime = mimeExtensions[mime];

  if (extensionFromMime) {
    return extensionFromMime;
  }

  const extensionFromName = fileName ? extname(fileName) : "";

  if (extensionFromName) {
    return extensionFromName;
  }

  const extensionFromUrl = url ? extname(url.pathname) : "";

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

function toBuffer(bytes: StoreGeneratedToolResourceInput["bytes"]): Buffer {
  if (typeof bytes === "string") {
    return Buffer.from(bytes, "utf8");
  }

  if (bytes instanceof ArrayBuffer) {
    return Buffer.from(bytes);
  }

  return Buffer.from(bytes);
}

async function readReadableStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function normalizeGeneratedFileName(fileName: string | undefined, extension: string): string {
  const fallback = `generated-document${extension}`;
  const rawName = fileName?.trim() || fallback;
  const pathlessName = rawName.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? fallback;
  const withoutUnsafeCharacters = pathlessName.replace(/[:*?"<>|]/g, "-").trim();
  const name = withoutUnsafeCharacters || fallback;
  const currentExtension = extname(name);
  const stem = currentExtension ? name.slice(0, -currentExtension.length) : name;

  return `${stem || "generated-document"}${extension}`;
}

function buildContentDisposition(fileName: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
