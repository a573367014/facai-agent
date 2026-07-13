import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { AuthTokenService } from "../../src/modules/auth/auth-token-service.js";
import { registerAuthGuard } from "../../src/modules/auth/auth-guard.js";

function createTokenService() {
  return new AuthTokenService({
    accessSecret: "access-secret",
    refreshSecret: "refresh-secret",
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 15 * 24 * 60 * 60
  });
}

describe("registerAuthGuard", () => {
  it("保护 agents 和 knowledge 路由，同时放行 health、auth 和 OPTIONS", async () => {
    const app = Fastify();
    const tokenService = createTokenService();
    registerAuthGuard(app, { tokenService });
    app.get("/health", async () => ({ status: "ok" }));
    app.get("/auth/me", async () => ({ auth: "public route handler" }));
    app.options("/agents/runs", async () => ({ ok: true }));
    app.get("/agents/runs", async () => ({ ok: true }));
    app.get("/knowledge/documents", async () => ({ ok: true }));

    const token = tokenService.issueTokenPair({
      userId: "user_123",
      githubId: "9911",
      githubLogin: "octocat"
    }).accessToken;

    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/auth/me" })).statusCode).toBe(200);
    expect((await app.inject({ method: "OPTIONS", url: "/agents/runs" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/agents/runs" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/knowledge/documents" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/agents/runs",
          headers: { authorization: `Bearer ${token}` }
        })
      ).statusCode
    ).toBe(200);

    await app.close();
  });
});
