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

import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode } from "@opentelemetry/core";
import type { ExportResult } from "@opentelemetry/core";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface FetchOtlpExporterConfig {
  /** Full URL to the OTLP traces endpoint (e.g. "https://api.honeycomb.io/v1/traces"). */
  url: string;
  /** Additional headers (e.g. auth tokens). */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds. Defaults to 10 000. */
  timeoutMs?: number;
}

/**
 * OTLP span exporter that uses the native `fetch` API instead of Node.js
 * `http`/`https` modules. This avoids Deno compiled-binary TLS issues with
 * the Node.js compatibility layer.
 *
 * All export errors are silently swallowed — tracing should never interfere
 * with the CLI.
 */
export class FetchOtlpExporter implements SpanExporter {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #inFlight = new Set<Promise<void>>();
  #shutdown = false;

  constructor(config: FetchOtlpExporterConfig) {
    this.#url = config.url;
    this.#headers = {
      "content-type": "application/json",
      ...config.headers,
    };
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    if (this.#shutdown) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }

    const pending = this.#send(spans).then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      () => resultCallback({ code: ExportResultCode.FAILED }),
    );
    // Track the in-flight send so forceFlush()/shutdown() can drain it, and
    // remove it once settled to bound the set's size. `pending` rejects only
    // if resultCallback throws; tracing must never surface that.
    const tracked = pending.catch(() => {}).finally(() => {
      this.#inFlight.delete(tracked);
    });
    this.#inFlight.add(tracked);
  }

  /**
   * Drains in-flight sends before resolving. SimpleSpanProcessor does not
   * track the exports it starts, so without this the last span a process
   * ends — its `swamp.cli` root — is cut mid-send by `Deno.exit`
   * (swamp-club#2467). `swamp` relies on the path
   * TracerProvider.shutdown -> processor.shutdown -> here.
   */
  async shutdown(): Promise<void> {
    this.#shutdown = true;
    await this.forceFlush();
  }

  /** Awaits every in-flight send so no spans are lost on flush. */
  forceFlush(): Promise<void> {
    return Promise.all([...this.#inFlight]).then(() => {});
  }

  async #send(spans: ReadableSpan[]): Promise<void> {
    const body = JsonTraceSerializer.serializeRequest(spans);
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
