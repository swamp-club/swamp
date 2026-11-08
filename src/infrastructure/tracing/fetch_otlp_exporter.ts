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
import {
  type ExportOutcome,
  type ExportQueueLimits,
  OtlpExportQueue,
} from "./otlp_export_queue.ts";

const DEFAULT_TIMEOUT_MS = 10_000;

const ACCOUNTED_OUTCOME: Record<ExportOutcome, string> = {
  attempted: "attempted",
  acknowledged: "collector_acknowledged",
  failed: "not_fully_acknowledged",
  dropped: "dropped",
};

export interface FetchOtlpExporterConfig {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  limits?: ExportQueueLimits;
}

/**
 * uses native fetch to avoid Deno compiled-binary TLS issues with Node http;
 * export errors are swallowed so tracing never interferes with the CLI
 */
export class FetchOtlpExporter implements SpanExporter {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #queue: OtlpExportQueue<ReadableSpan>;

  constructor(config: FetchOtlpExporterConfig) {
    this.#url = config.url;
    this.#headers = {
      "content-type": "application/json",
      ...config.headers,
    };
    this.#queue = new OtlpExportQueue<ReadableSpan>({
      ...config.limits,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      send: (spans, signal) => this.#send(spans, signal),
      onOutcome: (count, outcome) => {
        metrics.getMeter("swamp.execution", "1").createCounter(
          "swamp.export.spans",
          { unit: "{span}" },
        ).add(count, { outcome: ACCOUNTED_OUTCOME[outcome] });
      },
    });
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    this.#queue.enqueue(spans, (ok) => {
      resultCallback({
        code: ok ? ExportResultCode.SUCCESS : ExportResultCode.FAILED,
      });
    });
  }

  /**
   * drains queued sends within the exit bound: SimpleSpanProcessor does not
   * track its exports, so without this Deno.exit cuts the last span mid-send
   */
  shutdown(): Promise<void> {
    return this.#queue.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.#queue.forceFlush();
  }

  async #send(
    spans: readonly ReadableSpan[],
    signal: AbortSignal,
  ): Promise<void> {
    const body = JsonTraceSerializer.serializeRequest([...spans]);
    if (!body) return;

    const response = await fetch(this.#url, {
      method: "POST",
      headers: this.#headers,
      body: body.buffer as ArrayBuffer,
      signal,
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
  }
}
