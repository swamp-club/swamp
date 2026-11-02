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
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * native fetch like the span exporter; errors are swallowed and never logged
 * through swamp's logger, which would recurse into the bridge sink feeding it
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
    const tracked = pending.finally(() => {
      this.#inFlight.delete(tracked);
    });
    this.#inFlight.add(tracked);
  }

  forceFlush(): Promise<void> {
    return Promise.all([...this.#inFlight]).then(() => {});
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true;
    // drain in-flight sends here: LoggerProvider.forceFlush does not reach the
    // processor's exporter, only shutdown does
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
        await response.arrayBuffer();
      } else {
        await response.body?.cancel();
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
