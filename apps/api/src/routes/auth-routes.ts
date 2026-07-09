import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthService } from "../auth/auth-service.js";
import type { AuthJwtClaims, AuthTokenService } from "../auth/auth-token-service.js";
import type { GithubOAuthClient } from "../auth/github-oauth-client.js";
import type { UserRecord, UserStore } from "../auth/user-store.js";
import { AppError } from "../errors/app-error.js";

const githubLoginSchema = z.object({
  code: z.string().trim().min(1),
  redirectUri: z.string().url().optional()
});
const refreshSchema = z.object({
  refreshToken: z.string().trim().min(1)
});

export interface RegisterAuthRoutesOptions {
  userStore: UserStore;
  githubClient: GithubOAuthClient;
  tokenService: AuthTokenService;
}

export async function registerAuthRoutes(app: FastifyInstance, options: RegisterAuthRoutesOptions): Promise<void> {
  const authService = new AuthService(options);

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

  app.post("/auth/refresh", async (request) => {
    const input = parseRefreshRequest(request.body);
    const claims = options.tokenService.verifyRefreshToken(input.refreshToken);
    const tokenPair = options.tokenService.issueTokenPairFromClaims(claims);

    return tokenPair;
  });

  app.get("/auth/me", async (request) => {
    const claims = verifyBearerAccessToken(request, options.tokenService);

    return {
      user: toUserFromClaims(claims)
    };
  });
}

export function verifyBearerAccessToken(request: FastifyRequest, tokenService: AuthTokenService): AuthJwtClaims {
  const token = getBearerToken(request.headers.authorization);

  if (!token) {
    throw new AppError("AUTHENTICATION_ERROR", "缺少 Authorization Bearer token", 401);
  }

  return tokenService.verifyAccessToken(token);
}

function parseGithubLoginRequest(body: unknown) {
  const parsed = githubLoginSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "code 必须是非空字符串，redirectUri 必须是合法 URL", 400);
  }

  return parsed.data;
}

function parseRefreshRequest(body: unknown) {
  const parsed = refreshSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "refreshToken 必须是非空字符串", 400);
  }

  return parsed.data;
}

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

function toUserFromClaims(claims: AuthJwtClaims) {
  return {
    id: claims.sub,
    githubId: claims.githubId,
    githubLogin: claims.githubLogin
  };
}
