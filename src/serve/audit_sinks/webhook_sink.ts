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

import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { AuditEvent } from "../../domain/serve_audit/audit_event.ts";
import type { AuditSink } from "../../domain/serve_audit/audit_sink.ts";
import {
  matchesSinkFilter,
  type SinkFilterConfig,
} from "../../domain/serve_audit/sink_filter.ts";
import { type CefFormatOptions, formatCefLine } from "./cef_formatter.ts";

const logger = getSwampLogger(["serve", "audit", "webhook-sink"]);

export type WebhookFormat = "json" | "cef";

export interface WebhookAuthConfig {
  readonly type: "bearer" | "basic" | "header";
  readonly value: string;
  readonly headerName?: string;
}

export interface WebhookSinkOptions {
  readonly url: string;
  readonly format?: WebhookFormat;
  readonly auth?: WebhookAuthConfig;
  readonly filter?: SinkFilterConfig;
  readonly batchSize?: number;
  readonly batchIntervalMs?: number;
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
  readonly maxPending?: number;
  readonly signal?: AbortSignal;
  readonly namespace?: string;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_BATCH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 1_000;
const DEFAULT_MAX_PENDING = 10;

export class WebhookSink implements AuditSink {
  readonly name: string;
  readonly durable = false;

  readonly #url: string;
  readonly #format: WebhookFormat;
  readonly #authHeaders: Record<string, string>;
  readonly #filter: SinkFilterConfig;
  readonly #batchSize: number;
  readonly #maxAttempts: number;
  readonly #backoffMs: number;
  readonly #maxPending: number;
  readonly #cefOptions: CefFormatOptions;

  #batch: AuditEvent[] = [];
  #pendingCount = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #closed = false;

  constructor(options: WebhookSinkOptions) {
    this.#url = options.url;
    this.#format = options.format ?? "json";
    this.#filter = options.filter ?? {};
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.#maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.name = `webhook:${new URL(options.url).hostname}`;
    this.#cefOptions = { namespace: options.namespace };

    this.#authHeaders = {};
    if (options.auth) {
      switch (options.auth.type) {
        case "bearer":
          this.#authHeaders["Authorization"] = `Bearer ${options.auth.value}`;
          break;
        case "basic":
          this.#authHeaders["Authorization"] = `Basic ${options.auth.value}`;
          break;
        case "header":
          this.#authHeaders[options.auth.headerName ?? "X-Auth-Token"] =
            options.auth.value;
          break;
      }
    }

    const intervalMs = options.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
    this.#timer = setInterval(() => {
      this.flush().catch((error: unknown) => {
        logger.warn("Periodic flush failed: {error}", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);
    Deno.unrefTimer(this.#timer);

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        this.close().catch((error: unknown) => {
          logger.warn("Shutdown flush failed: {error}", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, { once: true });
    }
  }

  async write(events: readonly AuditEvent[]): Promise<void> {
    for (const event of events) {
      if (!matchesSinkFilter(event, this.#filter)) continue;
      this.#batch.push(event);
      if (this.#batch.length >= this.#batchSize) {
        await this.#sendBatch();
      }
    }
  }

  async flush(): Promise<void> {
    if (this.#batch.length > 0) {
      await this.#sendBatch();
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.flush();
  }

  async #sendBatch(): Promise<void> {
    if (this.#closed && this.#batch.length === 0) return;

    const batch = this.#batch;
    this.#batch = [];

    if (this.#pendingCount >= this.#maxPending) {
      logger.warn(
        "Webhook sink {url} backpressure: dropping {count} event(s), {pending} batches pending",
        { url: this.#url, count: batch.length, pending: this.#pendingCount },
      );
      return;
    }

    this.#pendingCount++;
    try {
      await this.#deliverWithRetry(batch);
    } finally {
      this.#pendingCount--;
    }
  }

  async #deliverWithRetry(events: readonly AuditEvent[]): Promise<void> {
    const body = this.#formatBody(events);
    const contentType = this.#format === "cef"
      ? "text/plain; charset=utf-8"
      : "application/json";

    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      try {
        const resp = await fetch(this.#url, {
          method: "POST",
          headers: {
            "Content-Type": contentType,
            ...this.#authHeaders,
          },
          body,
          signal: AbortSignal.timeout(30_000),
        });

        if (resp.ok) return;

        const respBody = await resp.text().catch(() => "");
        logger.warn(
          "Webhook {url} delivery failed (attempt {attempt}/{max}): HTTP {status} {body}",
          {
            url: this.#url,
            attempt: attempt + 1,
            max: this.#maxAttempts,
            status: resp.status,
            body: respBody.slice(0, 200),
          },
        );
      } catch (error: unknown) {
        logger.warn(
          "Webhook {url} delivery error (attempt {attempt}/{max}): {error}",
          {
            url: this.#url,
            attempt: attempt + 1,
            max: this.#maxAttempts,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }

      if (attempt < this.#maxAttempts - 1) {
        const delay = this.#backoffMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    logger.warn(
      "Webhook {url} delivery failed after {max} attempts, dropping {count} event(s)",
      { url: this.#url, max: this.#maxAttempts, count: events.length },
    );
  }

  #formatBody(events: readonly AuditEvent[]): string {
    if (this.#format === "cef") {
      return events.map((e) => formatCefLine(e, this.#cefOptions)).join("\n") +
        "\n";
    }
    return JSON.stringify(events);
  }
}
