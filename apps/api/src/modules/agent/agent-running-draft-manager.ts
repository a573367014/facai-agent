/**
 * 模块职责：Agent 运行中 draft（草稿）管理器。
 *
 * 在 Agent 生成回复的过程中，assistant message 的 parts（文本片段、工具调用、
 * 图片占位等）会高频变化。如果每次 token delta 都写 SQLite，数据库会承受
 * 不必要的写入压力；但如果完全不写，SSE 断线重连和详情查询就无法拿到"当前
 * 已生成到哪了"的中间状态。
 *
 * 解决方案是两层存储：
 * - SQLite：保存最终消息和可回放事件，是长期账本；
 * - runningStateStore（通常 Redis）：保存生成过程中的 parts，是短期草稿纸。
 *
 * 本模块（AgentRunningDraftManager）是这两层之间的协调者：
 * - 运行中：只写草稿，不写 SQLite，避免 token 级写入压力；
 * - 读取时：合并 SQLite 外壳 + Redis 草稿 parts，返回完整快照；
 * - 完成后：把草稿 parts 一次性写回 SQLite，清理草稿。
 *
 * 边界：
 * - 不负责事件发布（由 event bus 负责）；
 * - 不负责 run 生命周期管理（由 coordinator 负责）；
 * - 只做"读写合并"的协调，让 coordinator 不用直接关心 Redis/内存实现细节。
 */
import type { AgentMessageRecord } from "./agent-store.js";
import type {
  RunningMessageDeltaResult,
  RunningMessageState,
  RunningMessageStateStore
} from "./running-message-state-store.js";
import type { AgentStore } from "./agent-store.js";
import type { MessagePart } from "./message-parts.js";

/**
 * 草稿快照：合并后的消息 + 版本号。
 * version 来自 runningStateStore，用于前端去重判断。
 */
export interface RunningDraftSnapshot {
  message: AgentMessageRecord;
  version?: number;
}

/**
 * setParts 的返回值：更新后的 parts + 版本号。
 * version 用于 SSE 事件去重。
 */
export interface DraftPartsUpdate {
  parts: MessagePart[];
  version?: number;
}

// AgentRunningDraftManager 专门管理"正在生成中的 assistant message 草稿"。
// 初学时可以这样理解：
// - SQLite 保存最终消息和可回放事件，是长期账本；
// - runningStateStore 保存生成过程中的 parts，通常在 Redis，是短期草稿纸；
// - 这个类负责在两者之间做读写和合并，避免 coordinator 直接关心 Redis/内存实现细节。
export class AgentRunningDraftManager {
  constructor(
    private readonly store: AgentStore,
    private readonly runningStateStore: RunningMessageStateStore
  ) {}

  async init(message: AgentMessageRecord, runId?: string): Promise<RunningMessageState> {
    // run 开始时先把 assistant message 当前 parts 放进运行态存储。
    // 后续 token delta、图片占位、资源更新都会先改这份草稿。
    return this.runningStateStore.init({
      messageId: message.id,
      sessionId: message.sessionId,
      runId,
      parts: message.parts
    });
  }

  async withDraft(message: AgentMessageRecord): Promise<AgentMessageRecord> {
    // 调用方只想拿"用户现在应该看到的消息"时，用这个方法合并 SQLite 外壳和运行中草稿。
    return (await this.getSnapshot(message)).message;
  }

  async getSnapshot(message: AgentMessageRecord): Promise<RunningDraftSnapshot> {
    if (message.status !== "running") {
      return { message };
    }

    // running message 在 SQLite 里只保存"空壳/最终态"，生成中的 parts 在 Redis draft。
    // SSE 建连和详情查询需要合并这两层，前端才能在刷新后看到当前已经生成的内容。
    const state = await this.runningStateStore.get(message.id);

    if (!state) {
      return { message };
    }

    return {
      message: {
        ...message,
        parts: state.parts,
        updatedAt: state.updatedAt
      },
      version: state.version
    };
  }

  async ensure(message: AgentMessageRecord, runId?: string): Promise<RunningMessageState | undefined> {
    if (message.status !== "running") {
      return undefined;
    }

    // 某些路径可能先收到 delta/媒体事件，再发现草稿还没初始化。
    // ensure 可以把"没有就创建"的兜底集中在这一层。
    const state = await this.runningStateStore.get(message.id);

    if (state) {
      return state;
    }

    return this.init(message, runId);
  }

  /**
   * 获取消息的 parts：优先从草稿读取，没有草稿则回退到 SQLite。
   * 如果消息是 running 状态但草稿不存在，会自动 ensure 创建草稿。
   */
  async getParts(messageId: string, runId?: string): Promise<MessagePart[]> {
    const message = await this.store.getMessage(messageId);

    if (!message) {
      return [];
    }

    const state = await this.ensure(message, runId);
    return state?.parts ?? message.parts;
  }

  async setParts(messageId: string, parts: MessagePart[], runId?: string): Promise<DraftPartsUpdate> {
    const message = await this.store.getMessage(messageId);

    if (!message) {
      return { parts };
    }

    if (message.status === "running") {
      // 运行中只写草稿，不写 SQLite message。
      // 这样高频更新不会让 SQLite 承担 token 级别的写入压力。
      await this.ensure(message, runId);
      const state = await this.runningStateStore.setParts(messageId, parts);
      return {
        parts: state?.parts ?? parts,
        version: state?.version
      };
    }

    return {
      // 非 running 消息没有草稿层，直接更新 SQLite。这个分支主要服务补偿/终态后的少量修正。
      parts: (await this.store.updateMessageParts(messageId, parts))?.parts ?? parts
    };
  }

  async appendTextDelta(messageId: string, delta: string, runId?: string): Promise<RunningMessageDeltaResult | undefined> {
    const message = await this.store.getMessage(messageId);

    if (!message) {
      return undefined;
    }

    // 文本流式输出只追加到草稿，返回 partIndex/version 给 SSE transient event。
    // 前端靠 version 去重，避免断线重连时同一个 delta 被追加两次。
    await this.ensure(message, runId);
    return this.runningStateStore.appendTextDelta(messageId, delta);
  }

  /**
   * 清理草稿：run 结束（成功/失败/取消）后调用，把草稿从运行态存储中删除。
   * 草稿的 parts 应该在此之前已经写回 SQLite。
   */
  async remove(messageId: string): Promise<void> {
    await this.runningStateStore.remove(messageId);
  }
}
