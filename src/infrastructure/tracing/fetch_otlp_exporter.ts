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
import { metrics } from "@opentelemetry/api";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface FetchOtlpExporterConfig {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * uses native fetch to avoid Deno compiled-binary TLS issues with Node http;
 * export errors are swallowed so tracing never interferes with the CLI
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

    const accounting = metrics.getMeter("swamp.execution", "1").createCounter(
      "swamp.export.spans",
      { unit: "{span}" },
    );
    accounting.add(spans.length, { outcome: "attempted" });
    const pending = this.#send(spans).then(
      () => {
        accounting.add(spans.length, { outcome: "collector_acknowledged" });
        resultCallback({ code: ExportResultCode.SUCCESS });
      },
      () => {
        accounting.add(spans.length, { outcome: "not_fully_acknowledged" });
        resultCallback({ code: ExportResultCode.FAILED });
      },
    );
    // track the in-flight send so forceFlush and shutdown can drain it; the
    // callback may throw, which tracing must never surface
    const tracked = pending.catch(() => {}).finally(() => {
      this.#inFlight.delete(tracked);
    });
    this.#inFlight.add(tracked);
  }

  /**
   * drains in-flight sends: SimpleSpanProcessor does not track its exports, so
   * without this Deno.exit cuts the last span mid-send
   */
  async shutdown(): Promise<void> {
    this.#shutdown = true;
    await this.forceFlush();
  }

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

      const text = await response.text();
      if (!response.ok) throw new Error("Trace collector rejected export");
      if (text) {
        const reply = JSON.parse(text) as {
          partialSuccess?: { rejectedSpans?: string | number };
        };
        if (Number(reply.partialSuccess?.rejectedSpans ?? 0) > 0) {
          throw new Error("Trace collector partially rejected export");
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
