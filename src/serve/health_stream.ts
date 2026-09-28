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

import type { HealthSnapshot } from "./health_collector.ts";

export const DEFAULT_HEALTH_STREAM_INTERVAL_MS = 5000;
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 60000;

/** Seconds a client refused at the stream cap should wait before retrying. */
export const HEALTH_STREAM_CAP_RETRY_AFTER_SECONDS = 30;

/** Ends a stream from the server side, telling the client why. */
export interface HealthStreamCloser {
  close(code: number, reason: string): void;
}

export interface HealthStreamOptions {
  collect(signal: AbortSignal): Promise<HealthSnapshot>;
  /** The raw `interval` query parameter, or null when absent. */
  intervalParam: string | null;
  /** The raw `Last-Event-ID` header, or null when absent. */
  lastEventId: string | null;
  /** Aborted when serve shuts down. */
  serverSignal: AbortSignal;
  /** Aborted when the client disconnects. */
  requestSignal: AbortSignal;
  /**
   * Binds the stream to its token session so revocation can end it. Returns
   * the unregister function, or null when the token is at its stream cap.
   * Omitted when there is no token (auth mode none).
   */
  registerSession?(closer: HealthStreamCloser): (() => void) | null;
}

/** Parses the `interval` query parameter, clamped to 1–60 s. */
export function healthStreamInterval(param: string | null): number {
  if (param === null) return DEFAULT_HEALTH_STREAM_INTERVAL_MS;
  const parsed = parseInt(param, 10);
  if (isNaN(parsed)) return DEFAULT_HEALTH_STREAM_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, parsed));
}

/**
 * Builds the SSE response for `/api/v1/health/stream`: a `health` event with
 * a fresh snapshot every interval, resumable by event id. When the server ends
 * the stream's session it sends a final `session-ended` event carrying the
 * close code and reason. A token at its stream cap gets 429 and no collection
 * runs.
 */
export function createHealthStreamResponse(
  options: HealthStreamOptions,
): Response {
  const intervalMs = healthStreamInterval(options.intervalParam);
  let eventId = options.lastEventId !== null
    ? parseInt(options.lastEventId, 10) || 0
    : 0;

  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let stopped = false;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let unregister: (() => void) | null = null;

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    options.serverSignal.removeEventListener("abort", cleanup);
    options.requestSignal.removeEventListener("abort", cleanup);
    unregister?.();
    try {
      controller?.close();
    } catch {
      // Already closed
    }
  };

  if (options.registerSession) {
    unregister = options.registerSession({
      close(code, reason) {
        if (stopped) return;
        try {
          controller?.enqueue(
            encoder.encode(
              `event: session-ended\ndata: ${
                JSON.stringify({ code, reason })
              }\n\n`,
            ),
          );
        } catch {
          // The client already went away
        }
        cleanup();
      },
    });
    if (unregister === null) {
      return new Response("Too Many Requests: health stream limit reached", {
        status: 429,
        headers: {
          "Retry-After": String(HEALTH_STREAM_CAP_RETRY_AFTER_SECONDS),
        },
      });
    }
  }

  const push = async () => {
    if (stopped) return;
    try {
      const snapshot = await options.collect(options.serverSignal);
      if (stopped) return;
      eventId++;
      const event = `id: ${eventId}\nevent: health\ndata: ${
        JSON.stringify(snapshot)
      }\n\n`;
      controller?.enqueue(encoder.encode(event));
    } catch {
      // Collection failed — skip this tick
    }
    if (!stopped) {
      pendingTimer = setTimeout(push, intervalMs);
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      controller = c;
      options.serverSignal.addEventListener("abort", cleanup, { once: true });
      options.requestSignal.addEventListener("abort", cleanup, { once: true });
      if (options.serverSignal.aborted || options.requestSignal.aborted) {
        cleanup();
        return;
      }
      await push();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
      "x-health-interval": String(intervalMs),
    },
  });
}
