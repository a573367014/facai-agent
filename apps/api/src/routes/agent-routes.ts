import type { OutgoingHttpHeaders } from "node:http";
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
    mime: z.string().min(1),
    url: z.string(),
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
const messageParamsSchema = z.object({
  messageId: z.string().min(1)
});
const runParamsSchema = z.object({
  runId: z.string().min(1)
});
const sessionParamsSchema = z.object({
  sessionId: z.string().min(1)
});
const eventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).optional()
});
const sessionMessagesQuerySchema = z.object({
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

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

function parseEventsQuery(query: unknown) {
  const parsed = eventsQuerySchema.safeParse(query);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "after 必须是大于等于 0 的整数", 400);
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
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
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

export async function registerAgentRoutes(app: FastifyInstance, coordinator: AgentMessageCoordinator): Promise<void> {
  app.post("/agents/sessions", async (request, reply) => {
    const { title } = parseSessionRequest(request.body);
    reply.status(201).send({ session: coordinator.createSession(title) });
  });

  app.get("/agents/sessions", async () => {
    return coordinator.listSessions();
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

  app.post("/agents/messages", async (request, reply) => {
    const input = parseMessageStartRequest(request.body);
    reply.status(202).send(await coordinator.startMessage(input));
  });

  app.post("/agents/runs", async (request, reply) => {
    const input = parseMessageStartRequest(request.body);
    reply.status(202).send(await coordinator.startRun(input));
  });

  app.post("/agents/sessions/:sessionId/messages", async (request, reply) => {
    const { sessionId } = parseSessionParams(request.params);
    const input = parseMessageRequest(request.body);
    reply.status(202).send(await coordinator.startMessage({ ...input, sessionId }));
  });

  app.post("/agents/sessions/:sessionId/runs", async (request, reply) => {
    const { sessionId } = parseSessionParams(request.params);
    const input = parseMessageRequest(request.body);
    reply.status(202).send(await coordinator.startRun({ ...input, sessionId }));
  });

  app.get("/agents/messages/:messageId", async (request) => {
    const { messageId } = parseMessageParams(request.params);
    return coordinator.getMessage(messageId);
  });

  app.get("/agents/runs/:runId", async (request) => {
    const { runId } = parseRunParams(request.params);
    return coordinator.getRun(runId);
  });

  app.post("/agents/messages/:messageId/cancel", async (request) => {
    const { messageId } = parseMessageParams(request.params);
    return coordinator.cancelMessage(messageId);
  });

  app.post("/agents/runs/:runId/cancel", async (request) => {
    const { runId } = parseRunParams(request.params);
    return coordinator.cancelRun(runId);
  });

  app.get("/agents/messages/:messageId/events", async (request, reply) => {
    const { messageId } = parseMessageParams(request.params);
    const { after = 0 } = parseEventsQuery(request.query);
    const { message } = coordinator.getMessage(messageId);

    reply.raw.writeHead(200, buildSseHeaders(reply.getHeaders()));

    const sentEventSeqs = new Set<number>();
    let ended = false;
    let unsubscribe = () => {};
    const finish = () => {
      if (ended) {
        return;
      }

      ended = true;
      unsubscribe();
      reply.raw.end();
    };
    const writeStoredEvent = (event: StoredAgentEvent) => {
      if (ended || event.seq <= after || sentEventSeqs.has(event.seq)) {
        return;
      }

      sentEventSeqs.add(event.seq);
      reply.raw.write(formatStoredSseEvent(event));

      if (isTerminalStoredEvent(event)) {
        finish();
      }
    };

    unsubscribe = coordinator.subscribe(messageId, writeStoredEvent);
    request.raw.on("close", () => {
      if (!ended) {
        ended = true;
        unsubscribe();
      }
    });

    for (const event of coordinator.getEvents(messageId, after)) {
      writeStoredEvent(event);
    }

    if (message.status !== "running") {
      finish();
    }
  });

  app.get("/agents/runs/:runId/events", async (request, reply) => {
    const { runId } = parseRunParams(request.params);
    const { after = 0 } = parseEventsQuery(request.query);
    const { run } = coordinator.getRun(runId);

    reply.raw.writeHead(200, buildSseHeaders(reply.getHeaders()));

    const sentEventSeqs = new Set<number>();
    let ended = false;
    let unsubscribe = () => {};
    const finish = () => {
      if (ended) {
        return;
      }

      ended = true;
      unsubscribe();
      reply.raw.end();
    };
    const writeStoredEvent = (event: StoredAgentEvent) => {
      if (ended || event.seq <= after || sentEventSeqs.has(event.seq)) {
        return;
      }

      sentEventSeqs.add(event.seq);
      reply.raw.write(formatStoredSseEvent(event));

      if (isTerminalStoredEvent(event)) {
        finish();
      }
    };

    unsubscribe = coordinator.subscribeRun(runId, writeStoredEvent);
    request.raw.on("close", () => {
      if (!ended) {
        ended = true;
        unsubscribe();
      }
    });

    for (const event of coordinator.getRunEvents(runId, after)) {
      writeStoredEvent(event);
    }

    if (run.status !== "running") {
      finish();
    }
  });
}
