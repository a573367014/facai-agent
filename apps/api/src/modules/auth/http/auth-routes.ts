/**
 * 认证 HTTP 路由 —— 对外暴露的认证 API 端点。
 *
 * 【职责边界】
 * 本文件是认证模块的"HTTP 适配层"（Controller 层），负责：
 * 1. 接收 HTTP 请求，用 Zod 校验入参格式
 * 2. 调用 AuthService / AuthTokenService 完成业务
 * 3. 将结果序列化为 HTTP 响应返回给客户端
 *
 * 它不包含业务规则——所有"做什么"的逻辑都在 AuthService 和 TokenService 中，
 * 路由层只负责"怎么传"。这是 Controller 层的标准职责划分。
 *
 * 【暴露的三个端点】
 * - POST /auth/github/login：用 GitHub 授权码完成登录，返回 user + token 对
 * - POST /auth/refresh：用 refresh token 换取新的 access token 对
 * - GET  /auth/me：用 access token 获取当前登录用户信息
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthService } from "../auth-service.js";
import type { AuthJwtClaims, AuthTokenService } from "../auth-token-service.js";
import type { GithubOAuthClient } from "../github-oauth-client.js";
import type { UserRecord, UserStore } from "../user-store.js";
import { AppError } from "../../../shared/errors/app-error.js";

/** GitHub 登录入参校验：code 必填非空，redirectUri 可选但必须是合法 URL */
const githubLoginSchema = z.object({
  code: z.string().trim().min(1),
  redirectUri: z.string().url().optional()
});

/** 刷新 token 入参校验：refreshToken 必填非空 */
const refreshSchema = z.object({
  refreshToken: z.string().trim().min(1)
});

export interface RegisterAuthRoutesOptions {
  userStore: UserStore;
  githubClient: GithubOAuthClient;
  tokenService: AuthTokenService;
}

/**
 * 注册全部认证路由。
 * 内部创建 AuthService 实例，把三个依赖注入进去。
 */
export async function registerAuthRoutes(app: FastifyInstance, options: RegisterAuthRoutesOptions): Promise<void> {
  const authService = new AuthService(options);

  /**
   * GitHub 登录端点。
   * 前端拿到 GitHub 授权码后 POST 到这里，完成"换资料 → 建用户 → 发 token"全流程。
   * 返回给前端的字段经过 toPublicUser 过滤，去掉了内部时间戳等敏感字段。
   */
  app.post("/auth/github/login", async (request) => {
    const input = parseGithubLoginRequest(request.body);
    const result = await authService.loginWithGithubCode(input);

    return {
      user: toPublicUser(result.user),
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      refreshTokenExpiresIn: result.refreshTokenExpiresIn
    };
  });

  /**
   * Token 刷新端点。
   * 当 access token 过期时，前端用 refresh token 来这里换一对全新的 token。
   *
   * 【为什么刷新也要返回新的 refresh token】
   * issueTokenPairFromClaims 会同时签发新的 access + refresh token，
   * 实现"滑动过期"——只要用户持续使用，refresh token 也会不断续期，
   * 避免活跃用户被频繁踢出登录。
   */
  app.post("/auth/refresh", async (request) => {
    const input = parseRefreshRequest(request.body);
    const claims = options.tokenService.verifyRefreshToken(input.refreshToken);
    const tokenPair = options.tokenService.issueTokenPairFromClaims(claims);

    return tokenPair;
  });

  /**
   * 获取当前用户信息端点。
   * 需要 access token 鉴权，从 token claims 中提取用户身份。
   *
   * 【为什么从 claims 取而非查库】
   * claims 是已验证的可信数据，包含基本身份信息（id、githubId、login），
   * 无需额外查库即可返回，减少数据库压力。
   * 如果需要更完整的用户资料（如头像），则应走另一条路径查 UserStore。
   */
  app.get("/auth/me", async (request) => {
    const claims = verifyBearerAccessToken(request, options.tokenService);

    return {
      user: toUserFromClaims(claims)
    };
  });
}

/**
 * 从请求头提取并验证 Bearer access token。
 * 此函数被 auth-guard 和 /auth/me 共享复用，保证鉴权逻辑一致。
 * 返回验证通过的 claims，或抛出 401 错误。
 */
export function verifyBearerAccessToken(request: FastifyRequest, tokenService: AuthTokenService): AuthJwtClaims {
  const token = getBearerToken(request.headers.authorization);

  if (!token) {
    throw new AppError("AUTHENTICATION_ERROR", "缺少 Authorization Bearer token", 401);
  }

  return tokenService.verifyAccessToken(token);
}

/** 解析并校验 GitHub 登录请求体，校验失败抛 400 参数错误 */
function parseGithubLoginRequest(body: unknown) {
  const parsed = githubLoginSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "code 必须是非空字符串，redirectUri 必须是合法 URL", 400);
  }

  return parsed.data;
}

/** 解析并校验刷新 token 请求体，校验失败抛 400 参数错误 */
function parseRefreshRequest(body: unknown) {
  const parsed = refreshSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "refreshToken 必须是非空字符串", 400);
  }

  return parsed.data;
}

/**
 * 从 Authorization 头中提取 Bearer token。
 * 标准格式为 "Bearer <token>"，scheme 不区分大小写以兼容不同客户端。
 * 格式不符时返回 undefined（由调用方决定是否抛 401）。
 */
function getBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) {
    return undefined;
  }

  const [scheme, token] = authorizationHeader.split(" ");

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return undefined;
  }

  return token;
}

/**
 * 将内部 UserRecord 转换为对外暴露的用户对象。
 * 过滤掉 createdAt/updatedAt/lastLoginAt 等内部运维字段，
 * 只返回前端需要的公开信息，避免敏感数据泄露。
 */
function toPublicUser(user: UserRecord) {
  return {
    id: user.id,
    githubId: user.githubId,
    githubLogin: user.githubLogin,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
    githubUrl: user.githubUrl
  };
}

/**
 * 从 JWT claims 构造精简版用户对象（仅含身份三要素）。
 * 用于 /auth/me 等不需要完整资料的轻量场景。
 */
function toUserFromClaims(claims: AuthJwtClaims) {
  return {
    id: claims.sub,
    githubId: claims.githubId,
    githubLogin: claims.githubLogin
  };
}
