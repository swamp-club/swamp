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

import { isProcessAlive } from "./process_kill.ts";
import type { StartServerRecord } from "../persistence/start_server_record.ts";

/** How long the ping to a recorded server may take. */
export const START_PROBE_TIMEOUT_MS = 2_000;

/**
 * How long the ping may take on Windows. Windows retries a refused
 * loopback connect for about two seconds before it reports the refusal, so
 * the default timeout would turn every closed port into `unknown`.
 */
export const WINDOWS_START_PROBE_TIMEOUT_MS = 5_000;

/** The ping timeout for a probe running on `os`. */
export function startProbeTimeoutMs(os: typeof Deno.build.os): number {
  return os === "windows"
    ? WINDOWS_START_PROBE_TIMEOUT_MS
    : START_PROBE_TIMEOUT_MS;
}

/** The header carrying the recorded token on a `/start/ping` request. */
export const START_PING_TOKEN_HEADER = "x-swamp-start-token";

/**
 * What a probe learned about a recorded server:
 * - `live`: it answered the ping with its token.
 * - `dead`: its process is gone, nothing listens on its port, or something
 *   else answers there.
 * - `unknown`: the ping timed out or failed some other way; the record may
 *   still belong to a live server.
 */
export type StartServerLiveness = "live" | "dead" | "unknown";

export interface StartProbeOptions {
  readonly timeoutMs?: number;
  /** The OS the probe runs on; tests override it. */
  readonly os?: typeof Deno.build.os;
}

function isConnectionRefused(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof Deno.errors.ConnectionRefused) return true;
    if (/connection refused|actively refused/i.test(current.message)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Asks a recorded `swamp start` server whether it is still there, through
 * its `/start/ping` endpoint. The ping does not count as a page, so probing
 * never keeps another server from ending. Off Windows a record whose
 * process is gone is dead without a ping.
 */
export async function probeStartServer(
  record: StartServerRecord,
  options: StartProbeOptions = {},
): Promise<StartServerLiveness> {
  const os = options.os ?? Deno.build.os;
  if (os !== "windows" && !isProcessAlive(record.pid)) return "dead";
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${record.port}/start/ping`, {
      headers: { [START_PING_TOKEN_HEADER]: record.token },
      signal: AbortSignal.timeout(
        options.timeoutMs ?? startProbeTimeoutMs(os),
      ),
    });
  } catch (error) {
    return isConnectionRefused(error) ? "dead" : "unknown";
  }
  try {
    await response.body?.cancel();
  } catch {
    // The status is all the probe needs.
  }
  return response.status === 204 ? "live" : "dead";
}
