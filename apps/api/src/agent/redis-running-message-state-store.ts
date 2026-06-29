import type {
  InitRunningMessageStateInput,
  RunningMessageDeltaResult,
  RunningMessageState,
  RunningMessageStateStore
} from "./running-message-state-store.js";
import type { MessagePart } from "./message-parts.js";

export interface RedisRunningMessageClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

export interface RedisRunningMessageStateStoreOptions {
  client: RedisRunningMessageClient;
  keyPrefix?: string;
  ttlSeconds?: number;
  now?: () => string;
}

const defaultKeyPrefix = "agent";
const defaultTtlSeconds = 2 * 60 * 60;

const appendTextDeltaScript = `
local key = KEYS[1]
local delta = ARGV[1]
local updated_at = ARGV[2]
local ttl_seconds = tonumber(ARGV[3])
local encoded_state = redis.call("GET", key)

if not encoded_state then
  return nil
end

local state = cjson.decode(encoded_state)
local parts = state["parts"] or {}
local part_index = nil

for index, part in ipairs(parts) do
  if part["type"] == "text" then
    part_index = index
    break
  end
end

if not part_index then
  table.insert(parts, 1, { type = "text", value = "" })
  part_index = 1
end

local part = parts[part_index]
part["value"] = tostring(part["value"] or "") .. delta
state["parts"] = parts
state["version"] = tonumber(state["version"] or 0) + 1
state["updatedAt"] = updated_at

redis.call("SET", key, cjson.encode(state), "EX", ttl_seconds)

return cjson.encode({ state = state, partIndex = part_index - 1 })
`;

const setPartsScript = `
local key = KEYS[1]
local encoded_parts = ARGV[1]
local updated_at = ARGV[2]
local ttl_seconds = tonumber(ARGV[3])
local encoded_state = redis.call("GET", key)

if not encoded_state then
  return nil
end

local state = cjson.decode(encoded_state)
state["parts"] = cjson.decode(encoded_parts)
state["version"] = tonumber(state["version"] or 0) + 1
state["updatedAt"] = updated_at

redis.call("SET", key, cjson.encode(state), "EX", ttl_seconds)

return cjson.encode(state)
`;

export class RedisRunningMessageStateStore implements RunningMessageStateStore {
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private readonly now: () => string;

  constructor(private readonly options: RedisRunningMessageStateStoreOptions) {
    this.keyPrefix = options.keyPrefix ?? defaultKeyPrefix;
    this.ttlSeconds = options.ttlSeconds ?? defaultTtlSeconds;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async init(input: InitRunningMessageStateInput): Promise<RunningMessageState> {
    const timestamp = this.now();
    const state: RunningMessageState = {
      messageId: input.messageId,
      sessionId: input.sessionId,
      runId: input.runId,
      parts: cloneParts(input.parts),
      version: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    await this.options.client.set(this.getStateKey(input.messageId), JSON.stringify(state), "EX", this.ttlSeconds);
    return cloneState(state);
  }

  async get(messageId: string): Promise<RunningMessageState | undefined> {
    const rawState = await this.options.client.get(this.getStateKey(messageId));
    return rawState ? cloneState(parseState(rawState)) : undefined;
  }

  async appendTextDelta(messageId: string, delta: string): Promise<RunningMessageDeltaResult | undefined> {
    const rawResult = await this.options.client.eval(
      appendTextDeltaScript,
      1,
      this.getStateKey(messageId),
      delta,
      this.now(),
      this.ttlSeconds
    );

    if (typeof rawResult !== "string") {
      return undefined;
    }

    const result = JSON.parse(rawResult) as { state: RunningMessageState; partIndex: number };

    return {
      state: cloneState(result.state),
      partIndex: result.partIndex
    };
  }

  async setParts(messageId: string, parts: MessagePart[]): Promise<RunningMessageState | undefined> {
    const rawState = await this.options.client.eval(
      setPartsScript,
      1,
      this.getStateKey(messageId),
      JSON.stringify(parts),
      this.now(),
      this.ttlSeconds
    );

    return typeof rawState === "string" ? cloneState(parseState(rawState)) : undefined;
  }

  async remove(messageId: string): Promise<void> {
    await this.options.client.del(this.getStateKey(messageId));
  }

  private getStateKey(messageId: string) {
    // {messageId} 是 Redis Cluster hash tag；后续如果同一脚本扩展到多 key，可以保证落在同一个 slot。
    return `${this.keyPrefix}:running-message:{${messageId}}:state`;
  }
}

function parseState(value: string): RunningMessageState {
  return JSON.parse(value) as RunningMessageState;
}

function cloneState(state: RunningMessageState): RunningMessageState {
  return {
    ...state,
    parts: cloneParts(state.parts)
  };
}

function cloneParts(parts: MessagePart[]): MessagePart[] {
  return JSON.parse(JSON.stringify(parts)) as MessagePart[];
}
