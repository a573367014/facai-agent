import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJimengVideoTool } from "../../src/tools/jimeng-video.js";

describe("createJimengVideoTool", () => {
  it("配置 AK/SK 时用即梦视频 3.0 720P 文生视频接口生成视频", async () => {
    const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
    const responses = [
      {
        code: 10000,
        data: { task_id: "task_video" },
        message: "Success"
      },
      {
        code: 10000,
        data: {
          status: "done",
          video_url: "https://example.com/generated-video.mp4"
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
    const tool = createJimengVideoTool({
      accessKeyId: "ak-test",
      secretAccessKey: "sk-test",
      pollIntervalMs: 0,
      maxPollAttempts: 1,
      now: () => new Date("2026-06-29T09:00:00.000Z"),
      fetchImpl
    });

    const output = await tool.execute(
      {
        prompt: "一只小猪在阳光草地上奔跑，电影感镜头",
        frames: 121,
        aspectRatio: "16:9",
        seed: 12
      },
      {}
    );

    expect(output).toEqual({
      data: {
        provider: "volcengine_jimeng_video",
        reqKey: "jimeng_t2v_v30",
        taskId: "task_video",
        status: "done",
        prompt: "一只小猪在阳光草地上奔跑，电影感镜头",
        videoUrls: ["https://example.com/generated-video.mp4"],
        seed: 12,
        frames: 121,
        aspectRatio: "16:9"
      },
      llmContent: expect.stringContaining("视频已生成完成")
    });
    expect(String((output as { llmContent?: string }).llmContent)).not.toContain("https://example.com/generated-video.mp4");
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
      "x-date": "20260629T090000Z"
    });
    expect(String((requests[0].init.headers as Record<string, string>)["x-content-sha256"])).toMatch(/^[a-f0-9]{64}$/);
    expect(String((requests[0].init.headers as Record<string, string>).authorization)).toContain(
      "HMAC-SHA256 Credential=ak-test/20260629/cn-north-1/cv/request"
    );
    expect(requests[0].body).toEqual({
      req_key: "jimeng_t2v_v30",
      prompt: "一只小猪在阳光草地上奔跑，电影感镜头",
      seed: 12,
      frames: 121,
      aspect_ratio: "16:9"
    });
    expect(requests[1].body).toEqual({
      req_key: "jimeng_t2v_v30",
      task_id: "task_video"
    });
  });

  it("传入首帧图片时使用图生视频首帧 req_key", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = [];
    const responses = [
      { code: 10000, data: { task_id: "task_first_frame" }, message: "Success" },
      { code: 10000, data: { status: "done", video_url: "https://example.com/first-frame.mp4" }, message: "Success" }
    ];
    const tool = createJimengVideoTool({
      accessKeyId: "ak-test",
      secretAccessKey: "sk-test",
      pollIntervalMs: 0,
      maxPollAttempts: 1,
      fetchImpl: async (_url, init) => {
        requests.push({
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });

        return new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const output = await tool.execute(
      {
        prompt: "让画面中的小猪向镜头跑来",
        firstFrameImageUrl: "https://cdn.example.com/first.png",
        frames: 121
      },
      {}
    );

    expect(output).toMatchObject({
      data: {
        provider: "volcengine_jimeng_video",
        reqKey: "jimeng_i2v_first_v30",
        taskId: "task_first_frame",
        firstFrameImageUrl: "https://cdn.example.com/first.png",
        videoUrls: ["https://example.com/first-frame.mp4"]
      }
    });
    expect(requests[0].body).toEqual({
      req_key: "jimeng_i2v_first_v30",
      prompt: "让画面中的小猪向镜头跑来",
      image_urls: ["https://cdn.example.com/first.png"],
      seed: -1,
      frames: 121
    });
  });

  it("同时传入首帧和尾帧图片时使用图生视频首尾帧 req_key", async () => {
    const requests: Array<{ body: Record<string, unknown> }> = [];
    const responses = [
      { code: 10000, data: { task_id: "task_first_tail" }, message: "Success" },
      { code: 10000, data: { status: "done", video_url: "https://example.com/first-tail.mp4" }, message: "Success" }
    ];
    const tool = createJimengVideoTool({
      accessKeyId: "ak-test",
      secretAccessKey: "sk-test",
      pollIntervalMs: 0,
      maxPollAttempts: 1,
      fetchImpl: async (_url, init) => {
        requests.push({
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });

        return new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    const output = await tool.execute(
      {
        prompt: "从站在草地的小猪过渡到小猪坐在花丛旁",
        firstFrameImageUrl: "https://cdn.example.com/first.png",
        lastFrameImageUrl: "https://cdn.example.com/last.png"
      },
      {}
    );

    expect(output).toMatchObject({
      data: {
        provider: "volcengine_jimeng_video",
        reqKey: "jimeng_i2v_first_tail_v30",
        taskId: "task_first_tail",
        firstFrameImageUrl: "https://cdn.example.com/first.png",
        lastFrameImageUrl: "https://cdn.example.com/last.png",
        videoUrls: ["https://example.com/first-tail.mp4"]
      }
    });
    expect(requests[0].body).toEqual({
      req_key: "jimeng_i2v_first_tail_v30",
      prompt: "从站在草地的小猪过渡到小猪坐在花丛旁",
      image_urls: ["https://cdn.example.com/first.png", "https://cdn.example.com/last.png"],
      seed: -1,
      frames: 121
    });
  });

  it("本地上传的首尾帧图片会转成 base64 提交给火山", async () => {
    const uploadDirectory = await mkdtemp(join(tmpdir(), "agent-jimeng-video-upload-"));
    await mkdir(join(uploadDirectory, "images"), { recursive: true });
    await writeFile(join(uploadDirectory, "images", "first.png"), Buffer.from("first-frame"));
    await writeFile(join(uploadDirectory, "images", "last.png"), Buffer.from("last-frame"));
    const requests: Array<{ body: Record<string, unknown> }> = [];
    const responses = [
      { code: 10000, data: { task_id: "task_local_frames" }, message: "Success" },
      { code: 10000, data: { status: "done", video_url: "https://example.com/local-frames.mp4" }, message: "Success" }
    ];
    const tool = createJimengVideoTool({
      accessKeyId: "ak-test",
      secretAccessKey: "sk-test",
      uploadDirectory,
      pollIntervalMs: 0,
      maxPollAttempts: 1,
      fetchImpl: async (_url, init) => {
        requests.push({
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
        });

        return new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    await tool.execute(
      {
        prompt: "让第一张图自然过渡到第二张图",
        firstFrameImageUrl: "http://localhost:4001/uploads/images/first.png",
        lastFrameImageUrl: "http://localhost:4001/uploads/images/last.png"
      },
      {}
    );

    expect(requests[0].body).toEqual({
      req_key: "jimeng_i2v_first_tail_v30",
      prompt: "让第一张图自然过渡到第二张图",
      binary_data_base64: [Buffer.from("first-frame").toString("base64"), Buffer.from("last-frame").toString("base64")],
      seed: -1,
      frames: 121
    });
  });

  it("尾帧图片不能脱离首帧单独传入", async () => {
    const tool = createJimengVideoTool({
      accessKeyId: "ak-test",
      secretAccessKey: "sk-test",
      fetchImpl: async () => new Response("{}")
    });

    await expect(
      tool.execute(
        {
          prompt: "只给尾帧",
          lastFrameImageUrl: "https://cdn.example.com/last.png"
        },
        {}
      )
    ).rejects.toThrow("lastFrameImageUrl 需要和 firstFrameImageUrl 一起传入");
  });

  it("视频任务完成但没有 video_url 时返回工具错误", async () => {
    const responses = [
      { code: 10000, data: { task_id: "task_video" }, message: "Success" },
      { code: 10000, data: { status: "done" }, message: "Success" }
    ];
    const tool = createJimengVideoTool({
      accessKeyId: "ak-test",
      secretAccessKey: "sk-test",
      pollIntervalMs: 0,
      maxPollAttempts: 1,
      fetchImpl: async () =>
        new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    });

    await expect(tool.execute({ prompt: "生成一段草地小猪视频" }, {})).rejects.toThrow("任务完成但没有返回视频");
  });
});
