import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearAuthSession,
  getGithubAuthorizeUrl,
  loginWithGithubCode,
  parseTraceId,
  readAuthSession,
  resolveApiBaseUrl,
  startAgentRun,
  uploadAgentDocument,
  uploadAgentImage,
  uploadKnowledgeDocument,
  writeAuthSession
} from "./agent-client";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("resolveApiBaseUrl", () => {
  it("局域网访问页面时会把 localhost API 地址改成当前页面 host", () => {
    expect(resolveApiBaseUrl("http://localhost:4001", "http://10.1.65.46:4000/")).toBe("http://10.1.65.46:4001");
  });

  it("没有配置 API 地址时按当前页面 host 推导 4001 端口", () => {
    expect(resolveApiBaseUrl(undefined, "http://10.1.65.46:4000/")).toBe("http://10.1.65.46:4001");
  });

  it("显式配置非 localhost API 地址时保持原配置", () => {
    expect(resolveApiBaseUrl("https://api.example.com/v1/", "http://10.1.65.46:4000/")).toBe("https://api.example.com/v1");
  });

  it("显式配置相对路径时保持相对路径", () => {
    expect(resolveApiBaseUrl("/api/", "http://10.1.65.46:4000/")).toBe("/api");
  });

  it("uploadAgentImage 使用 FormData 上传图片并返回 resource part", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          file: {
            type: "resource",
            mime: "image/png",
            url: "http://localhost:4001/uploads/images/a.png",
            name: "a.png",
            size: 3
          }
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )
    );

    await expect(uploadAgentImage(new File(["abc"], "a.png", { type: "image/png" }))).resolves.toEqual({
      type: "resource",
      mime: "image/png",
      url: "http://localhost:4001/uploads/images/a.png",
      name: "a.png",
      size: 3
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4001/agents/uploads/images",
      expect.objectContaining({
        method: "POST",
        body: expect.any(FormData)
      })
    );
  });

  it("uploadAgentDocument 使用 document 字段上传聊天文档并返回 resource part", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          file: {
            type: "resource",
            mime: "text/markdown",
            url: "http://localhost:4001/uploads/agent-documents/a.md",
            name: "a.md",
            size: 3
          }
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )
    );

    await expect(uploadAgentDocument(new File(["abc"], "a.md", { type: "text/markdown" }))).resolves.toEqual({
      type: "resource",
      mime: "text/markdown",
      url: "http://localhost:4001/uploads/agent-documents/a.md",
      name: "a.md",
      size: 3
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4001/agents/uploads/documents",
      expect.objectContaining({
        method: "POST",
        body: expect.any(FormData)
      })
    );
    const body = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(body.get("document")).toBeInstanceOf(File);
  });

  it("uploadKnowledgeDocument 使用 document 字段上传文件并返回文档记录", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          document: {
            id: "knowledge_doc_1",
            name: "员工手册.pdf",
            mimeType: "application/pdf",
            sourcePath: "/tmp/员工手册.pdf",
            status: "pending",
            contentHash: "hash",
            chunkCount: 0,
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z"
          }
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )
    );

    await expect(uploadKnowledgeDocument(new File(["abc"], "员工手册.pdf", { type: "application/pdf" }))).resolves.toMatchObject({
      id: "knowledge_doc_1",
      name: "员工手册.pdf",
      status: "pending"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4001/knowledge/documents/upload",
      expect.objectContaining({
        method: "POST",
        body: expect.any(FormData)
      })
    );
    const body = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(body.get("document")).toBeInstanceOf(File);
  });

  it("startAgentRun 不再发送前端迭代次数，交给后端默认值", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: { id: "run_1", sessionId: "session_1", status: "running", phase: "answering", userMessageId: "msg_user", createdAt: "2026-06-29T00:00:00.000Z", updatedAt: "2026-06-29T00:00:00.000Z" },
          session: { id: "session_1", createdAt: "2026-06-29T00:00:00.000Z", updatedAt: "2026-06-29T00:00:00.000Z" },
          userMessage: { id: "msg_user", sessionId: "session_1", role: "user", status: "completed", parts: [], createdAt: "2026-06-29T00:00:00.000Z", updatedAt: "2026-06-29T00:00:00.000Z" }
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      )
    );

    await startAgentRun([{ type: "text", value: "你好" }], "session_1");

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      parts: [{ type: "text", value: "你好" }],
      sessionId: "session_1"
    });
  });

  it("startAgentRun 从 traceparent 响应头解析 traceId 并附到返回结果", async () => {
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const spanId = "b7ad6b7169203331";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: { id: "run_1", sessionId: "session_1", status: "running", phase: "answering", userMessageId: "msg_user", createdAt: "2026-06-29T00:00:00.000Z", updatedAt: "2026-06-29T00:00:00.000Z" },
          session: { id: "session_1", createdAt: "2026-06-29T00:00:00.000Z", updatedAt: "2026-06-29T00:00:00.000Z" },
          userMessage: { id: "msg_user", sessionId: "session_1", role: "user", status: "completed", parts: [], createdAt: "2026-06-29T00:00:00.000Z", updatedAt: "2026-06-29T00:00:00.000Z" }
        }),
        { status: 202, headers: { "content-type": "application/json", traceparent: `00-${traceId}-${spanId}-01` } }
      )
    );

    const result = await startAgentRun([{ type: "text", value: "你好" }], "session_1");

    expect(result.traceId).toBe(traceId);
  });

  it("startAgentRun 在后端未返回 traceparent 时 traceId 为 undefined", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run: { id: "run_1", sessionId: "session_1", status: "running", phase: "answering", userMessageId: "msg_user", createdAt: "2026-06-29T00:00:00.000Z", updatedAt: "2026-06-29T00:00:00.000Z" },
          session: { id: "session_1", createdAt: "2026-06-29T00:00:00.000Z", updatedAt: "2026-06-29T00:00:00.000Z" },
          userMessage: { id: "msg_user", sessionId: "session_1", role: "user", status: "completed", parts: [], createdAt: "2026-06-29T00:00:00.000Z", updatedAt: "2026-06-29T00:00:00.000Z" }
        }),
        { status: 202, headers: { "content-type": "application/json" } }
      )
    );

    const result = await startAgentRun([{ type: "text", value: "你好" }], "session_1");

    expect(result.traceId).toBeUndefined();
  });

  it("登录成功后保存用户和 token，并让后续 API 自动带 Authorization", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: { id: "user_1", githubId: "9911", githubLogin: "octocat" },
            accessToken: "access-token",
            refreshToken: "refresh-token",
            expiresIn: 900,
            refreshTokenExpiresIn: 1296000
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: { id: "run_1", sessionId: "session_1", status: "running", phase: "answering", userMessageId: "msg_user", createdAt: "2026-06-29T00:00:00.000Z", updatedAt: "2026-06-29T00:00:00.000Z" },
            session: { id: "session_1", createdAt: "2026-06-29T00:00:00.000Z", updatedAt: "2026-06-29T00:00:00.000Z" },
            userMessage: { id: "msg_user", sessionId: "session_1", role: "user", status: "completed", parts: [], createdAt: "2026-06-29T00:00:00.000Z", updatedAt: "2026-06-29T00:00:00.000Z" }
          }),
          { status: 202, headers: { "content-type": "application/json" } }
        )
      );

    await loginWithGithubCode({ code: "github-code", redirectUri: "http://localhost:4000/auth/github/callback" });
    await startAgentRun("你好");

    expect(readAuthSession()?.user.githubLogin).toBe("octocat");
    expect(fetchMock.mock.calls[1][1]?.headers).toEqual(
      expect.objectContaining({
        authorization: "Bearer access-token",
        "content-type": "application/json"
      })
    );
  });

  it("accessToken 过期时用 refreshToken 刷新后重试原请求", async () => {
    writeAuthSession({
      user: { id: "user_1", githubId: "9911", githubLogin: "octocat" },
      accessToken: "expired-access",
      refreshToken: "refresh-token",
      expiresIn: 900,
      refreshTokenExpiresIn: 1296000
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "AUTHENTICATION_ERROR", message: "expired" } }), {
          status: 401,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accessToken: "fresh-access",
            refreshToken: "fresh-refresh",
            expiresIn: 900,
            refreshTokenExpiresIn: 1296000
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run: { id: "run_1", sessionId: "session_1", status: "running", phase: "answering", userMessageId: "msg_user", createdAt: "2026-06-29T00:00:00.000Z", updatedAt: "2026-06-29T00:00:00.000Z" },
            session: { id: "session_1", createdAt: "2026-06-29T00:00:00.000Z", updatedAt: "2026-06-29T00:00:00.000Z" },
            userMessage: { id: "msg_user", sessionId: "session_1", role: "user", status: "completed", parts: [], createdAt: "2026-06-29T00:00:00.000Z", updatedAt: "2026-06-29T00:00:00.000Z" }
          }),
          { status: 202, headers: { "content-type": "application/json" } }
        )
      );

    await startAgentRun("你好");

    expect(fetchMock.mock.calls[0][1]?.headers).toEqual(
      expect.objectContaining({
        authorization: "Bearer expired-access"
      })
    );
    expect(fetchMock.mock.calls[1]).toEqual([
      "http://localhost:4001/auth/refresh",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ refreshToken: "refresh-token" })
      })
    ]);
    expect(fetchMock.mock.calls[2][1]?.headers).toEqual(
      expect.objectContaining({
        authorization: "Bearer fresh-access"
      })
    );
    expect(readAuthSession()?.refreshToken).toBe("fresh-refresh");
  });

  it("生成 GitHub OAuth 授权 URL", () => {
    expect(
      getGithubAuthorizeUrl({
        clientId: "client-id",
        redirectUri: "http://localhost:4000/auth/github/callback",
        state: "state-1"
      })
    ).toBe(
      "https://github.com/login/oauth/authorize?client_id=client-id&redirect_uri=http%3A%2F%2Flocalhost%3A4000%2Fauth%2Fgithub%2Fcallback&scope=read%3Auser+user%3Aemail&state=state-1"
    );
  });

  it("clearAuthSession 清空本地登录态", () => {
    writeAuthSession({
      user: { id: "user_1", githubId: "9911", githubLogin: "octocat" },
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 900,
      refreshTokenExpiresIn: 1296000
    });

    clearAuthSession();

    expect(readAuthSession()).toBeUndefined();
  });
});

describe("parseTraceId", () => {
  it("从标准 W3C traceparent 头解析出 traceId", () => {
    expect(parseTraceId("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")).toBe(
      "0af7651916cd43dd8448eb211c80319c"
    );
  });

  it("null 输入返回 undefined", () => {
    expect(parseTraceId(null)).toBeUndefined();
  });

  it("格式不合法（段数不足）返回 undefined", () => {
    expect(parseTraceId("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331")).toBeUndefined();
  });

  it("traceId 长度不是 32 位返回 undefined", () => {
    expect(parseTraceId("00-short-b7ad6b7169203331-01")).toBeUndefined();
  });
});
