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
// so it costs nothing eagerly. (otel_init.ts imports it dynamically only because
// it already batches all its SDK imports inside the function body.)
import { parseOtlpHeaders } from "./otel_config.ts";

/**
 * Handle to the provider so we can flush on shutdown and short-circuit a
 * repeat {@link initLogs} call (returning the live provider rather than leaking
 * a second one). The concrete SDK provider is both a {@link LoggerProvider} and
 * carries `shutdown()`.
 */
let providerRef:
  | (LoggerProvider & { shutdown(): Promise<void> })
  | undefined;

/**
 * Debug-only log exporter that writes each record to **stderr**. Used for
 * `OTEL_LOGS_EXPORTER=console`. Stderr — never stdout — because stdout carries
 * `--json` output and worker RPC frames, which console log output would corrupt.
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
 * Test-only configuration that bypasses `Deno.env` for OTel logs setup.
 * Production callers omit this — `initLogs` reads env vars by default.
 * Tests pass config directly to avoid races on the process-wide `Deno.env`
 * when `deno test --parallel` runs multiple OTel test files concurrently.
 */
export interface InitLogsConfig {
  endpoint?: string;
  exporterKind?: string;
  useBatch?: boolean;
}

/**
 * Initializes the OpenTelemetry **logs** signal, mirroring
 * {@link initTracing}. Returns the {@link LoggerProvider} so the logging layer
 * can build a LogTape sink from it (the bridge sink lives in the logging module
 * and is given this provider by injection — this module never imports logging,
 * so no import cycle forms). Returns `undefined` when logs export is disabled.
 *
 * Enabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is set and `OTEL_LOGS_EXPORTER` is
 * not `none`, OR when `OTEL_LOGS_EXPORTER` is `console`. All SDK packages are
 * dynamically imported so they impose zero cost when logs export is disabled.
 *
 * Records are exported through a {@link SimpleLogRecordProcessor} by default
 * (per-record flush, predictable for short CLI runs); set `OTEL_BLRP_USE=1` for
 * a {@link BatchLogRecordProcessor}, which suits high-volume `swamp serve`.
 */
export async function initLogs(
  config?: InitLogsConfig,
): Promise<LoggerProvider | undefined> {
  // Idempotent: if logs export is already initialized, return the live provider
  // rather than building (and leaking) a second one. The only production caller
  // (initializeLogging) is already once-per-process, but initLogs is exported,
  // so this keeps the contract self-enforcing for any future caller.
  if (providerRef) {
    return providerRef;
  }

  const endpoint = config?.endpoint ??
    Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT");
  const exporterKind = config?.exporterKind ??
    Deno.env.get("OTEL_LOGS_EXPORTER") ?? "otlp";

  if (exporterKind === "none") {
    // Explicit opt-out — traces may still be on, but logs stay off.
    return undefined;
  }
  if (!endpoint && exporterKind !== "console") {
    // No endpoint configured and not console mode — logs export stays disabled.
    return undefined;
  }

  // Dynamic imports — only loaded when logs export is actually enabled.
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
    // Fetch-based OTLP/HTTP exporter — native fetch, like the span exporter.
    const { FetchOtlpLogExporter } = await import(
      "./fetch_otlp_log_exporter.ts"
    );
    exporter = new FetchOtlpLogExporter({
      url: `${endpoint!.replace(/\/+$/, "")}/v1/logs`,
      headers: parseOtlpHeaders(),
    });
  }

  // Short-lived CLI invocations flush per-record; long-running `swamp serve`
  // can opt into batching via OTEL_BLRP_USE=1 (mirrors OTEL_BSP_USE for spans).
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
 * Flushes pending log records and shuts down the logger provider.
 *
 * MUST call `provider.shutdown()` (not `forceFlush()`): only `shutdown()`
 * propagates to the exporter's own `shutdown()`, which drains its in-flight
 * `fetch` sends — `LoggerProvider.forceFlush()` does not reach the exporter for
 * a `SimpleLogRecordProcessor`. No-op when logs export was not initialized.
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
