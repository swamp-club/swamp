// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import type { LoggerProvider } from "@opentelemetry/api-logs";
import type {
  LogRecordExporter,
  ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { ExportResultCode } from "@opentelemetry/core";
import type { ExportResult } from "@opentelemetry/core";
// Static import is deliberate: otel_config.ts is a tiny leaf with no SDK deps,
// so it costs nothing eagerly.
import { parseOtlpHeaders, resolveOtlpEndpoint } from "./otel_config.ts";

let providerRef:
  | (LoggerProvider & { shutdown(): Promise<void> })
  | undefined;

/**
 * debug-only exporter writing to stderr, never stdout, which carries --json
 * output and worker RPC frames
 */
class StderrLogRecordExporter implements LogRecordExporter {
  readonly #encoder = new TextEncoder();

  export(
    logs: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    for (const log of logs) {
      const line = JSON.stringify({
        severity: log.severityText,
        body: log.body,
        traceId: log.spanContext?.traceId,
        spanId: log.spanContext?.spanId,
        attributes: log.attributes,
      });
      Deno.stderr.writeSync(this.#encoder.encode(line + "\n"));
    }
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * test-only config bypassing Deno.env, to avoid races on the process-wide env
 * when OTel test files run in parallel
 */
export interface InitLogsConfig {
  endpoint?: string;
  exporterKind?: string;
  useBatch?: boolean;
}

export async function initLogs(
  config?: InitLogsConfig,
): Promise<LoggerProvider | undefined> {
  // idempotent: return the live provider rather than building and leaking a
  // second one
  if (providerRef) {
    return providerRef;
  }

  const endpoint = config?.endpoint !== undefined
    ? resolveOtlpEndpoint("logs", { genericEndpoint: config.endpoint })
    : resolveOtlpEndpoint("logs");
  const exporterKind = config?.exporterKind ??
    Deno.env.get("OTEL_LOGS_EXPORTER") ?? "otlp";

  if (exporterKind === "none") {
    return undefined;
  }
  if (!endpoint && exporterKind !== "console") {
    return undefined;
  }

  const [
    { LoggerProvider, BatchLogRecordProcessor, SimpleLogRecordProcessor },
    { Resource, envDetectorSync },
    { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
    { buildOtelResource },
  ] = await Promise.all([
    import("@opentelemetry/sdk-logs"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
    import("./otel_resource.ts"),
  ]);

  const resource = buildOtelResource(Resource, envDetectorSync, {
    serviceNameAttr: ATTR_SERVICE_NAME,
    serviceVersionAttr: ATTR_SERVICE_VERSION,
  });

  let exporter: LogRecordExporter;
  if (exporterKind === "console") {
    exporter = new StderrLogRecordExporter();
  } else {
    const { FetchOtlpLogExporter } = await import(
      "./fetch_otlp_log_exporter.ts"
    );
    exporter = new FetchOtlpLogExporter({
      url: endpoint!,
      headers: parseOtlpHeaders("logs"),
    });
  }

  const useBatch = config?.useBatch ??
    Deno.env.get("OTEL_BLRP_USE") === "1";
  const processor = useBatch
    ? new BatchLogRecordProcessor(exporter)
    : new SimpleLogRecordProcessor(exporter);

  const provider = new LoggerProvider({ resource });
  provider.addLogRecordProcessor(processor);

  // Assign the module-scope ref only after all fallible construction has
  // succeeded, so a throw above leaves no orphaned provider for shutdownLogs().
  providerRef = provider;
  return provider;
}

/**
 * must call provider.shutdown(), not forceFlush(): only shutdown reaches the
 * exporter's drain of in-flight sends
 */
export async function shutdownLogs(): Promise<void> {
  if (providerRef) {
    try {
      await providerRef.shutdown();
    } catch {
      // Silently swallow shutdown errors — telemetry must never block the CLI.
    }
    providerRef = undefined;
  }
}
