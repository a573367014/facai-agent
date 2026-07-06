import type { ChatOpenAI } from "@langchain/openai";
import type { BaseMessage } from "@langchain/core/messages";

export interface MockModelResponse {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

export type MockModel = ChatOpenAI & {
  readonly calls: ReadonlyArray<ReadonlyArray<BaseMessage>>;
};

interface MockStreamChunk {
  content: string;
  tool_call_chunks?: Array<{ index: number; id?: string; name?: string; args?: string }>;
}

function responseToChunks(response: MockModelResponse): MockStreamChunk[] {
  const chunks: MockStreamChunk[] = [];
  if (response.content) {
    chunks.push({ content: response.content });
  }
  for (const [index, toolCall] of (response.toolCalls ?? []).entries()) {
    chunks.push({
      content: "",
      tool_call_chunks: [
        { index, id: toolCall.id, name: toolCall.name, args: JSON.stringify(toolCall.args) }
      ]
    });
  }
  return chunks;
}

export function createMockModel(responses: MockModelResponse[]): MockModel {
  const calls: BaseMessage[][] = [];
  let callIndex = 0;

  const pickResponse = (): MockModelResponse => {
    const response = responses[Math.min(callIndex, responses.length - 1)];
    callIndex += 1;
    return response;
  };

  const stream = async (messages?: unknown) => {
    if (Array.isArray(messages)) {
      calls.push(messages as BaseMessage[]);
    }
    const chunks = responseToChunks(pickResponse());
    return (async function* generateChunks() {
      for (const chunk of chunks) {
        yield chunk;
      }
    })();
  };

  const invoke = async (messages?: unknown) => {
    if (Array.isArray(messages)) {
      calls.push(messages as BaseMessage[]);
    }
    const response = pickResponse();
    return {
      content: response.content ?? "",
      tool_calls: (response.toolCalls ?? []).map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args
      }))
    };
  };

  const streamTarget = { stream, invoke };
  const model = {
    bindTools: () => streamTarget,
    stream,
    invoke,
    calls
  };

  return model as unknown as MockModel;
}
