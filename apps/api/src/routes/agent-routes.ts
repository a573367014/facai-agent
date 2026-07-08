import type { OutgoingHttpHeaders } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentMessageCoordinator } from "../agent/agent-message-coordinator.js";
import type { StoredAgentEvent } from "../agent/agent-store.js";
import {
  createTextPart,
  partsToLlmText,
  stripRuntimePartFields,
  type MessagePart
} from "../agent/message-parts.js";
import { AppError } from "../errors/app-error.js";
import { getRequestTraceContext } from "../observability/trace-context.js";
import { getS3Bucket, getS3Client, getS3ObjectUrl } from "../storage/s3-client.js";

const partExtraSchema = z.record(z.unknown());
const textPartSchema = z
  .object({
    type: z.literal("text"),
    value: z.string(),
    extra: partExtraSchema.optional()
  })
  .passthrough();
const mediaPartSchema = z
  .object({
    type: z.literal("media"),
    mime: z.string().min(1).optional(),
    url: z.string().optional(),
    name: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    extra: partExtraSchema.optional()
  })
  .passthrough();
const messagePartSchema = z.discriminatedUnion("type", [textPartSchema, mediaPartSchema]);
const messageRequestSchema = z.object({
  input: z.string().trim().min(1).optional(),
  parts: z.array(messagePartSchema).min(1).optional(),
  maxIterations: z.number().int().min(1).max(8).optional()
});
const messageStartRequestSchema = messageRequestSchema.extend({
  sessionId: z.string().min(1).optional()
});
const sessionRequestSchema = z.object({
  title: z.string().trim().min(1).optional()
});
const sessionsQuerySchema = z.object({
  after: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});
const messageParamsSchema = z.object({
  messageId: z.string().min(1)
});
const runParamsSchema = z.object({
  runId: z.string().min(1)
});
const sessionParamsSchema = z.object({
  sessionId: z.string().min(1)
});
const sessionMessagesQuerySchema = z.object({
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});
const imageMimeExtensions: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg"
};

function parseMessageRequest(body: unknown) {
  const parsed = messageRequestSchema.safeParse(body);

  if (!parsed.success || (!parsed.data.input && !parsed.data.parts?.length)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "input 必须是非空字符串，或 parts 必须是非空消息片段数组，maxIterations 必须是 1 到 8 之间的整数",
      400
    );
  }

  return normalizeMessageRequest(parsed.data);
}

function parseMessageStartRequest(body: unknown) {
  const parsed = messageStartRequestSchema.safeParse(body);

  if (!parsed.success || (!parsed.data.input && !parsed.data.parts?.length)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "input 必须是非空字符串，或 parts 必须是非空消息片段数组，maxIterations 必须是 1 到 8 之间的整数",
      400
    );
  }

  return normalizeMessageRequest(parsed.data);
}

function normalizeMessageRequest(input: z.infer<typeof messageStartRequestSchema>) {
  const parts = input.parts?.length
    ? stripRuntimePartFields(input.parts as Array<MessagePart & Record<string, unknown>>)
    : [createTextPart(input.input ?? "")];
  const projectedInput = partsToLlmText(parts) || input.input?.trim() || "";

  return {
    input: projectedInput,
    parts,
    maxIterations: input.maxIterations,
    sessionId: "sessionId" in input ? input.sessionId : undefined
  };
}

function parseSessionRequest(body: unknown) {
  const parsed = sessionRequestSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "title 必须是非空字符串", 400);
  }

  return parsed.data;
}

function parseMessageParams(params: unknown) {
  const parsed = messageParamsSchema.safeParse(params);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "messageId 必须是非空字符串", 400);
  }

  return parsed.data;
}

function parseRunParams(params: unknown) {
  const parsed = runParamsSchema.safeParse(params);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "runId 必须是非空字符串", 400);
  }

  return parsed.data;
}

function parseSessionParams(params: unknown) {
  const parsed = sessionParamsSchema.safeParse(params);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "sessionId 必须是非空字符串", 400);
  }

  return parsed.data;
}

function parseSessionsQuery(query: unknown) {
  const parsed = sessionsQuerySchema.safeParse(query);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "after 必须是非空字符串，limit 必须是 1 到 100 之间的整数", 400);
  }

  return parsed.data;
}

function parseSessionMessagesQuery(query: unknown) {
  const parsed = sessionMessagesQuerySchema.safeParse(query);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "before 必须是非空字符串，limit 必须是 1 到 100 之间的整数", 400);
  }

  return parsed.data;
}

function formatStoredSseEvent(event: StoredAgentEvent): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

function isTerminalStoredEvent(event: StoredAgentEvent): boolean {
  return event.event.type === "run_completed" || event.event.type === "error" || event.event.type === "cancelled";
}

function buildSseHeaders(headers: Record<string, number | string | string[] | undefined>): OutgoingHttpHeaders {
  const sseHeaders: OutgoingHttpHeaders = {};

  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      sseHeaders[key] = value;
    }
  }

  sseHeaders["content-type"] = "text/event-stream; charset=utf-8";
  sseHeaders["cache-control"] = "no-cache, no-transform";
  sseHeaders.connection = "keep-alive";

  return sseHeaders;
}

function createLiveSseEvent(input: {
  messageId?: string;
  runId?: string;
  event: StoredAgentEvent["event"];
}): StoredAgentEvent {
  return {
    id: `event_live_${randomUUID()}`,
    messageId: input.messageId,
    runId: input.runId,
    event: input.event,
    createdAt: new Date().toISOString(),
    transient: true
  };
}

function getImageExtension(mime: string, fileName: string) {
  const mimeExtension = imageMimeExtensions[mime.toLowerCase()];

  if (mimeExtension) {
    return mimeExtension;
  }

  const extension = basename(fileName).match(/\.[a-zA-Z0-9]+$/)?.[0];
  return extension ? extension.toLowerCase() : ".img";
}

export async function registerAgentRoutes(
  app: FastifyInstance,
  coordinator: AgentMessageCoordinator
): Promise<void> {
  app.post("/agents/sessions", async (request, reply) => {
    const { title } = parseSessionRequest(request.body);
    reply.status(201).send({ session: await coordinator.createSession(title) });
  });

  app.get("/agents/sessions", async (request) => {
    return coordinator.listSessions(parseSessionsQuery(request.query));
  });

  app.delete("/agents/sessions/:sessionId", async (request, reply) => {
    const { sessionId } = parseSessionParams(request.params);
    await coordinator.deleteSession(sessionId);
    reply.status(204).send();
  });

  app.get("/agents/sessions/:sessionId", async (request) => {
    const { sessionId } = parseSessionParams(request.params);
    const { limit } = parseSessionMessagesQuery(request.query);
    return coordinator.getSession(sessionId, { messageLimit: limit });
  });

  app.get("/agents/sessions/:sessionId/messages", async (request) => {
    const { sessionId } = parseSessionParams(request.params);
    const { before, limit } = parseSessionMessagesQuery(request.query);
    return coordinator.getSessionMessages(sessionId, { before, messageLimit: limit });
  });

  app.post("/agents/runs", async (request, reply) => {
    const input = parseMessageStartRequest(request.body);
    reply.status(202).send(await coordinator.startRun(input, getRequestTraceContext(request) ?? undefined));
  });

  app.post("/agents/uploads/images", async (request, reply) => {
    const file = await request.file();

    if (!file) {
      throw new AppError("VALIDATION_ERROR", "请选择要上传的图片", 400);
    }

    if (!file.mimetype.startsWith("image/")) {
      throw new AppError("VALIDATION_ERROR", "当前只支持上传图片", 400);
    }

    const buffer = await file.toBuffer();

    if (buffer.length === 0) {
      throw new AppError("VALIDATION_ERROR", "图片内容不能为空", 400);
    }

    const extension = getImageExtension(file.mimetype, file.filename);
    const contentHash = createHash("md5").update(buffer).digest("hex");
    const storedFileName = `${contentHash}${extension}`;
    const s3Key = `images/${storedFileName}`;

    // S3 putObject 对相同 key 是幂等覆盖，不需要本地文件系统的 "wx" 去重逻辑。
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: getS3Bucket(),
        Key: s3Key,
        Body: buffer,
        ContentType: file.mimetype
      })
    );

    reply.status(201).send({
      file: {
        type: "media",
        mime: file.mimetype,
        url: getS3ObjectUrl(s3Key),
        name: basename(file.filename),
        size: buffer.length
      }
    });
  });

  app.post("/agents/sessions/:sessionId/runs", async (request, reply) => {
    const { sessionId } = parseSessionParams(request.params);
    const input = parseMessageRequest(request.body);
    reply.status(202).send(await coordinator.startRun({ ...input, sessionId }, getRequestTraceContext(request) ?? undefined));
  });

  app.get("/agents/messages/:messageId", async (request) => {
    const { messageId } = parseMessageParams(request.params);
    return coordinator.getMessageSnapshot(messageId);
  });

  app.get("/agents/runs/:runId", async (request) => {
    const { runId } = parseRunParams(request.params);
    return coordinator.getRun(runId);
  });

  app.post("/agents/runs/:runId/cancel", async (request) => {
    const { runId } = parseRunParams(request.params);
    return coordinator.cancelRun(runId);
  });

  app.post("/agents/messages/:messageId/regenerate", async (request, reply) => {
    const { messageId } = parseMessageParams(request.params);
    reply.status(202).send(await coordinator.regenerateMessage(messageId));
  });

  app.get("/agents/runs/:runId/stream", async (request, reply) => {
    const { runId } = parseRunParams(request.params);
    await coordinator.getRun(runId);

    reply.raw.writeHead(200, buildSseHeaders(reply.getHeaders()));

    // SSE 连接可能来自首次提交，也可能来自刷新后的恢复。
    // 因此这里不只订阅 live event，还会在订阅后主动补一个 message.snapshot：
    // - running 时 snapshot 从 Redis draft 读，能恢复当前生成中的 parts；
    // - completed/failed/cancelled 时 snapshot 从 SQLite message 读，展示最终状态。
    let ended = false;
    let unsubscribe: () => void | Promise<void> = () => {};
    const finish = () => {
      if (ended) {
        return;
      }

      ended = true;
      void unsubscribe();
      reply.raw.end();
    };
    const writeStoredEvent = (event: StoredAgentEvent) => {
      if (ended) {
        return;
      }

      reply.raw.write(formatStoredSseEvent(event));

      if (isTerminalStoredEvent(event)) {
        finish();
      }
    };

    unsubscribe = await coordinator.subscribeRun(runId, writeStoredEvent);
    request.raw.on("close", () => {
      if (!ended) {
        ended = true;
        void unsubscribe();
      }
    });

    const { run } = await coordinator.getRun(runId);
    if (run.assistantMessageId) {
      const { message, resources, processSteps, version } = await coordinator.getMessageSnapshot(run.assistantMessageId);
      writeStoredEvent(
        createLiveSseEvent({
          runId,
          messageId: message.id,
          event: { type: "message.snapshot", message, resources, processSteps, version }
        })
      );
    }

    if (run.status !== "running") {
      finish();
    }
  });
}
