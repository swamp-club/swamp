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
import type { TelemetrySender } from "../domain/telemetry/telemetry_sender.ts";
import { globalTelemetryDir } from "../infrastructure/persistence/paths.ts";
import { HttpTelemetrySender } from "../infrastructure/telemetry/http_telemetry_sender.ts";
import {
  type SenderOptions,
  startTelemetrySender,
} from "../infrastructure/telemetry/telemetry_sender_process.ts";
import { USER_AGENT } from "./load_identity.ts";
import type { TelemetryContext } from "./telemetry_integration.ts";

const logger = getLogger(["swamp", "cli"]);

export interface EndOfCommandTelemetryDeps {
  readonly os?: typeof Deno.build.os;
  readonly startSender?: (
    telemetryDir: string,
    options: SenderOptions,
  ) => Promise<boolean>;
  readonly sender?: TelemetrySender;
}

// Windows keeps the awaited send: its detached processes are untested
export async function sendTelemetryAtCommandEnd(
  ctx: TelemetryContext,
  options: { readonly succeeded: boolean },
  deps: EndOfCommandTelemetryDeps = {},
): Promise<void> {
  if ((deps.os ?? Deno.build.os) === "windows") {
    await sendAwaited(ctx, options.succeeded, deps.sender);
    return;
  }
  try {
    if (!await ctx.service.hasUnflushed()) return;
    await (deps.startSender ?? startTelemetrySender)(globalTelemetryDir(), {
      endpoint: ctx.telemetryEndpoint,
      userAgent: USER_AGENT,
      ...(ctx.repoId !== undefined ? { repoId: ctx.repoId } : {}),
      keepFlushed: ctx.keepFlushed,
    });
  } catch {
    // Best effort: the entry stays spooled for the next command's sender.
  }
}

async function sendAwaited(
  ctx: TelemetryContext,
  succeeded: boolean,
  injected: TelemetrySender | undefined,
): Promise<void> {
  // distinct_id is required by the sender; if neither userId nor repoId
  // resolved, skip the flush and leave the entry spooled for a future run
  const distinctId = ctx.userId ?? ctx.repoId;
  if (distinctId) {
    const flushResult = await ctx.service.flushTelemetry({
      sender: injected ??
        new HttpTelemetrySender(ctx.telemetryEndpoint, USER_AGENT),
      distinctId,
      repoId: ctx.repoId,
      authToken: ctx.authToken ?? undefined,
      keepFlushed: ctx.keepFlushed,
      signal: AbortSignal.timeout(2000),
    });
    if (succeeded && !flushResult.result.ok) {
      const detail = flushResult.result.reason
        ? ` (${flushResult.result.reason})`
        : "";
      logger.warn(
        `Telemetry flush failed${detail} — entries are queued locally and will retry on the next invocation`,
      );
    }
  }
  if (!succeeded) return;
  // Cleanup with bounded timeout so Deno.exit() doesn't kill it
  await Promise.race([
    ctx.service.cleanupOldTelemetry(),
    new Promise<void>((r) => setTimeout(r, 3000)),
  ]);
}
