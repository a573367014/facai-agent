import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentService } from "../../src/agent/agent-service.js";
import type { AgentStreamEvent } from "../../src/agent/types.js";
import type { LlmProvider } from "../../src/providers/types.js";
import { ToolAccessPolicy } from "../../src/tools/access-policy.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";

function createAgentService(
  provider: LlmProvider,
  registry: ToolRegistry,
  defaultMaxIterations = 4,
  toolAccessPolicy?: ToolAccessPolicy
) {
  return new AgentService({
    provider,
    toolRegistry: registry,
    toolAccessPolicy,
    toolExecutor: new ToolExecutor({ registry, timeoutMs: 100, accessPolicy: toolAccessPolicy }),
    defaultMaxIterations
  });
}

describe("AgentService", () => {
  it("执行工具调用并返回最终答案", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "calculator",
      description: "calculator",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ value: 108 })
    });

    const provider: LlmProvider = {
      complete: async ({ messages }) => {
        if (messages.some((message) => message.role === "tool")) {
          return { content: "结果是 108。" };
        }

        return {
          toolCalls: [
            {
              id: "call_1",
              name: "calculator",
              arguments: { expression: "12 * 9" }
            }
          ]
        };
      }
    };

    const service = createAgentService(provider, registry);

    await expect(service.run({ input: "计算 12 * 9" })).resolves.toEqual({
      answer: "结果是 108。",
      steps: [
        {
          type: "tool_call",
          toolName: "calculator",
          arguments: { expression: "12 * 9" },
          result: { value: 108 }
        }
      ]
    });
  });

  it("只把权限策略允许的工具暴露给 provider", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "calculator",
      description: "calculator",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ value: 1 })
    });
    registry.register({
      name: "dangerous_tool",
      description: "dangerous",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true })
    });
    const provider: LlmProvider = {
      complete: async ({ tools }) => ({
        content: tools.map((tool) => tool.name).join(",")
      })
    };
    const service = createAgentService(
      provider,
      registry,
      4,
      new ToolAccessPolicy({ allowedToolNames: ["calculator"] })
    );

    await expect(service.run({ input: "有哪些工具" })).resolves.toEqual({
      answer: "calculator",
      steps: []
    });
  });

  it("达到最大迭代次数时返回 AGENT_MAX_ITERATIONS", async () => {
    const provider: LlmProvider = {
      complete: async () => ({
        toolCalls: [{ id: "call_1", name: "noop", arguments: {} }]
      })
    };
    const registry = new ToolRegistry();
    registry.register({
      name: "noop",
      description: "noop",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true })
    });
    const service = createAgentService(provider, registry, 1);

    await expect(service.run({ input: "一直调用工具" })).rejects.toMatchObject({
      code: "AGENT_MAX_ITERATIONS",
      message: "Agent 达到最大迭代次数，仍未得到最终答案"
    });
  });

  it("provider 没有返回答案也没有工具调用时返回 PROVIDER_BAD_RESPONSE", async () => {
    const provider: LlmProvider = {
      complete: async () => ({})
    };
    const service = createAgentService(provider, new ToolRegistry());

    await expect(service.run({ input: "空响应" })).rejects.toMatchObject({
      code: "PROVIDER_BAD_RESPONSE",
      message: "模型响应缺少最终回答或工具调用"
    });
  });

  it("可恢复工具错误会作为 tool 观察结果回灌给 provider", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "echo",
      description: "echo",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      },
      argumentSchema: z.object({ text: z.string().min(1) }),
      execute: async (args) => ({ text: args.text })
    });
    const observedToolContents: string[] = [];
    const provider: LlmProvider = {
      complete: async ({ messages }) => {
        const toolMessages = messages.filter((message) => message.role === "tool");

        if (toolMessages.length > 0) {
          observedToolContents.push(...toolMessages.map((message) => message.content));
          return { content: "工具参数不合法，请补充 text 后再试。" };
        }

        return {
          toolCalls: [
            {
              id: "call_1",
              name: "echo",
              arguments: {}
            }
          ]
        };
      }
    };
    const events: AgentStreamEvent[] = [];
    const service = createAgentService(provider, registry);

    await expect(
      service.run({
        input: "调用 echo",
        onEvent: (event) => {
          events.push(event);
        }
      })
    ).resolves.toEqual({
      answer: "工具参数不合法，请补充 text 后再试。",
      steps: []
    });
    expect(JSON.parse(observedToolContents[0])).toEqual({
      ok: false,
      error: {
        code: "TOOL_INVALID_ARGUMENTS",
        message: "工具 echo 的参数不合法",
        recoverable: true
      }
    });
    expect(events).toContainEqual({
      type: "tool_error",
      iteration: 0,
      toolCallId: "call_1",
      toolName: "echo",
      durationMs: expect.any(Number),
      error: {
        code: "TOOL_INVALID_ARGUMENTS",
        message: "工具 echo 的参数不合法",
        recoverable: true
      }
    });
    expect(events).toContainEqual({
      type: "agent_state",
      iteration: 0,
      state: "observing",
      label: "工具错误已写回上下文"
    });
    expect(events).not.toContainEqual({
      type: "agent_state",
      iteration: 0,
      state: "failed",
      label: "工具执行失败"
    });
  });

  it("执行过程中按顺序发出 trace 事件", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "calculator",
      description: "calculator",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ value: 108 })
    });

    const provider: LlmProvider = {
      complete: async ({ messages }) => {
        if (messages.some((message) => message.role === "tool")) {
          return { content: "结果是 108。" };
        }

        return {
          toolCalls: [
            {
              id: "call_1",
              name: "calculator",
              arguments: { expression: "12 * 9" }
            }
          ]
        };
      }
    };
    const events: AgentStreamEvent[] = [];
    const service = createAgentService(provider, registry);

    await service.run({
      input: "计算 12 * 9",
      onEvent: (event) => {
        events.push(event);
      }
    });

    expect(events.map((event) => event.type)).toEqual([
      "iteration_start",
      "agent_state",
      "llm_start",
      "llm_response",
      "tool_call_ready",
      "agent_state",
      "tool_start",
      "tool_result",
      "agent_state",
      "iteration_end",
      "iteration_start",
      "agent_state",
      "llm_start",
      "llm_response",
      "agent_state",
      "iteration_end",
      "agent_state",
      "final_answer"
    ]);
    expect(events).toContainEqual({
      type: "tool_call_ready",
      iteration: 0,
      toolCallId: "call_1",
      toolName: "calculator",
      arguments: { expression: "12 * 9" }
    });
    expect(events).toContainEqual({
      type: "tool_result",
      iteration: 0,
      toolCallId: "call_1",
      toolName: "calculator",
      result: { value: 108 },
      durationMs: expect.any(Number)
    });
    expect(events.at(-1)).toMatchObject({
      type: "final_answer",
      answer: "结果是 108。"
    });
  });

  it("provider 支持流式时发出 answer_delta 事件", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "calculator",
      description: "calculator",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ value: 108 })
    });

    const provider: LlmProvider = {
      complete: async () => {
        throw new Error("streaming path should be used");
      },
      completeStream: async ({ messages }, onDelta) => {
        if (!messages.some((message) => message.role === "tool")) {
          return {
            toolCalls: [
              {
                id: "call_1",
                name: "calculator",
                arguments: { expression: "12 * 9" }
              }
            ]
          };
        }

        await onDelta("结果是");
        await onDelta(" 108。");
        return { content: "结果是 108。" };
      }
    };
    const events: AgentStreamEvent[] = [];
    const service = createAgentService(provider, registry);

    const result = await service.run({
      input: "计算 12 * 9",
      onEvent: (event) => {
        events.push(event);
      }
    });

    expect(result.answer).toBe("结果是 108。");
    expect(events.map((event) => event.type)).toEqual([
      "iteration_start",
      "agent_state",
      "llm_start",
      "llm_response",
      "tool_call_ready",
      "agent_state",
      "tool_start",
      "tool_result",
      "agent_state",
      "iteration_end",
      "iteration_start",
      "agent_state",
      "llm_start",
      "answer_delta",
      "answer_delta",
      "llm_response",
      "agent_state",
      "iteration_end",
      "agent_state",
      "final_answer"
    ]);
    expect(events.filter((event) => event.type === "answer_delta")).toEqual([
      { type: "answer_delta", iteration: 1, delta: "结果是" },
      { type: "answer_delta", iteration: 1, delta: " 108。" }
    ]);
  });

  it("工具执行失败时发出 tool_error 和 failed 状态", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "calculator",
      description: "calculator",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("除数不能为 0");
      }
    });

    const provider: LlmProvider = {
      complete: async () => ({
        toolCalls: [
          {
            id: "call_1",
            name: "calculator",
            arguments: { expression: "1 / 0" }
          }
        ]
      })
    };
    const events: AgentStreamEvent[] = [];
    const service = createAgentService(provider, registry);

    await expect(
      service.run({
        input: "计算 1 / 0",
        onEvent: (event) => {
          events.push(event);
        }
      })
    ).rejects.toMatchObject({
      code: "TOOL_EXECUTION_ERROR",
      message: "除数不能为 0"
    });

    expect(events.map((event) => event.type)).toContain("tool_error");
    expect(events).toContainEqual({
      type: "tool_error",
      iteration: 0,
      toolCallId: "call_1",
      toolName: "calculator",
      durationMs: expect.any(Number),
      error: {
        code: "TOOL_EXECUTION_ERROR",
        message: "除数不能为 0",
        recoverable: false
      }
    });
    expect(events).toContainEqual({
      type: "agent_state",
      iteration: 0,
      state: "failed",
      label: "工具执行失败"
    });
  });
});
