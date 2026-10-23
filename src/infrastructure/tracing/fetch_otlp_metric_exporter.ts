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
  PushMetricExporter,
  ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { AggregationTemporality } from "@opentelemetry/sdk-metrics";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { JsonMetricsSerializer } from "@opentelemetry/otlp-transformer";

/** Uses native fetch, like the trace exporter, including compiled-binary TLS. */
export class FetchOtlpMetricExporter implements PushMetricExporter {
  readonly #pending = new Set<Promise<void>>();
  #closed = false;
  constructor(readonly url: string, readonly headers: Record<string, string>) {}
  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE;
  }
  export(
    resource: ResourceMetrics,
    done: (result: ExportResult) => void,
  ): void {
    if (this.#closed) {
      done({ code: ExportResultCode.FAILED });
      return;
    }
    const send = this.#send(resource).then(
      () => done({ code: ExportResultCode.SUCCESS }),
      () => done({ code: ExportResultCode.FAILED }),
    );
    const pending = send.catch(() => {}).finally(() =>
      this.#pending.delete(pending)
    );
    this.#pending.add(pending);
  }
  async #send(resource: ResourceMetrics): Promise<void> {
    const body = JsonMetricsSerializer.serializeRequest(resource);
    if (!body) return;
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: body as Uint8Array<ArrayBuffer>,
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error("Metric collector rejected export");
    if (text) {
      const reply = JSON.parse(text) as {
        partialSuccess?: { rejectedDataPoints?: string | number };
      };
      if (Number(reply.partialSuccess?.rejectedDataPoints ?? 0) > 0) {
        throw new Error("Metric collector partially rejected export");
      }
    }
  }
  async forceFlush(): Promise<void> {
    await Promise.all([...this.#pending]);
  }
  async shutdown(): Promise<void> {
    this.#closed = true;
    await this.forceFlush();
  }
}
