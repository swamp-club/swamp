// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

    this.#send(spans).then(
      () => resultCallback({ code: ExportResultCode.SUCCESS }),
      () => resultCallback({ code: ExportResultCode.FAILED }),
    );
  }

  shutdown(): Promise<void> {
    this.#shutdown = true;
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    // Nothing to flush — each export sends immediately via fetch.
    return Promise.resolve();
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
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
