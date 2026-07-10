/**
 * 认证守卫 —— 在 Fastify 请求生命周期最前端拦截鉴权。
 *
 * 【职责边界】
 * 注册一个全局 onRequest 钩子，对需要认证的路由自动校验 Bearer token，
 * 校验通过后把用户身份挂到 request 上，供后续 handler 取用。
 * 不负责"签发 token"，只负责"验票放行"。
 *
 * 【为什么用 onRequest 钩子而非每个路由单独校验】
 * Fastify 的钩子执行在路由解析之前。把鉴权放在 onRequest 阶段意味着：
 * 1. 所有受保护路由自动获得鉴权能力，零重复代码
 * 2. 无效请求在进入 handler 前就被拒绝，节省后续处理开销
 * 3. 鉴权逻辑集中一处，安全策略修改不会遗漏某个路由
 *
 * 通俗比喻：auth-guard 是大楼入口的保安，刷卡（token）才能进，
 * 非开放区域（/agents、/knowledge）人人必检，公共区域（/auth/*）直接放行。
 */
import type { FastifyInstance } from "fastify";
import type { FastifyRequest } from "fastify";
import type { AuthJwtClaims, AuthTokenService } from "./auth-token-service.js";
import { verifyBearerAccessToken } from "./http/auth-routes.js";

export interface AuthGuardOptions {
  tokenService: AuthTokenService;
}

/**
 * 注册认证守卫钩子。
 *
 * 【执行时机】onRequest 是 Fastify 生命周期最早的钩子，在 body 解析、
 * schema 校验之前执行。此处校验失败会直接中断请求，抛出的 401 错误
 * 会被 Fastify 错误处理器捕获并返回给客户端。
 */
export function registerAuthGuard(app: FastifyInstance, options: AuthGuardOptions): void {
  app.addHook("onRequest", async (request) => {
    if (!requiresAuth(request.method, request.url)) {
      return;
    }

    setAuthenticatedUser(request, verifyBearerAccessToken(request, options.tokenService));
  });
}

/**
 * 从 request 上取出已认证的用户身份。
 * 返回 undefined 表示该请求未经过认证（可能是公开路由，也可能是守卫未注册）。
 */
export function getAuthenticatedUser(request: FastifyRequest): AuthJwtClaims | undefined {
  return (request as FastifyRequest & { auth?: AuthJwtClaims }).auth;
}

/**
 * 将认证后的 claims 挂到 request 上。
 * 通过类型断言扩展 FastifyRequest，因为 auth 是自定义字段，
 * 不在 Fastify 原生 Request 类型定义中。
 */
function setAuthenticatedUser(request: FastifyRequest, claims: AuthJwtClaims): void {
  (request as FastifyRequest & { auth?: AuthJwtClaims }).auth = claims;
}

/**
 * 判断当前请求是否需要认证。
 *
 * 【白名单策略】
 * - OPTIONS 请求一律放行：这是 CORS 预检请求，浏览器自动发出，不携带认证信息
 * - /auth/* 路径放行：登录、刷新 token 等接口本身就在获取凭证，不能要求先有凭证
 * - /agents 和 /knowledge 受保护：这是核心业务资源，必须验证身份
 *
 * 这种基于路径前缀的白名单方式简单直接，适合路由数量不多的场景。
 */
function requiresAuth(method: string, rawUrl: string): boolean {
  if (method.toUpperCase() === "OPTIONS") {
    return false;
  }

  const pathname = rawUrl.split("?")[0] || "/";
  return pathname === "/agents" || pathname.startsWith("/agents/") || pathname === "/knowledge" || pathname.startsWith("/knowledge/");
}
