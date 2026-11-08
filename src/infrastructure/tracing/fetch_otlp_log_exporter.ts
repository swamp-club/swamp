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
import {
  type ExportQueueLimits,
  OtlpExportQueue,
} from "./otlp_export_queue.ts";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface FetchOtlpLogExporterConfig {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  limits?: ExportQueueLimits;
}

/**
 * native fetch like the span exporter; errors are swallowed and never logged
 * through swamp's logger, which would recurse into the bridge sink feeding it
 */
export class FetchOtlpLogExporter implements LogRecordExporter {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #queue: OtlpExportQueue<ReadableLogRecord>;

  constructor(config: FetchOtlpLogExporterConfig) {
    this.#url = config.url;
    this.#headers = {
      "content-type": "application/json",
      ...config.headers,
    };
    this.#queue = new OtlpExportQueue<ReadableLogRecord>({
      ...config.limits,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      send: (logs, signal) => this.#send(logs, signal),
    });
  }

  export(
    logs: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    this.#queue.enqueue(logs, (ok) => {
      resultCallback({
        code: ok ? ExportResultCode.SUCCESS : ExportResultCode.FAILED,
      });
    });
  }

  forceFlush(): Promise<void> {
    return this.#queue.forceFlush();
  }

  /**
   * drains queued sends within the exit bound here: LoggerProvider.forceFlush
   * does not reach the processor's exporter, only shutdown does
   */
  shutdown(): Promise<void> {
    return this.#queue.shutdown();
  }

  async #send(
    logs: readonly ReadableLogRecord[],
    signal: AbortSignal,
  ): Promise<void> {
    const body = JsonLogsSerializer.serializeRequest([...logs]);
    if (!body) return;

    const response = await fetch(this.#url, {
      method: "POST",
      headers: this.#headers,
      body: body.buffer as ArrayBuffer,
      signal,
    });

    if (!response.ok) {
      await response.arrayBuffer();
    } else {
      await response.body?.cancel();
    }
  }
}
