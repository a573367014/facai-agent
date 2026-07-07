import { S3Client, HeadBucketCommand, CreateBucketCommand, PutBucketPolicyCommand } from "@aws-sdk/client-s3";

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

export function getS3Client(): S3Client {
  if (!cachedClient) {
    throw new Error("S3 客户端未初始化，请先调用 initS3Storage");
  }

  return cachedClient;
}

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
