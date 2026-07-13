/**
 * Agent 可观测性指标。
 *
 * 职责：为 Agent 运行时提供统一的可观测性出口，把「一次 run」「一次 LLM 调用」
 * 「一次工具调用」「一次资源传输」四类事件，同时记录为 OTel 指标（Counter/Histogram）
 * 和当前 span 上的事件（Span Event），供后端做成功率、延迟分布、错误归因分析。
 * 边界：只负责「记录」，不负责「决策」——不根据指标做熔断/限流，不负责指标导出
 * （导出由 otel 模块的 metricReader 完成）。指标创建延迟到首次记录：避免进程启动时
 * OTel 未就绪导致 instrument 创建失败。
 */
import { context, trace, type Attributes, type Counter, type Histogram, type Meter } from "@opentelemetry/api";
import { getMeter } from "./otel.js";

/**
 * Agent 各阶段观测状态。
 *
 * succeeded：正常成功；completed：run 正常结束（含无工具调用的直答）；
 * failed：执行出错；cancelled：用户主动中断；skipped：被前置条件跳过。
 * 用字符串枚举而非 boolean：失败原因和成功路径都需要在指标维度里区分，
 * boolean 只能表达成败，无法表达「取消」这种既非成功也非失败的语义。
 */
export type AgentObservationStatus = "succeeded" | "completed" | "failed" | "cancelled" | "skipped";

/**
 * 一次 Agent run 的观测数据。
 *
 * runId 是链路串联主键，sessionId/messageId 用于关联会话上下文。
 * phase 标记 run 所处阶段（如 planning/executing），用于分析各阶段耗时分布。
 */
export interface AgentRunObservation {
  runId: string;
  sessionId?: string;
  messageId?: string;
  status: AgentObservationStatus;
  phase?: string;
  durationMs: number;
  errorCode?: string;
}

/**
 * 一次 LLM 调用的观测数据。
 *
 * iteration 标记这是第几轮迭代，用于分析「多轮才收敛」的成本。
 * mode 区分 tool_bound（绑定工具调用）、final（最终回复）、summary（摘要生成），
 * 不同 mode 的延迟和成本差异大，需分维度统计。
 */
export interface AgentLlmCallObservation {
  sessionId?: string;
  messageId?: string;
  iteration: number;
  provider: string;
  model: string;
  mode: "tool_bound" | "final" | "summary";
  status: AgentObservationStatus;
  durationMs: number;
  errorCode?: string;
}

/**
 * 一次工具调用的观测数据。
 *
 * toolName 是指标维度核心：不同工具的成功率和延迟差异极大（如读文件 vs 执行命令），
 * 必须按工具名分桶统计才能定位瓶颈工具。
 */
export interface AgentToolCallObservation {
  sessionId?: string;
  messageId?: string;
  toolCallId?: string;
  toolName: string;
  status: AgentObservationStatus;
  durationMs: number;
  errorCode?: string;
}

/**
 * 一次资源传输（图片/视频/文档上传到对象存储）的观测数据。
 *
 * bytes 单独走 Histogram：传输量分布是长尾的，平均值无意义，需用分位数（p50/p95/p99）分析。
 */
export interface AgentResourceTransferObservation {
  resourceType: "image" | "video" | "document";
  mime?: string;
  status: AgentObservationStatus;
  durationMs: number;
  bytes?: number;
  errorCode?: string;
}

/**
 * Agent 可观测性出口接口。
 *
 * 四个 record 方法对应四类事件，调用方只需构造 observation 对象传入，
 * 不需要关心底层是 OTel 还是其他实现。面向接口编程便于测试时注入 noop 实现。
 */
export interface AgentObservability {
  recordRun(observation: AgentRunObservation): void;
  recordLlmCall(observation: AgentLlmCallObservation): void;
  recordToolCall(observation: AgentToolCallObservation): void;
  recordResourceTransfer(observation: AgentResourceTransferObservation): void;
}

/**
 * 创建可观测性实例的配置。
 *
 * meterFactory 可选：测试时可注入 noop meter，避免依赖全局 OTel 状态；
 * 不传时走默认 getMeter，从全局 OTel API 获取。
 */
export interface CreateAgentObservabilityOptions {
  meterFactory?: () => Meter;
}

/**
 * OTel 指标仪器集合。
 *
 * 每类事件对应一个 Counter（计数）+ 一个 Histogram（延迟分布），
 * 资源传输额外多一个 bytes Histogram（传输量分布）。
 * 创建后缓存复用：OTel instrument 创建有开销，不应每次记录都新建。
 */
interface AgentMetricInstruments {
  runCounter: Counter;
  runDuration: Histogram;
  llmCounter: Counter;
  llmDuration: Histogram;
  toolCounter: Counter;
  toolDuration: Histogram;
  resourceTransferCounter: Counter;
  resourceTransferDuration: Histogram;
  resourceTransferBytes: Histogram;
}

/**
 * 基于 OTel 的 AgentObservability 实现。
 *
 * 指标仪器延迟创建（getInstruments 首次调用时才 new）：因为模块顶层有
 * defaultAgentObservability 单例，进程启动时 OTel 可能尚未初始化，提前创建
 * 会拿到 noop meter 且无法切换。延迟到首次记录时创建，确保拿到真实 meter。
 */
class OtelAgentObservability implements AgentObservability {
  private instruments?: AgentMetricInstruments;

  constructor(private readonly options: CreateAgentObservabilityOptions = {}) {}

  /**
   * 记录一次 Agent run 完成。
   *
   * 同时写指标（Counter + Histogram）和 span 事件：指标用于聚合统计，
   * span 事件用于在单条链路里看到 run 的结束点和关键属性（runId/duration）。
   * metricAttrs 只含可枚举维度（status/phase/errorCode），spanAttrs 额外含
   * 高基数标识（runId/sessionId/messageId）——高基数字段不能进 metric 标签，
   * 否则指标时序库会因标签组合爆炸而 OOM。
   */
  recordRun(observation: AgentRunObservation): void {
    const instruments = this.getInstruments();
    const metricAttrs = compactAttributes({
      "agent.status": observation.status,
      "agent.phase": observation.phase,
      "error.code": observation.errorCode
    });
    const spanAttrs = compactAttributes({
      ...metricAttrs,
      "agent.run_id": observation.runId,
      "agent.session_id": observation.sessionId,
      "agent.message_id": observation.messageId,
      "agent.duration_ms": observation.durationMs
    });

    instruments.runCounter.add(1, metricAttrs);
    instruments.runDuration.record(observation.durationMs, metricAttrs);
    addCurrentSpanEvent("agent.run.completed", spanAttrs);
  }

  /**
   * 记录一次 LLM 调用完成。
   *
   * metricAttrs 含 provider/model/mode：不同模型和模式的延迟差异是核心分析维度，
   * 必须分桶。iteration 只进 spanAttrs 不进 metricAttrs：它是递增的会话内序号，
   * 作为 metric 标签会产生无限维度组合。
   */
  recordLlmCall(observation: AgentLlmCallObservation): void {
    const instruments = this.getInstruments();
    const metricAttrs = compactAttributes({
      "agent.status": observation.status,
      "llm.provider": observation.provider,
      "llm.model": observation.model,
      "llm.mode": observation.mode,
      "error.code": observation.errorCode
    });
    const spanAttrs = compactAttributes({
      ...metricAttrs,
      "agent.session_id": observation.sessionId,
      "agent.message_id": observation.messageId,
      "agent.iteration": observation.iteration,
      "llm.duration_ms": observation.durationMs
    });

    instruments.llmCounter.add(1, metricAttrs);
    instruments.llmDuration.record(observation.durationMs, metricAttrs);
    addCurrentSpanEvent("agent.llm_call.completed", spanAttrs);
  }

  /**
   * 记录一次工具调用完成。
   *
   * toolName 进 metricAttrs：工具维度是工具健康度分析的核心，必须可聚合。
   * toolCallId 只进 spanAttrs：它是单次调用的唯一 ID，作为 metric 标签无意义。
   */
  recordToolCall(observation: AgentToolCallObservation): void {
    const instruments = this.getInstruments();
    const metricAttrs = compactAttributes({
      "agent.status": observation.status,
      "tool.name": observation.toolName,
      "error.code": observation.errorCode
    });
    const spanAttrs = compactAttributes({
      ...metricAttrs,
      "agent.session_id": observation.sessionId,
      "agent.message_id": observation.messageId,
      "tool.call_id": observation.toolCallId,
      "tool.duration_ms": observation.durationMs
    });

    instruments.toolCounter.add(1, metricAttrs);
    instruments.toolDuration.record(observation.durationMs, metricAttrs);
    addCurrentSpanEvent("agent.tool_call.completed", spanAttrs);
  }

  /**
   * 记录一次资源传输完成。
   *
   * bytes 只在存在时记录到 resourceTransferBytes：有些场景只关心是否成功
   * 不关心体积（如文档预览），bytes 为空时跳过 Histogram 记录避免写入 0 污染分布。
   */
  recordResourceTransfer(observation: AgentResourceTransferObservation): void {
    const instruments = this.getInstruments();
    const metricAttrs = compactAttributes({
      "agent.status": observation.status,
      "resource.type": observation.resourceType,
      "resource.mime": observation.mime,
      "error.code": observation.errorCode
    });
    const spanAttrs = compactAttributes({
      ...metricAttrs,
      "resource.bytes": observation.bytes,
      "resource.duration_ms": observation.durationMs
    });

    instruments.resourceTransferCounter.add(1, metricAttrs);
    instruments.resourceTransferDuration.record(observation.durationMs, metricAttrs);
    if (typeof observation.bytes === "number") {
      instruments.resourceTransferBytes.record(observation.bytes, metricAttrs);
    }
    addCurrentSpanEvent("agent.resource_transfer.completed", spanAttrs);
  }

  /**
   * 延迟创建并缓存指标仪器集合。
   *
   * 首次调用时从 meterFactory 或全局 getMeter 获取 meter，一次性创建所有 instrument。
   * 后续调用直接返回缓存，避免重复创建。instrument 的 description 用于后端展示指标含义。
   */
  private getInstruments(): AgentMetricInstruments {
    if (!this.instruments) {
      const meter = this.options.meterFactory?.() ?? getMeter("agent-runtime");
      this.instruments = {
        runCounter: meter.createCounter("agent_run_total", {
          description: "Agent run completions grouped by status"
        }),
        runDuration: meter.createHistogram("agent_run_duration_ms", {
          description: "Agent run execution duration in milliseconds"
        }),
        llmCounter: meter.createCounter("agent_llm_call_total", {
          description: "LLM calls made by the agent runtime"
        }),
        llmDuration: meter.createHistogram("agent_llm_call_duration_ms", {
          description: "LLM call duration in milliseconds"
        }),
        toolCounter: meter.createCounter("agent_tool_call_total", {
          description: "Tool calls made by the agent runtime"
        }),
        toolDuration: meter.createHistogram("agent_tool_call_duration_ms", {
          description: "Tool call duration in milliseconds"
        }),
        resourceTransferCounter: meter.createCounter("agent_resource_transfer_total", {
          description: "Tool resource transfers to object storage"
        }),
        resourceTransferDuration: meter.createHistogram("agent_resource_transfer_duration_ms", {
          description: "Tool resource transfer duration in milliseconds"
        }),
        resourceTransferBytes: meter.createHistogram("agent_resource_transfer_bytes", {
          description: "Tool resource transfer size in bytes"
        })
      };
    }

    return this.instruments;
  }
}

/**
 * 创建一个 AgentObservability 实例。
 *
 * 工厂函数而非直接 export class：隐藏实现类，调用方只依赖接口，
 * 未来切换实现（如换 Prometheus）时无需改调用方代码。
 */
export function createAgentObservability(options: CreateAgentObservabilityOptions = {}): AgentObservability {
  return new OtelAgentObservability(options);
}

const defaultAgentObservability = createAgentObservability();

/**
 * 获取全局默认的 AgentObservability 单例。
 *
 * 大部分调用方只需记录指标，不需要自定义 meter，直接用此单例即可。
 * 单例在模块加载时创建：此时 OTel 可能未初始化，但 instrument 延迟到首次
 * 记录时才创建（见 getInstruments），所以不会出问题。
 */
export function getAgentObservability(): AgentObservability {
  return defaultAgentObservability;
}

/**
 * 从未知错误中提取稳定的错误码字符串。
 *
 * 优先取 error.code（如 AppError 的 code），其次识别 AbortError（fetch 中断），
 * 都不匹配时返回 fallback。为什么需要统一错误码：指标维度里 error.code 是
 * 错误归因的关键，如果不归一化，同类错误会因 message 不同而散落到无数维度，
 * 无法聚合统计错误分布。
 */
export function toObservationErrorCode(error: unknown, fallback = "UNKNOWN_ERROR"): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) {
      return code;
    }
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return "ABORTED";
  }

  return fallback;
}

/**
 * 在当前 active span 上添加事件并同步属性。
 *
 * 无 active span 时静默返回：OTel 未启用时不应抛错。同时 addEvent + setAttributes：
 * event 记录「这一刻发生了什么」，attributes 让 span 本身也带上这些属性，
 * 便于在链路列表页直接看到关键信息而不用展开 event。
 */
function addCurrentSpanEvent(name: string, attributes: Attributes): void {
  const span = trace.getSpan(context.active());
  if (!span) {
    return;
  }

  span.addEvent(name, attributes);
  span.setAttributes(attributes);
}

/**
 * 过滤掉值为 undefined 的属性，返回 OTel Attributes。
 *
 * OTel 的 Attributes 类型不允许 undefined 值，但 observation 接口里很多字段是可选的。
 * 不过滤直接传会导致类型不匹配或运行时错误。用 Object.fromEntries + filter 重建对象，
 * 保证只有实际有值的字段进入 span/metric 属性。
 */
function compactAttributes(values: Record<string, string | number | boolean | undefined>): Attributes {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
  );
}
