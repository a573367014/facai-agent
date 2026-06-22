import type { OutgoingHttpHeaders } from "node:http";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentRunCoordinator } from "../agent/run-coordinator.js";
import type { StoredAgentEvent } from "../agent/run-store.js";
import type { AgentService } from "../agent/agent-service.js";
import type { AgentStreamEvent } from "../agent/types.js";
import type { AppErrorCode } from "../errors/app-error.js";
import { AppError } from "../errors/app-error.js";

const runRequestSchema = z.object({
  input: z.string().trim().min(1),
  maxIterations: z.number().int().min(1).max(8).optional()
});
const runStartRequestSchema = runRequestSchema.extend({
  sessionId: z.string().min(1).optional()
});
const sessionRequestSchema = z.object({
  title: z.string().trim().min(1).optional()
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

function parseRunRequest(body: unknown) {
  const parsed = runRequestSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "input 必须是非空字符串，maxIterations 必须是 1 到 8 之间的整数", 400);
  }

  return parsed.data;
}

function parseRunStartRequest(body: unknown) {
  const parsed = runStartRequestSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "input 必须是非空字符串，maxIterations 必须是 1 到 8 之间的整数", 400);
  }

  return parsed.data;
}

function parseSessionRequest(body: unknown) {
  const parsed = sessionRequestSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("VALIDATION_ERROR", "title 必须是非空字符串", 400);
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

function toErrorEvent(error: unknown): AgentStreamEvent {
  if (error instanceof AppError) {
    return {
      type: "error",
      code: error.code,
      message: error.message
    };
  }

  return {
    type: "error",
    code: "PROVIDER_ERROR" satisfies AppErrorCode,
    message: error instanceof Error ? error.message : "发生未知错误"
  };
}

function formatSseEvent(event: AgentStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function formatStoredSseEvent(event: StoredAgentEvent): string {
  return `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

function isTerminalStoredEvent(event: StoredAgentEvent): boolean {
  return event.event.type === "final_answer" || event.event.type === "error";
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

export async function registerAgentRoutes(
  app: FastifyInstance,
  agentService: AgentService,
  runCoordinator: AgentRunCoordinator
): Promise<void> {
  app.post("/agents/run", async (request) => {
    return agentService.run(parseRunRequest(request.body));
  });

  app.post("/agents/stream", async (request, reply) => {
    const input = parseRunRequest(request.body);

    reply.raw.writeHead(200, buildSseHeaders(reply.getHeaders()));

    try {
      await agentService.run({
        ...input,
        onEvent: (event) => {
          reply.raw.write(formatSseEvent(event));
        }
      });
    } catch (error) {
      reply.raw.write(formatSseEvent(toErrorEvent(error)));
    } finally {
      reply.raw.end();
    }
  });

  app.post("/agents/sessions", async (request, reply) => {
    const { title } = parseSessionRequest(request.body);
    reply.status(201).send({ session: runCoordinator.createSession(title) });
  });

  app.get("/agents/sessions/:sessionId", async (request) => {
    const { sessionId } = parseSessionParams(request.params);
    return runCoordinator.getSession(sessionId);
  });

  app.post("/agents/runs", async (request, reply) => {
    const input = parseRunStartRequest(request.body);
    reply.status(202).send(runCoordinator.startRun(input));
  });

  app.post("/agents/sessions/:sessionId/runs", async (request, reply) => {
    const { sessionId } = parseSessionParams(request.params);
    const input = parseRunRequest(request.body);
    reply.status(202).send(runCoordinator.startRun({ ...input, sessionId }));
  });

  app.get("/agents/runs/:runId", async (request) => {
    const { runId } = parseRunParams(request.params);
    return runCoordinator.getRun(runId);
  });

  app.get("/agents/runs/:runId/events", async (request, reply) => {
    const { runId } = parseRunParams(request.params);
    const { after = 0 } = parseEventsQuery(request.query);
    const { run } = runCoordinator.getRun(runId);

    reply.raw.writeHead(200, buildSseHeaders(reply.getHeaders()));

    const sentEventIds = new Set<number>();
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
      if (ended || event.id <= after || sentEventIds.has(event.id)) {
        return;
      }

      sentEventIds.add(event.id);
      reply.raw.write(formatStoredSseEvent(event));

      if (isTerminalStoredEvent(event)) {
        finish();
      }
    };

    unsubscribe = runCoordinator.subscribe(runId, writeStoredEvent);
    request.raw.on("close", () => {
      if (!ended) {
        ended = true;
        unsubscribe();
      }
    });

    for (const event of runCoordinator.getEvents(runId, after)) {
      writeStoredEvent(event);
    }

    if (run.status !== "running") {
      finish();
    }
  });
}
