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

import type {
  LogRecordExporter,
  ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { ExportResultCode } from "@opentelemetry/core";
import type { ExportResult } from "@opentelemetry/core";
import { JsonLogsSerializer } from "@opentelemetry/otlp-transformer";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface FetchOtlpLogExporterConfig {
  /** Full URL to the OTLP logs endpoint (e.g. "https://api.honeycomb.io/v1/logs"). */
  url: string;
  /** Additional headers (e.g. auth tokens). */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds. Defaults to 10 000. */
  timeoutMs?: number;
}

/**
 * OTLP log-record exporter that uses the native `fetch` API instead of Node.js
 * `http`/`https` modules — the same approach as {@link FetchOtlpExporter} for
 * spans, which avoids Deno compiled-binary TLS issues with the Node.js
 * compatibility layer.
 *
 * All export errors are silently swallowed — telemetry must never interfere
 * with the CLI, and this exporter must never emit through swamp's logger (that
 * would recurse back into the bridge sink that feeds it).
 *
 * Unlike the span exporter, in-flight `fetch` promises are tracked so that
 * {@link forceFlush} and {@link shutdown} genuinely await them. `swamp`'s
 * shutdown path calls `LoggerProvider.shutdown()`, which awaits the
 * processor's `shutdown()`, which awaits this exporter's `shutdown()` — so the
 * last log records of a short CLI invocation are drained before `Deno.exit`,
 * rather than being cut mid-flight. (Note: `LoggerProvider.forceFlush()` does
 * not propagate to `SimpleLogRecordProcessor`'s exporter, which is why the
 * drain must live in `shutdown()` and swamp must shut the provider down, not
 * merely flush it.)
 */
export class FetchOtlpLogExporter implements LogRecordExporter {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #inFlight = new Set<Promise<void>>();
  #shutdown = false;

  constructor(config: FetchOtlpLogExporterConfig) {
    this.#url = config.url;
    this.#headers = {
      "content-type": "application/json",
      ...config.headers,
    };
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  export(
    logs: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    if (this.#shutdown) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }

    const pending = this.#send(logs).then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      () => resultCallback({ code: ExportResultCode.FAILED }),
    );
    // Track the in-flight send so forceFlush()/shutdown() can drain it, and
    // remove it once settled to bound the set's size.
    const tracked = pending.finally(() => {
      this.#inFlight.delete(tracked);
    });
    this.#inFlight.add(tracked);
  }

  /** Awaits every in-flight send so no records are lost on flush. */
  forceFlush(): Promise<void> {
    return Promise.all([...this.#inFlight]).then(() => {});
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true;
    // Drain in-flight sends before resolving — this is the path swamp relies
    // on (LoggerProvider.shutdown -> processor.shutdown -> here).
    await this.forceFlush();
  }

  async #send(logs: ReadableLogRecord[]): Promise<void> {
    const body = JsonLogsSerializer.serializeRequest(logs);
    if (!body) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await fetch(this.#url, {
        method: "POST",
        headers: this.#headers,
        body: body.buffer as ArrayBuffer,
        signal: controller.signal,
      });

      if (!response.ok) {
        // Drain the body to avoid resource leaks, but don't throw.
        await response.arrayBuffer();
      } else {
        await response.body?.cancel();
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
