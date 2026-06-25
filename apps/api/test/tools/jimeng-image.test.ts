import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors/app-error.js";
import { createJimengImageTool } from "../../src/tools/jimeng-image.js";

describe("createJimengImageTool", () => {
  it("配置 AK/SK 时用 HMAC-SHA256 签名调用通用3.0文生图同步转异步接口", async () => {
    const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
    const responses = [
      { code: 10000, data: { task_id: "task_aksk" }, message: "Success" },
      {
        code: 10000,
        data: {
          status: "done",
          image_urls: ["https://example.com/aksk-generated.png"],
          binary_data_base64: null
        },
        message: "Success"
      }
    ];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({
        url: String(url),
        init: init ?? {},
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      });

      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const tool = createJimengImageTool({
      accessKeyId: "ak-test",
      secretAccessKey: "sk-test",
      pollIntervalMs: 0,
      maxPollAttempts: 1,
      now: () => new Date("2026-06-24T12:00:00.000Z"),
      fetchImpl
    });

    const output = await tool.execute({ prompt: "生成一张赛博茶馆图片" }, {});

    expect(output).toMatchObject({
      data: {
        provider: "volcengine_seedream",
        taskId: "task_aksk",
        imageUrls: ["https://example.com/aksk-generated.png"]
      }
    });
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe(
      "https://visual.volcengineapi.com/?Action=CVSync2AsyncSubmitTask&Version=2022-08-31"
    );
    expect(requests[1].url).toBe(
      "https://visual.volcengineapi.com/?Action=CVSync2AsyncGetResult&Version=2022-08-31"
    );
    expect(requests[0].init.headers).toMatchObject({
      "content-type": "application/json",
      host: "visual.volcengineapi.com",
      "x-date": "20260624T120000Z"
    });
    expect(String((requests[0].init.headers as Record<string, string>)["x-content-sha256"])).toMatch(/^[a-f0-9]{64}$/);
    expect(String((requests[0].init.headers as Record<string, string>).authorization)).toContain(
      "HMAC-SHA256 Credential=ak-test/20260624/cn-north-1/cv/request"
    );
    expect(String((requests[0].init.headers as Record<string, string>).authorization)).toContain(
      "SignedHeaders=content-type;host;x-content-sha256;x-date"
    );
    expect(requests[0].body).toMatchObject({
      req_key: "high_aes_general_v30l_zt2i",
      prompt: "生成一张赛博茶馆图片",
      seed: -1,
      width: 1328,
      height: 1328
    });
    expect(requests[1].body).toMatchObject({
      req_key: "high_aes_general_v30l_zt2i",
      task_id: "task_aksk"
    });
    expect(JSON.parse(String(requests[1].body.req_json))).toEqual({ return_url: true });
  });

  it("提交通用3.0任务并轮询到图片 URL", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = [];
    const responses = [
      {
        code: 10000,
        data: { task_id: "task_123" },
        message: "Success",
        request_id: "submit_req"
      },
      {
        code: 10000,
        data: { status: "generating" },
        message: "Success",
        request_id: "poll_req_1"
      },
      {
        code: 10000,
        task_id: "task_123",
        data: {
          status: "done",
          image_urls: ["https://example.com/generated.png"],
          binary_data_base64: null
        },
        message: "Success",
        request_id: "poll_req_2"
      }
    ];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ body });

      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const tool = createJimengImageTool({
      accessKeyId: "ak-test",
      secretAccessKey: "sk-test",
      reqKey: "high_aes_general_v30l_zt2i",
      pollIntervalMs: 0,
      maxPollAttempts: 3,
      fetchImpl
    });

    const output = await tool.execute(
      {
        prompt: "一只橙色机械猫在上海霓虹街头喝咖啡，电影感",
        width: 1472,
        height: 1104,
        seed: 42,
        usePreLlm: true
      },
      {}
    );

    expect(output).toEqual({
      data: {
        provider: "volcengine_seedream",
        reqKey: "high_aes_general_v30l_zt2i",
        taskId: "task_123",
        status: "done",
        prompt: "一只橙色机械猫在上海霓虹街头喝咖啡，电影感",
        imageUrls: ["https://example.com/generated.png"],
        binaryDataBase64: []
      },
      llmContent: expect.stringContaining("图片已生成")
    });
    expect(String((output as { llmContent?: string }).llmContent)).not.toContain("https://example.com/generated.png");
    expect(String((output as { llmContent?: string }).llmContent)).not.toContain("task_123");
    expect(requests[0].body).toMatchObject({
      req_key: "high_aes_general_v30l_zt2i",
      prompt: "一只橙色机械猫在上海霓虹街头喝咖啡，电影感",
      width: 1472,
      height: 1104,
      seed: 42,
      use_pre_llm: true
    });
  });

  it("一次 tool call 内支持按 items 批量生成多张不同参数的图片", async () => {
    const requests: Array<{ action: string | null; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const parsedUrl = new URL(String(url));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const action = parsedUrl.searchParams.get("Action");
      requests.push({ action, body });

      if (action === "CVSync2AsyncSubmitTask") {
        return new Response(
          JSON.stringify({
            code: 10000,
            data: { task_id: body.prompt === "水彩风格的小猪" ? "task_watercolor" : "task_pixel" },
            message: "Success"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      return new Response(JSON.stringify({
        code: 10000,
        data: {
          status: "done",
          image_urls: [
            body.task_id === "task_watercolor"
              ? "https://example.com/watercolor-pig.png"
              : "https://example.com/pixel-pig.png"
          ],
          binary_data_base64: null
        },
        message: "Success"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    const tool = createJimengImageTool({
      accessKeyId: "ak-test",
      secretAccessKey: "sk-test",
      pollIntervalMs: 0,
      maxPollAttempts: 1,
      fetchImpl
    });

    const output = await tool.execute(
      {
        items: [
          { prompt: "水彩风格的小猪", width: 1024, height: 1024, seed: 11 },
          { prompt: "像素风格的小猪", width: 1536, height: 1024, seed: 22, usePreLlm: true }
        ]
      },
      {}
    );

    expect(output).toMatchObject({
      data: {
        provider: "volcengine_seedream",
        reqKey: "high_aes_general_v30l_zt2i",
        status: "done",
        total: 2,
        succeeded: 2,
        failed: 0,
        imageUrls: ["https://example.com/watercolor-pig.png", "https://example.com/pixel-pig.png"],
        items: [
          {
            index: 0,
            status: "success",
            taskId: "task_watercolor",
            prompt: "水彩风格的小猪",
            width: 1024,
            height: 1024,
            imageUrls: ["https://example.com/watercolor-pig.png"]
          },
          {
            index: 1,
            status: "success",
            taskId: "task_pixel",
            prompt: "像素风格的小猪",
            width: 1536,
            height: 1024,
            imageUrls: ["https://example.com/pixel-pig.png"]
          }
        ]
      },
      llmContent: expect.stringContaining("图片已生成，共 2 张")
    });
    expect(String((output as { llmContent?: string }).llmContent)).not.toContain("https://example.com/watercolor-pig.png");
    expect(requests.map((request) => request.action).sort()).toEqual([
      "CVSync2AsyncGetResult",
      "CVSync2AsyncGetResult",
      "CVSync2AsyncSubmitTask",
      "CVSync2AsyncSubmitTask"
    ]);
    expect(requests.find((request) => request.body.prompt === "水彩风格的小猪")?.body).toMatchObject({
      prompt: "水彩风格的小猪",
      width: 1024,
      height: 1024,
      seed: 11
    });
    expect(requests.find((request) => request.body.prompt === "像素风格的小猪")?.body).toMatchObject({
      prompt: "像素风格的小猪",
      width: 1536,
      height: 1024,
      seed: 22,
      use_pre_llm: true
    });
  });

  it("批量生图部分失败时给 LLM 明确标注失败项，避免重试已经成功的图片", async () => {
    const fetchImpl: typeof fetch = async (url, init) => {
      const action = new URL(String(url)).searchParams.get("Action");
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

      if (action === "CVSync2AsyncSubmitTask" && body.prompt === "火山边的一头水牛") {
        return new Response(
          JSON.stringify({
            ResponseMetadata: {
              RequestId: "request_rate_limited",
              Error: {
                Code: "TooManyRequests",
                Message: "submit task concurrency limit"
              }
            }
          }),
          { status: 429, headers: { "content-type": "application/json" } }
        );
      }

      if (action === "CVSync2AsyncSubmitTask") {
        return new Response(
          JSON.stringify({
            code: 10000,
            data: { task_id: "task_dogs" },
            message: "Success"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          code: 10000,
          data: {
            status: "done",
            image_urls: ["https://example.com/two-dogs.png"],
            binary_data_base64: null
          },
          message: "Success"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    const tool = createJimengImageTool({
      accessKeyId: "ak-test",
      secretAccessKey: "sk-test",
      pollIntervalMs: 0,
      maxPollAttempts: 1,
      fetchImpl
    });

    const output = await tool.execute(
      {
        items: [
          { prompt: "火山边的一头水牛", width: 1024, height: 1024, seed: 11 },
          { prompt: "两只小狗在草地玩耍", width: 1024, height: 1024, seed: 22 }
        ]
      },
      {}
    );
    const llmContent = String((output as { llmContent?: string }).llmContent);

    expect(output).toMatchObject({
      data: {
        status: "partial_failed",
        total: 2,
        succeeded: 1,
        failed: 1
      }
    });
    expect(llmContent).toContain("第 1 项失败");
    expect(llmContent).toContain("火山边的一头水牛");
    expect(llmContent).toContain("HTTP 429");
    expect(llmContent).toContain("第 2 项成功");
    expect(llmContent).toContain("两只小狗在草地玩耍");
    expect(llmContent).toContain("只重试失败项");
    expect(llmContent).toContain("不要重试已经成功");
    expect(llmContent).not.toContain("https://example.com/two-dogs.png");
    expect(llmContent).not.toContain("task_dogs");
  });

  it("批量 items 超过 5 个时在参数层拒绝执行", async () => {
    let requested = false;
    const tool = createJimengImageTool({
      accessKeyId: "ak-test",
      secretAccessKey: "sk-test",
      fetchImpl: async () => {
        requested = true;
        throw new Error("不应该发起请求");
      }
    });

    await expect(
      tool.execute(
        {
          items: Array.from({ length: 6 }, (_, index) => ({ prompt: `第 ${index + 1} 张猪` }))
        },
        {}
      )
    ).rejects.toThrow();
    expect(requested).toBe(false);
  });

  it("批量生图按有限并发执行，并把先完成的子任务先通过进度事件返回", async () => {
    const progressEvents: Record<string, unknown>[] = [];
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const fetchImpl: typeof fetch = async (url, init) => {
      const action = new URL(String(url)).searchParams.get("Action");
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

      if (action === "CVSync2AsyncSubmitTask") {
        return new Response(
          JSON.stringify({
            code: 10000,
            data: { task_id: body.prompt === "慢速水彩小猪" ? "task_slow" : "task_fast" },
            message: "Success"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (body.task_id === "task_slow") {
        await wait(20);
      }

      return new Response(
        JSON.stringify({
          code: 10000,
          data: {
            status: "done",
            image_urls: [
              body.task_id === "task_slow"
                ? "https://example.com/slow-watercolor-pig.png"
                : "https://example.com/fast-pixel-pig.png"
            ],
            binary_data_base64: null
          },
          message: "Success"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    const tool = createJimengImageTool({
      accessKeyId: "ak-test",
      secretAccessKey: "sk-test",
      pollIntervalMs: 0,
      maxPollAttempts: 1,
      fetchImpl
    });

    const output = await tool.execute(
      {
        items: [{ prompt: "慢速水彩小猪" }, { prompt: "快速像素小猪" }]
      },
      {
        emitProgress: async (progress: Record<string, unknown>) => {
          progressEvents.push(progress);
        }
      } as never
    );

    expect(output).toMatchObject({
      data: {
        total: 2,
        succeeded: 2,
        failed: 0,
        imageUrls: ["https://example.com/slow-watercolor-pig.png", "https://example.com/fast-pixel-pig.png"]
      }
    });
    expect(
      progressEvents
        .filter((event) => event.kind === "image_batch_item" && (event.item as { status?: string }).status === "success")
        .map((event) => (event.item as { index: number }).index)
    ).toEqual([1, 0]);
  });

  it("缺少火山 AK/SK 时拒绝执行", async () => {
    const tool = createJimengImageTool({
      fetchImpl: async () => {
        throw new Error("不应该发起请求");
      }
    });

    await expect(tool.execute({ prompt: "生成一张图" }, {})).rejects.toThrow("火山引擎 AK/SK 未配置");
  });

  it("没有通用文生图接口权限时返回可读中文错误", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          ResponseMetadata: {
            RequestId: "request_denied",
            Error: {
              Code: "AccessDenied",
              Message: "Access Denied: Access Denied"
            }
          }
        }),
        {
          status: 401,
          headers: { "content-type": "application/json" }
        }
      );
    const tool = createJimengImageTool({
      accessKeyId: "ak-test",
      secretAccessKey: "sk-test",
      fetchImpl
    });

    await expect(tool.execute({ prompt: "生成一张图" }, {})).rejects.toMatchObject({
      code: "TOOL_EXECUTION_ERROR",
      message:
        "火山通用文生图接口请求失败，HTTP 401：火山 AK/SK 已参与签名，但当前账号或密钥没有智能绘图（文生图）接口权限，请在火山控制台确认视觉智能/智能绘图（文生图）服务已开通，并给该 AK 授权"
    } satisfies Partial<AppError>);
  });

  it("任务一直未完成时返回中文超时错误", async () => {
    const fetchImpl: typeof fetch = async (url) => {
      const action = new URL(String(url)).searchParams.get("Action");

      if (action === "CVSync2AsyncSubmitTask") {
        return new Response(JSON.stringify({ code: 10000, data: { task_id: "task_456" }, message: "Success" }));
      }

      return new Response(JSON.stringify({ code: 10000, data: { status: "generating" }, message: "Success" }));
    };
    const tool = createJimengImageTool({
      accessKeyId: "ak-test",
      secretAccessKey: "sk-test",
      pollIntervalMs: 0,
      maxPollAttempts: 2,
      fetchImpl
    });

    await expect(tool.execute({ prompt: "生成一张图" }, {})).rejects.toMatchObject({
      code: "TOOL_EXECUTION_ERROR",
      message: "火山通用文生图任务未在限定时间内完成"
    } satisfies Partial<AppError>);
  });
});
