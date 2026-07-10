import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { AuthTokenService } from "../../src/auth/auth-token-service.js";
import type { GithubOAuthClient, GithubUserProfile } from "../../src/auth/github-oauth-client.js";
import { InMemoryUserStore } from "../../src/auth/user-store.js";

class FakeGithubOAuthClient implements GithubOAuthClient {
  readonly exchangedCodes: Array<{ code: string; redirectUri?: string }> = [];

  constructor(private readonly profile: GithubUserProfile) {}

  async getUserProfile(input: { code: string; redirectUri?: string }): Promise<GithubUserProfile> {
    this.exchangedCodes.push(input);
    return this.profile;
  }
}

function createTokenService() {
  return new AuthTokenService({
    accessSecret: "access-secret",
    refreshSecret: "refresh-secret",
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 15 * 24 * 60 * 60
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("auth routes", () => {
  it("POST /auth/github/login 使用 GitHub code 登录，upsert 用户并返回 JWT token pair", async () => {
    const tokenService = createTokenService();
    const userStore = new InMemoryUserStore();
    const githubClient = new FakeGithubOAuthClient({
      githubId: "9911",
      githubLogin: "octocat",
      name: "The Octocat",
      email: "octocat@example.com",
      avatarUrl: "https://avatars.githubusercontent.com/u/9911",
      githubUrl: "https://github.com/octocat"
    });
    const app = await buildApp({
      auth: {
        userStore,
        githubClient,
        tokenService
      },
      skipAgentRuntime: true
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/github/login",
      payload: {
        code: "github-code",
        redirectUri: "http://localhost:4000/auth/github/callback"
      }
    });
    const payload = response.json() as {
      user: { id: string; githubLogin: string; email: string };
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      refreshTokenExpiresIn: number;
    };

    expect(response.statusCode).toBe(200);
    expect(githubClient.exchangedCodes).toEqual([
      {
        code: "github-code",
        redirectUri: "http://localhost:4000/auth/github/callback"
      }
    ]);
    expect(payload.user).toMatchObject({
      githubLogin: "octocat",
      email: "octocat@example.com"
    });
    expect(payload.expiresIn).toBe(900);
    expect(payload.refreshTokenExpiresIn).toBe(15 * 24 * 60 * 60);
    expect(tokenService.verifyAccessToken(payload.accessToken)).toMatchObject({
      sub: payload.user.id,
      typ: "access",
      githubId: "9911",
      githubLogin: "octocat"
    });
    expect(tokenService.verifyRefreshToken(payload.refreshToken)).toMatchObject({
      sub: payload.user.id,
      typ: "refresh",
      githubId: "9911",
      githubLogin: "octocat"
    });

    await app.close();
  });

  it("POST /auth/refresh 用 refreshToken 换取新的无状态 token pair", async () => {
    const tokenService = createTokenService();
    const refreshToken = tokenService.issueTokenPair({
      userId: "user_123",
      githubId: "9911",
      githubLogin: "octocat"
    }).refreshToken;
    const app = await buildApp({
      auth: {
        userStore: new InMemoryUserStore(),
        githubClient: new FakeGithubOAuthClient({
          githubId: "9911",
          githubLogin: "octocat"
        }),
        tokenService
      },
      skipAgentRuntime: true
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken }
    });
    const payload = response.json() as { accessToken: string; refreshToken: string; refreshTokenExpiresIn: number };

    expect(response.statusCode).toBe(200);
    expect(payload.refreshTokenExpiresIn).toBe(15 * 24 * 60 * 60);
    expect(tokenService.verifyAccessToken(payload.accessToken)).toMatchObject({
      sub: "user_123",
      typ: "access"
    });
    expect(tokenService.verifyRefreshToken(payload.refreshToken)).toMatchObject({
      sub: "user_123",
      typ: "refresh"
    });

    await app.close();
  });

  it("GET /auth/me 只通过 accessToken 做无状态授权验证", async () => {
    const tokenService = createTokenService();
    const accessToken = tokenService.issueTokenPair({
      userId: "user_123",
      githubId: "9911",
      githubLogin: "octocat"
    }).accessToken;
    const app = await buildApp({
      auth: {
        userStore: new InMemoryUserStore(),
        githubClient: new FakeGithubOAuthClient({
          githubId: "9911",
          githubLogin: "octocat"
        }),
        tokenService
      },
      skipAgentRuntime: true
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: {
        id: "user_123",
        githubId: "9911",
        githubLogin: "octocat"
      }
    });

    await app.close();
  });
});
