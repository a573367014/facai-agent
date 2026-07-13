/**
 * S3 兼容对象存储客户端。
 *
 * 职责：初始化并缓存一个 S3Client 实例（兼容 MinIO / Cloudflare R2 / AWS S3），
 * 提供 bucket 存在性保证、对象 URL 拼接、以及客户端单例获取。
 * 边界：只管「连接 + bucket 准备 + URL 拼接」，不管上传/下载的具体业务逻辑、
 * 不管生命周期策略、不管权限细分。上传由 attachment-upload + 调用方组合完成。
 * 为什么用单例缓存：S3Client 内部维护 HTTP 连接池，重复 new 会导致连接泄漏，
 * 且每次 new 都要重新 TLS 握手，延迟显著增加。
 */
import { S3Client, HeadBucketCommand, CreateBucketCommand, PutBucketPolicyCommand } from "@aws-sdk/client-s3";

/**
 * S3 存储初始化配置。
 *
 * publicBaseUrl 可选：生产环境（R2）通常通过自定义域名公开访问，此时对象 URL
 * 应使用该域名而非 endpoint；不配则回退到 endpoint，适用于 MinIO 本地开发。
 */
export interface S3StorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
}

// 每个进程只建一个 S3Client，内部会复用 TCP 连接。
let cachedClient: S3Client | null = null;
let cachedBucket: string | null = null;
let cachedEndpoint: string | null = null;
let cachedPublicBaseUrl: string | null = null;

/**
 * 获取已初始化的 S3Client 单例。
 *
 * 未初始化时抛错而非返回 null：让调用方在启动阶段就暴露初始化遗漏，
 * 避免运行时静默拿到 null 后在深层业务里触发难以追踪的空指针。
 */
export function getS3Client(): S3Client {
  if (!cachedClient) {
    throw new Error("S3 客户端未初始化，请先调用 initS3Storage");
  }

  return cachedClient;
}

/**
 * 获取已初始化的 bucket 名称。
 *
 * bucket 名在 initS3Storage 时确定，后续上传/拼接 URL 都需要它。
 * 同样在未初始化时抛错，原因同 getS3Client。
 */
export function getS3Bucket(): string {
  if (!cachedBucket) {
    throw new Error("S3 客户端未初始化，请先调用 initS3Storage");
  }

  return cachedBucket;
}

// 拼接图片访问 URL。
// MinIO 用 path-style：{endpoint}/{bucket}/{key}
// R2/S3 用 virtual-host-style 也支持 path-style，所以统一用 path-style 最简单。
export function getS3ObjectUrl(key: string): string {
  const base = (cachedPublicBaseUrl ?? cachedEndpoint ?? "").replace(/\/$/, "");
  const bucket = getS3Bucket();

  return `${base}/${bucket}/${key}`;
}

// 初始化 S3 客户端并确保 bucket 存在。
// 进程启动时调一次即可。MinIO 启动时 bucket 不存在会自动创建；
// R2/S3 需要提前在控制台建好 bucket，这里只做存在性检查。
export async function initS3Storage(options: S3StorageOptions): Promise<void> {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey
    },
    // MinIO 必须用 path-style（bucket 名放路径里而不是子域名）。
    // R2 也兼容 path-style，所以开发生产统一用这个。
    forcePathStyle: true
  });

  // 检查 bucket 是否存在，不存在则创建（MinIO 场景）。
  try {
    await client.send(new HeadBucketCommand({ Bucket: options.bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: options.bucket }));
  }

  // 设置 bucket 公开读策略（允许匿名 GET）。
  // 新建 bucket 时必须设；已存在的也幂等设置一次，确保可访问。
  // R2 的公开访问通常通过绑定的自定义域名控制，这条策略在 R2 上是 no-op。
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: ["*"] },
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${options.bucket}/*`]
      }
    ]
  });
  try {
    await client.send(new PutBucketPolicyCommand({ Bucket: options.bucket, Policy: policy }));
  } catch {
    // R2/S3 可能不支持 PutBucketPolicy，忽略错误——生产环境通过自定义域名公开访问。
  }

  cachedClient = client;
  cachedBucket = options.bucket;
  cachedEndpoint = options.endpoint.replace(/\/$/, "");
  cachedPublicBaseUrl = options.publicBaseUrl?.replace(/\/$/, "") ?? null;
}
