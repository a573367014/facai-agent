import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTraceId, resolveApiBaseUrl, startAgentRun, uploadAgentImage, uploadKnowledgeDocument } from "./agent-client";

afterEach(() => {
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

  it("uploadAgentImage 使用 FormData 上传图片并返回 media part", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          file: {
            type: "media",
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
      type: "media",
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
