import type { FastifyInstance } from "fastify";
import type { FastifyRequest } from "fastify";
import type { AuthJwtClaims, AuthTokenService } from "./auth-token-service.js";
import { verifyBearerAccessToken } from "../routes/auth-routes.js";

export interface AuthGuardOptions {
  tokenService: AuthTokenService;
}

export function registerAuthGuard(app: FastifyInstance, options: AuthGuardOptions): void {
  app.addHook("onRequest", async (request) => {
    if (!requiresAuth(request.method, request.url)) {
      return;
    }

    setAuthenticatedUser(request, verifyBearerAccessToken(request, options.tokenService));
  });
}

export function getAuthenticatedUser(request: FastifyRequest): AuthJwtClaims | undefined {
  return (request as FastifyRequest & { auth?: AuthJwtClaims }).auth;
}

function setAuthenticatedUser(request: FastifyRequest, claims: AuthJwtClaims): void {
  (request as FastifyRequest & { auth?: AuthJwtClaims }).auth = claims;
}

function requiresAuth(method: string, rawUrl: string): boolean {
  if (method.toUpperCase() === "OPTIONS") {
    return false;
  }

  const pathname = rawUrl.split("?")[0] || "/";
  return pathname === "/agents" || pathname.startsWith("/agents/") || pathname === "/knowledge" || pathname.startsWith("/knowledge/");
}
