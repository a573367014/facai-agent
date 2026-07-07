import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

export interface OtelOptions {
  endpoint: string;
  serviceName: string;
}

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
