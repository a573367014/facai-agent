/**
 * JWT Token 服务 —— 签发与验证 access/refresh 双 token。
 *
 * 【职责边界】
 * 本文件是认证体系的"钥匙管理者"，负责：
 * 1. 签发 token 对（access + refresh），供登录成功后返回给客户端
 * 2. 验证传入的 token，提取可信的用户身份声明（claims）
 *
 * 【为什么手写 JWT 而不用 jsonwebtoken 库】
 * 本项目自行实现了 HS256 的签名/验证，只依赖 Node 内置 crypto 模块。
 * 这样做减少了外部依赖与攻击面，逻辑完全可控、可审计。
 * JWT 本质很简单：header.payload.signature，三段用 base64url 编码，
 * 签名是 HMAC-SHA256(header.payload, secret)。
 *
 * 【双 token 设计原理】
 * - access token：短生命周期（如 15 分钟），每次 API 请求携带，泄露风险可控
 * - refresh token：长生命周期（如 7 天），仅用于换取新的 access token，不频繁传输
 * 两者用不同的 secret 签名，互不通用——即使 access secret 泄露，
 * 攻击者也无法伪造 refresh token 获取持久访问权。
 *
 * 通俗比喻：access token 是临时门禁卡（很快过期），refresh token 是
 * 补办门禁卡的身份证（不常用但长期有效），两者分开存放降低风险。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../../shared/errors/app-error.js";

/** token 服务的配置项。access 和 refresh 各有独立的 secret 和 TTL，物理隔离。 */
export interface AuthTokenServiceOptions {
  accessSecret: string;
  refreshSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

/** 签发 token 对的入参——携带要编码进 JWT claims 的用户身份信息 */
export interface IssueTokenPairInput {
  userId: string;
  githubId: string;
  githubLogin: string;
}

/**
 * JWT 的自定义 claims 结构。
 * - sub：subject，即用户内部 id，验证后直接作为当前用户标识
 * - typ：token 类型标记，防止 access token 被当作 refresh token 使用（或反之）
 */
export interface AuthJwtClaims {
  sub: string;
  typ: "access" | "refresh";
  githubId: string;
  githubLogin: string;
  /** issued at，签发时间（Unix 秒） */
  iat: number;
  /** expiration time，过期时间（Unix 秒） */
  exp: number;
}

/** 返回给客户端的 token 对，同时附带过期秒数方便前端设置定时刷新 */
export interface AuthTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshTokenExpiresIn: number;
}

export class AuthTokenService {
  constructor(private readonly options: AuthTokenServiceOptions) {}

  /**
   * 签发一组全新的 access + refresh token。
   * 两个 token 共享同一个签发时间（iat），但过期时间（exp）各自由各自 TTL 决定。
   */
  issueTokenPair(input: IssueTokenPairInput): AuthTokenPair {
    const issuedAt = currentUnixTimestamp();
    const accessClaims = this.createClaims(input, "access", issuedAt, this.options.accessTokenTtlSeconds);
    const refreshClaims = this.createClaims(input, "refresh", issuedAt, this.options.refreshTokenTtlSeconds);

    return {
      accessToken: signJwt(accessClaims, this.options.accessSecret),
      refreshToken: signJwt(refreshClaims, this.options.refreshSecret),
      expiresIn: this.options.accessTokenTtlSeconds,
      refreshTokenExpiresIn: this.options.refreshTokenTtlSeconds
    };
  }

  /**
   * 基于已有的 refresh token claims 重新签发一对 token（刷新场景）。
   * 不需要重新查库，因为 claims 中已经携带了足够的身份信息。
   */
  issueTokenPairFromClaims(claims: AuthJwtClaims): AuthTokenPair {
    return this.issueTokenPair({
      userId: claims.sub,
      githubId: claims.githubId,
      githubLogin: claims.githubLogin
    });
  }

  /** 验证 access token，用 access secret；失败一律抛 401 认证错误 */
  verifyAccessToken(token: string): AuthJwtClaims {
    return this.verifyToken(token, "access", this.options.accessSecret, "无效或已过期的 accessToken");
  }

  /** 验证 refresh token，用 refresh secret；失败一律抛 401 认证错误 */
  verifyRefreshToken(token: string): AuthJwtClaims {
    return this.verifyToken(token, "refresh", this.options.refreshSecret, "无效或已过期的 refreshToken");
  }

  private createClaims(
    input: IssueTokenPairInput,
    tokenType: AuthJwtClaims["typ"],
    issuedAt: number,
    ttlSeconds: number
  ): AuthJwtClaims {
    return {
      sub: input.userId,
      typ: tokenType,
      githubId: input.githubId,
      githubLogin: input.githubLogin,
      iat: issuedAt,
      exp: issuedAt + ttlSeconds
    };
  }

  /**
   * 统一的 token 验证入口。
   *
   * 【为什么不把验证细节暴露给调用方】
   * 验证涉及签名比对、类型校验、过期判断三步，任何一步失败都必须拒绝。
   * 集中在此处理可以保证安全策略一致，避免各处自行实现时遗漏某一步。
   * 所有异常被统一转换为 AppError(401)，防止内部错误信息泄露给客户端。
   */
  private verifyToken(
    token: string,
    expectedType: AuthJwtClaims["typ"],
    secret: string,
    errorMessage: string
  ): AuthJwtClaims {
    try {
      const claims = verifyJwt(token, secret);

      // 双重校验：token 类型必须匹配（防 access/refresh 混用）且未过期
      if (claims.typ !== expectedType || claims.exp <= currentUnixTimestamp()) {
        throw new Error("invalid token claims");
      }

      return claims;
    } catch {
      throw new AppError("AUTHENTICATION_ERROR", errorMessage, 401);
    }
  }
}

/**
 * 手写 JWT 签名：header.payload.signature
 * header 固定声明 HS256 算法，payload 就是 claims 的 JSON。
 */
function signJwt(claims: AuthJwtClaims, secret: string): string {
  const header = encodeBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = encodeBase64Url(JSON.stringify(claims));
  const signature = createSignature(`${header}.${payload}`, secret);

  return `${header}.${payload}.${signature}`;
}

/**
 * 手写 JWT 验证：拆解三段 → 重算签名 → 常量时间比对 → 校验 header → 解析 claims。
 *
 * 【验证顺序的安全考量】
 * 必须先验签名再解析内容。如果反过来先 parse payload 再验签，
 * 攻击者可以构造畸形 JSON 触发解析异常来探测系统行为（信息泄露）。
 * 这里严格遵循"先验签、后取信"的原则。
 */
function verifyJwt(token: string, secret: string): AuthJwtClaims {
  const parts = token.split(".");

  if (parts.length !== 3) {
    throw new Error("invalid jwt format");
  }

  const [header, payload, signature] = parts;
  const expectedSignature = createSignature(`${header}.${payload}`, secret);

  if (!safeEqual(signature, expectedSignature)) {
    throw new Error("invalid jwt signature");
  }

  const decodedHeader = JSON.parse(decodeBase64Url(header)) as { alg?: string; typ?: string };

  // 拒绝非 HS256 的算法头，防御"alg 混淆攻击"（如攻击者把 alg 改成 none）
  if (decodedHeader.alg !== "HS256" || decodedHeader.typ !== "JWT") {
    throw new Error("unsupported jwt header");
  }

  const claims = JSON.parse(decodeBase64Url(payload)) as Partial<AuthJwtClaims>;

  // 逐字段做类型守卫，防止 claims 缺字段或类型错误导致后续逻辑出错
  if (
    typeof claims.sub !== "string" ||
    (claims.typ !== "access" && claims.typ !== "refresh") ||
    typeof claims.githubId !== "string" ||
    typeof claims.githubLogin !== "string" ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number"
  ) {
    throw new Error("invalid jwt claims");
  }

  return claims as AuthJwtClaims;
}

/** HMAC-SHA256 签名，输出 base64url 编码（JWT 规范要求 URL 安全编码） */
function createSignature(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

/**
 * 常量时间字符串比较。
 *
 * 【为什么不能直接用 ===】
 * 普通 === 比较会在第一个不匹配字节处短路返回，耗时与匹配程度相关。
 * 攻击者可以通过反复测量响应时间来逐字节爆破签名（timing attack）。
 * timingSafeEqual 保证无论比较结果如何，耗时恒定，从根本上消除时序侧信道。
 */
function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

/** 当前 Unix 时间戳（秒）。JWT 规范中 iat/exp 使用秒级整数 */
function currentUnixTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}
