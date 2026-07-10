/**
 * OpenTelemetry 初始化。
 *
 * 职责：在进程启动时配置 OTel NodeSDK，把 traces/metrics/logs 三类遥测数据
 * 通过 OTLP HTTP 协议导出到统一后端（Jaeger/SigNoz/Tempo 等），并注册自动埋点。
 * 边界：只负责 SDK 的创建与生命周期管理，不负责自定义指标的创建（由 getMeter 提供入口）、
 * 不负责 trace 上下文跨进程传递（由 trace-context 模块处理）。
 * 容错策略：初始化失败时只 warn 不 crash——可观测性是「锦上添花」而非核心链路，
 * 不能因为 collector 不可用就拖垮业务进程。
 */
import { metrics } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

/**
 * OTel 初始化配置。
 *
 * endpoint 是 OTLP collector 的根地址（如 http://localhost:4318），
 * 内部会自动拼接 /v1/traces、/v1/metrics、/v1/logs 三个子路径。
 * serviceName 是本服务在链路追踪中的标识，所有 span/metric 都会带上它。
 */
export interface OtelOptions {
  endpoint: string;
  serviceName: string;
}

/**
 * 获取 OTel meter，用于创建自定义指标。
 * 必须在 setupObservability 调用之后使用。
 */
export function getMeter(name = "agent-custom") {
  return metrics.getMeter(name);
}

/**
 * 初始化并启动 OTel NodeSDK，返回 SDK 实例；失败时返回 null。
 *
 * 返回 null 而非抛异常：可观测性不应阻断业务启动，调用方拿到 null 后
 * 可安全跳过后续依赖 OTel 的逻辑（getMeter 在无 SDK 时返回 noop meter）。
 * SIGTERM 时 shutdown：确保缓冲中的 span/metric 被刷出，否则进程退出会丢数据。
 * fs 和 dns 自动埋点被禁用：文件 IO 和 DNS 查询量极大，产生的 span 噪声远大于价值，
 * 且会拖慢性能。其余自动埋点（http/fastify/redis 等）保持开启。
 */
export function setupObservability(options: OtelOptions): NodeSDK | null {
  try {
    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: options.serviceName,
        [ATTR_SERVICE_VERSION]: "0.1.0"
      }),
      traceExporter: new OTLPTraceExporter({ url: `${options.endpoint}/v1/traces` }),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${options.endpoint}/v1/metrics` }),
        exportIntervalMillis: 10000
      }),
      logRecordProcessor: new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${options.endpoint}/v1/logs` })
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          "@opentelemetry/instrumentation-fs": { enabled: false },
          "@opentelemetry/instrumentation-dns": { enabled: false }
        })
      ]
    });

    sdk.start();
    process.once("SIGTERM", () => {
      void sdk.shutdown();
    });

    return sdk;
  } catch (error) {
    console.warn("[otel] setupObservability failed, observability disabled", error);
    return null;
  }
}
