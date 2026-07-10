import { describe, expect, it, vi } from "vitest";
import { AuthTokenService } from "../../src/modules/auth/auth-token-service.js";

describe("AuthTokenService", () => {
  it("签发 accessToken 和 15 天 refreshToken，并能无状态验证 payload", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T00:00:00.000Z"));
    const service = new AuthTokenService({
      accessSecret: "access-secret",
      refreshSecret: "refresh-secret",
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 15 * 24 * 60 * 60
    });

    const tokenPair = service.issueTokenPair({
      userId: "user_123",
      githubId: "9911",
      githubLogin: "octocat"
    });

    expect(tokenPair.expiresIn).toBe(900);
    expect(tokenPair.refreshTokenExpiresIn).toBe(15 * 24 * 60 * 60);
    expect(service.verifyAccessToken(tokenPair.accessToken)).toMatchObject({
      sub: "user_123",
      typ: "access",
      githubId: "9911",
      githubLogin: "octocat"
    });
    expect(service.verifyRefreshToken(tokenPair.refreshToken)).toMatchObject({
      sub: "user_123",
      typ: "refresh",
      githubId: "9911",
      githubLogin: "octocat",
      exp: Math.floor(new Date("2026-07-23T00:00:00.000Z").getTime() / 1000)
    });
  });

  it("拒绝用 refreshToken 访问 accessToken 鉴权入口", () => {
    const service = new AuthTokenService({
      accessSecret: "access-secret",
      refreshSecret: "refresh-secret",
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 15 * 24 * 60 * 60
    });

    const tokenPair = service.issueTokenPair({
      userId: "user_123",
      githubId: "9911",
      githubLogin: "octocat"
    });

    expect(() => service.verifyAccessToken(tokenPair.refreshToken)).toThrow("无效或已过期的 accessToken");
  });

  it("拒绝已过期的 refreshToken", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T00:00:00.000Z"));
    const service = new AuthTokenService({
      accessSecret: "access-secret",
      refreshSecret: "refresh-secret",
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 15 * 24 * 60 * 60
    });
    const tokenPair = service.issueTokenPair({
      userId: "user_123",
      githubId: "9911",
      githubLogin: "octocat"
    });

    vi.setSystemTime(new Date("2026-07-23T00:00:01.000Z"));

    expect(() => service.verifyRefreshToken(tokenPair.refreshToken)).toThrow("无效或已过期的 refreshToken");
  });
});
