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
import type { HubRecord } from "../persistence/hub_record.ts";
import { HubAdminClient } from "../http/hub_admin_client.ts";
import { startProbeTimeoutMs } from "./start_instance_probe.ts";

/**
 * live: the hub named by the record answered with its admin token. dead:
 * gone or something else answers. unknown: no answer in time.
 */
export type HubLiveness = "live" | "dead" | "unknown";

export interface HubProbeOptions {
  readonly timeoutMs?: number;
  readonly os?: typeof Deno.build.os;
}

export async function probeHub(
  record: HubRecord,
  options: HubProbeOptions = {},
): Promise<HubLiveness> {
  const os = options.os ?? Deno.build.os;
  if (os !== "windows" && !isProcessAlive(record.pid)) return "dead";
  try {
    const ping = await new HubAdminClient(record.port, record.adminToken)
      .ping(options.timeoutMs ?? startProbeTimeoutMs(os));
    // A recycled port answering with another hub's record is not this one.
    return ping.pid === record.pid ? "live" : "dead";
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return "unknown";
    }
    return "dead";
  }
}

/**
 * Whether a running hub runs this swamp: the same engine executable, and the
 * same build of it when the build is stamped.
 */
export function hubRunsEngine(
  record: Pick<HubRecord, "engine" | "engineGitSha">,
  engine: string,
  gitSha: string,
): boolean {
  if (record.engine !== engine) return false;
  const stamped = gitSha !== "" && gitSha !== "unknown" && gitSha !== "dev";
  return !stamped || record.engineGitSha === gitSha;
}
