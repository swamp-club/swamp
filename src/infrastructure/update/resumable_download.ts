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

import { getLogger } from "@logtape/logtape";
import { UserError } from "../../domain/errors.ts";
import {
  type DownloadOptions,
  formatBytes,
} from "../../domain/update/download_progress.ts";
import { abortableSleep, type Sleep } from "../http/rate_limit.ts";

const logger = getLogger(["swamp", "update"]);

/** How long a download may receive no bytes before the attempt is abandoned. */
export const DOWNLOAD_STALL_TIMEOUT_MS = 30_000;
/** How many attempts in a row may fail before the download gives up. */
export const DOWNLOAD_MAX_ATTEMPTS = 5;
/** Wait before each retry of a failed attempt: 2s, then 4s, 8s, 16s. */
const DOWNLOAD_RETRY_BASE_DELAY_MS = 2000;
/** The shortest gap between two progress reports. */
const PROGRESS_INTERVAL_MS = 250;

/** Options for {@link downloadToFile}. */
export interface DownloadToFileOptions extends DownloadOptions {
  /** Replaced in tests. */
  stallTimeoutMs?: number;
  maxAttempts?: number;
  sleep?: Sleep;
  now?: () => number;
  /** Makes the HTTP client for one attempt; replaced in tests. */
  createClient?: () => Deno.HttpClient;
}

/** What one attempt achieved. */
type AttemptOutcome =
  | { kind: "complete" }
  | { kind: "failed"; reason: string; progressed: boolean };

/** The part of the download that survives from one attempt to the next. */
interface DownloadState {
  readonly file: Deno.FsFile;
  receivedBytes: number;
  totalBytes: number | null;
  /** The validator the first response carried, sent back as If-Range. */
  etag: string | null;
  /** A 416 restarts from zero only once, so a broken server cannot loop. */
  restartedAfter416: boolean;
  lastProgressAt: number;
}

/** Thrown by the stall watchdog so a stall is told apart from other aborts. */
class StallError extends Error {
  constructor(ms: number) {
    super(`no data received for ${ms / 1000}s`);
    this.name = "StallError";
  }
}

/** Parses `bytes <start>-<end>/<total>`; total is null when it is `*`. */
function parseContentRange(
  header: string | null,
): { start: number; total: number | null } | null {
  const match = header?.match(/^bytes (\d+)-\d+\/(\d+|\*)$/);
  if (!match) return null;
  return {
    start: Number(match[1]),
    total: match[2] === "*" ? null : Number(match[2]),
  };
}

async function writeChunk(file: Deno.FsFile, chunk: Uint8Array): Promise<void> {
  let written = 0;
  while (written < chunk.byteLength) {
    written += await file.write(chunk.subarray(written));
  }
}

async function restartFromZero(state: DownloadState): Promise<void> {
  await state.file.truncate(0);
  await state.file.seek(0, Deno.SeekMode.Start);
  state.receivedBytes = 0;
  state.totalBytes = null;
  state.etag = null;
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Downloads `url` into `path`, reporting progress and surviving a slow or
 * flaky connection.
 *
 * - An attempt that receives no bytes for the stall timeout is abandoned.
 * - A stall, connection error, early end of body or HTTP 5xx is retried with
 *   backoff, resuming from the bytes already written with a `Range` request
 *   (guarded by `If-Range`). A server that ignores the range gets the file
 *   restarted from zero.
 * - Only attempts in a row that fail without receiving any bytes use up the
 *   retry budget. An attempt that receives bytes resets it, so a slow link
 *   that keeps moving keeps going. That includes one that trickles a few
 *   bytes inside every stall window, deliberately: progress stays visible
 *   and the caller can still cancel.
 * - Aborting `signal` stops at once with its reason, with no retry.
 * - Every attempt uses a new HTTP client and so a new connection. fetch's
 *   shared pool multiplexes HTTP/2 requests on one connection, so a retry
 *   through it would wait on the very connection that stalled.
 *
 * The caller verifies the file's checksum; a resumed download is only as
 * trustworthy as that check.
 */
export async function downloadToFile(
  url: string,
  path: string,
  options: DownloadToFileOptions = {},
): Promise<void> {
  const {
    signal,
    onRetry,
    stallTimeoutMs = DOWNLOAD_STALL_TIMEOUT_MS,
    maxAttempts = DOWNLOAD_MAX_ATTEMPTS,
    sleep = abortableSleep,
    now = Date.now,
    createClient = () => Deno.createHttpClient({}),
  } = options;

  const file = await Deno.open(path, {
    write: true,
    create: true,
    truncate: true,
  });
  try {
    const state: DownloadState = {
      file,
      receivedBytes: 0,
      totalBytes: null,
      etag: null,
      restartedAfter416: false,
      lastProgressAt: Number.NEGATIVE_INFINITY,
    };
    let failuresInARow = 0;
    while (true) {
      signal?.throwIfAborted();
      const client = createClient();
      let outcome: AttemptOutcome;
      try {
        outcome = await attempt(url, state, client, {
          ...options,
          stallTimeoutMs,
          now,
        });
      } finally {
        client.close();
      }
      if (outcome.kind === "complete") return;

      failuresInARow = outcome.progressed ? 1 : failuresInARow + 1;
      if (failuresInARow >= maxAttempts) {
        const received = state.totalBytes === null
          ? formatBytes(state.receivedBytes)
          : `${formatBytes(state.receivedBytes)} of ${
            formatBytes(state.totalBytes)
          }`;
        throw new UserError(
          `Download failed after ${failuresInARow} attempts in a row (received ${received}). Last attempt: ${outcome.reason}. Run swamp update again to retry.`,
        );
      }

      const delayMs = DOWNLOAD_RETRY_BASE_DELAY_MS * 2 ** (failuresInARow - 1);
      logger
        .debug`Download attempt failed (${outcome.reason}); retrying in ${delayMs}ms from byte ${state.receivedBytes}`;
      onRetry?.({
        attempt: failuresInARow,
        maxAttempts,
        reason: outcome.reason,
        resumeFromBytes: state.receivedBytes,
      });
      await sleep(delayMs, signal);
    }
  } finally {
    file.close();
  }
}

/** Sends one request and streams its body into the file. */
async function attempt(
  url: string,
  state: DownloadState,
  client: Deno.HttpClient,
  options: DownloadOptions & { stallTimeoutMs: number; now: () => number },
): Promise<AttemptOutcome> {
  const { signal, onProgress, stallTimeoutMs, now } = options;
  // Counted per attempt rather than compared with the starting offset, so
  // bytes received after a restart from zero still count as progress.
  let bytesThisAttempt = 0;
  const progressed = () => bytesThisAttempt > 0;

  const stall = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armStallTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => stall.abort(new StallError(stallTimeoutMs)),
      stallTimeoutMs,
    );
  };
  const fetchSignal = signal
    ? AbortSignal.any([signal, stall.signal])
    : stall.signal;

  const report = (force: boolean) => {
    const at = now();
    if (!force && at - state.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    state.lastProgressAt = at;
    onProgress?.({
      receivedBytes: state.receivedBytes,
      totalBytes: state.totalBytes,
    });
  };

  // Byte counts and Range offsets must refer to the archive itself, not a
  // compressed transfer encoding of it.
  const headers: Record<string, string> = { "accept-encoding": "identity" };
  if (state.receivedBytes > 0) {
    headers["range"] = `bytes=${state.receivedBytes}-`;
    if (state.etag) headers["if-range"] = state.etag;
  }

  armStallTimer();
  try {
    const response = await fetch(url, {
      client,
      headers,
      signal: fetchSignal,
    });

    if (response.status === 206) {
      const range = parseContentRange(response.headers.get("content-range"));
      if (!range || range.start !== state.receivedBytes) {
        await response.body?.cancel();
        await restartFromZero(state);
        return {
          kind: "failed",
          reason: "the server resumed from the wrong offset",
          progressed: false,
        };
      }
      if (range.total !== null) state.totalBytes = range.total;
    } else if (response.status === 200) {
      // A fresh full body: the server ignored the range, or If-Range told
      // it the file changed. Either way the bytes on disk are discarded.
      if (state.receivedBytes > 0) await restartFromZero(state);
      const length = Number(response.headers.get("content-length") ?? NaN);
      state.totalBytes = Number.isFinite(length) ? length : null;
      state.etag = response.headers.get("etag");
    } else if (response.status === 416 && !state.restartedAfter416) {
      await response.body?.cancel();
      state.restartedAfter416 = true;
      await restartFromZero(state);
      return {
        kind: "failed",
        reason: "the server refused to resume (HTTP 416)",
        progressed: false,
      };
    } else if (response.status >= 500) {
      await response.body?.cancel();
      return {
        kind: "failed",
        reason: `HTTP ${response.status}`,
        progressed: false,
      };
    } else {
      await response.body?.cancel();
      throw new UserError(`Failed to download update: HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new UserError("Failed to download update: empty response body");
    }

    report(true);
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armStallTimer();
      try {
        await writeChunk(state.file, value);
      } catch (error: unknown) {
        await reader.cancel().catch(() => {});
        // A full disk is not a network problem; retrying cannot help.
        throw new UserError(
          `Failed to save the update download: ${describeFailure(error)}`,
        );
      }
      state.receivedBytes += value.byteLength;
      bytesThisAttempt += value.byteLength;
      report(false);
    }

    if (state.totalBytes !== null && state.receivedBytes < state.totalBytes) {
      return {
        kind: "failed",
        reason: "the connection closed before the download finished",
        progressed: progressed(),
      };
    }
    report(true);
    return { kind: "complete" };
  } catch (error: unknown) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof UserError) throw error;
    const reason = stall.signal.aborted
      ? describeFailure(stall.signal.reason)
      : describeFailure(error);
    return { kind: "failed", reason, progressed: progressed() };
  } finally {
    clearTimeout(timer);
  }
}
