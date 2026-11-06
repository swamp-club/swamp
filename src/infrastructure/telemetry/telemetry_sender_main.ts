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

import { join } from "@std/path";
import { TelemetryService } from "../../domain/telemetry/telemetry_service.ts";
import type { TelemetrySender } from "../../domain/telemetry/telemetry_sender.ts";
import { AuthRepository } from "../persistence/auth_repository.ts";
import { JsonTelemetryFlushRecordRepository } from "../persistence/json_telemetry_flush_record_repository.ts";
import { JsonTelemetryRepository } from "../persistence/json_telemetry_repository.ts";
import { globalTelemetryDir } from "../persistence/paths.ts";
import { UserIdentityRepository } from "../persistence/user_identity_repository.ts";
import { HttpTelemetrySender } from "./http_telemetry_sender.ts";
import {
  drainTelemetrySpool,
  heartbeatSenderLock,
  parseSenderArgs,
  releaseSenderLock,
  SENDER_LOCK_FILE,
} from "./telemetry_sender_process.ts";

export interface SenderMainDeps {
  readonly telemetryDir?: string;
  readonly sender?: (endpoint: string, userAgent: string) => TelemetrySender;
  readonly userId?: () => Promise<string | null>;
  readonly authToken?: () => Promise<string | undefined>;
  readonly requestTimeoutMs?: number;
}

async function loadAuthToken(): Promise<string | undefined> {
  try {
    return (await new AuthRepository().load())?.apiKey ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * the detached sender's whole run: it drains the spool under the lock its
 * starter claimed, then cleans the spool; best effort, so it always exits 0
 */
export async function runTelemetrySenderMain(
  args: readonly string[],
  deps: SenderMainDeps = {},
): Promise<number> {
  const options = parseSenderArgs(args);
  if (options === undefined) return 0;
  const dir = deps.telemetryDir ?? globalTelemetryDir();
  const lockPath = join(dir, SENDER_LOCK_FILE);
  try {
    if (!await heartbeatSenderLock(lockPath, options.token)) return 0;
    const service = new TelemetryService(
      new JsonTelemetryRepository(dir, dir),
      "",
      undefined,
      undefined,
      undefined,
      undefined,
      options.endpoint,
      new JsonTelemetryFlushRecordRepository(dir),
    );
    const userId = await (deps.userId ??
      (() => new UserIdentityRepository().getUserId()))();
    // distinct_id is required by the ingest; without one entries stay spooled
    const distinctId = userId ?? options.repoId;
    if (distinctId !== undefined) {
      const authToken = await (deps.authToken ?? loadAuthToken)();
      await drainTelemetrySpool({
        service,
        sender: (deps.sender ??
          ((endpoint, userAgent) =>
            new HttpTelemetrySender(endpoint, userAgent)))(
            options.endpoint,
            options.userAgent,
          ),
        distinctId,
        ...(options.repoId !== undefined ? { repoId: options.repoId } : {}),
        ...(authToken !== undefined ? { authToken } : {}),
        keepFlushed: options.keepFlushed,
        heartbeat: () => heartbeatSenderLock(lockPath, options.token),
        ...(deps.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: deps.requestTimeoutMs }
          : {}),
      });
    }
    await service.cleanupOldTelemetry();
  } catch {
    // Best effort: entries stay spooled for the next sender.
  } finally {
    await releaseSenderLock(lockPath, options.token).catch(() => {});
  }
  return 0;
}
