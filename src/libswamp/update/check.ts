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

import type { Platform } from "../../domain/update/platform.ts";
import type {
  DownloadOptions,
  DownloadProgress,
  DownloadRetry,
} from "../../domain/update/download_progress.ts";
import {
  type UpdateResult,
  UpdateService,
} from "../../domain/update/update_service.ts";
import {
  HttpUpdateChecker,
  type HttpUpdateCheckerOptions,
} from "../../infrastructure/update/http_update_checker.ts";
import type { LibSwampContext } from "../context.ts";
import { cancelled, type SwampError } from "../errors.ts";
import { AsyncQueue } from "../stream/async_queue.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the update check/install output.
 */
export type UpdateCheckData = UpdateResult;

export type UpdateCheckEvent =
  | { kind: "checking" }
  | { kind: "download_progress"; data: DownloadProgress }
  | { kind: "download_retrying"; data: DownloadRetry }
  | { kind: "completed"; data: UpdateCheckData }
  | { kind: "error"; error: SwampError };

/** Input for the update check/install operation. */
export interface UpdateCheckInput {
  checkOnly: boolean;
  platform: Platform;
}

/** Dependencies for the update check/install operation. */
export interface UpdateCheckDeps {
  check: (platform: Platform, signal?: AbortSignal) => Promise<UpdateResult>;
  update: (
    platform: Platform,
    options?: DownloadOptions,
  ) => Promise<UpdateResult>;
}

/**
 * How many times `swamp update` sends its update-check request before
 * giving up (swamp-club#3428). The check after every other command makes
 * one attempt so it never slows them down.
 */
export const UPDATE_CHECK_MAX_ATTEMPTS = 3;

/**
 * Wires real infrastructure into UpdateCheckDeps. `checkerOptions`
 * overrides the checker's settings; tests pass a no-op `sleep`.
 */
export function createUpdateCheckDeps(
  currentVersion: string,
  binaryPath: string,
  checkerOptions: HttpUpdateCheckerOptions = {},
): UpdateCheckDeps {
  const checker = new HttpUpdateChecker({
    maxAttempts: UPDATE_CHECK_MAX_ATTEMPTS,
    ...checkerOptions,
  });
  const service = new UpdateService(checker, currentVersion, binaryPath);
  return {
    check: (platform, signal) => service.check(platform, signal),
    update: (platform, options) => service.update(platform, options),
  };
}

/**
 * Checks for or installs updates. While installing, it streams the
 * download's progress and retries. Aborting `ctx.signal` ends the stream with
 * a `cancelled` error; the installed binary is untouched.
 */
export async function* updateCheck(
  ctx: LibSwampContext,
  deps: UpdateCheckDeps,
  input: UpdateCheckInput,
): AsyncIterable<UpdateCheckEvent> {
  yield* withGeneratorSpan(
    "swamp.update.check",
    {},
    (async function* () {
      ctx.logger.debug`Checking for updates (checkOnly=${input.checkOnly})`;

      yield { kind: "checking" };

      try {
        const result = input.checkOnly
          ? await deps.check(input.platform, ctx.signal)
          : yield* streamUpdate(ctx, deps, input.platform);
        yield { kind: "completed", data: result };
      } catch (error: unknown) {
        if (ctx.signal.aborted) {
          yield {
            kind: "error",
            error: cancelled(error instanceof Error ? error : undefined),
          };
          return;
        }
        throw error;
      }
    })(),
  );
}

/**
 * Runs the update, yielding its download events as they happen, and returns
 * its result.
 */
async function* streamUpdate(
  ctx: LibSwampContext,
  deps: UpdateCheckDeps,
  platform: Platform,
): AsyncGenerator<UpdateCheckEvent, UpdateResult> {
  const queue = new AsyncQueue<UpdateCheckEvent>();
  // Settles to an outcome rather than rejecting, so a failure while events
  // are still being yielded is never an unhandled rejection.
  const outcome = deps.update(platform, {
    signal: ctx.signal,
    onProgress: (data) => queue.push({ kind: "download_progress", data }),
    onRetry: (data) => queue.push({ kind: "download_retrying", data }),
  }).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  ).finally(() => queue.close());

  yield* queue;
  const settled = await outcome;
  if (!settled.ok) throw settled.error;
  return settled.result;
}
