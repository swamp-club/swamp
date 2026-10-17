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

/**
 * This process's {@link ProcessIdentity}, and the probe that judges another
 * pid by it (swamp-club#3564). The v3 writer records name their writer with
 * the identity; {@link judgeRecordedProcess} decides from it.
 *
 * The identity is resolved once per process: the boot id is read by running
 * `cat` or `sysctl` where Deno refuses `/proc`, so it is asynchronous. Every
 * caller is already asynchronous and awaits {@link localProcess} first.
 *
 * @module
 */

import {
  judgeRecordedProcess,
  type LocalProcess,
  type ProcessIdentity,
  type ProcessProbe,
  type ProcessVerdict,
  type RecordedProcess,
} from "../../domain/datastore_v3/process_liveness.ts";
import { isProcessGone, processHostIdentity } from "../runtime/process.ts";
import { processStateOf } from "../runtime/process_ancestry.ts";
import { currentBootIdentity } from "./boot_identity.ts";

/**
 * Probes `pid` without signalling it beyond {@link isProcessGone}'s
 * harmless one. When its state cannot be read (another user's process
 * behind `hidepid`, an unsupported platform, no libc), it is present as far
 * as {@link isProcessGone} can tell, with no start time.
 */
export function probeProcess(pid: number): ProcessProbe {
  const state = processStateOf(pid);
  if (state !== undefined) {
    return { present: true, zombie: state.zombie, startTime: state.startTime };
  }
  return { present: !isProcessGone(pid), zombie: false };
}

let resolved: Promise<LocalProcess> | undefined;
let override: LocalProcess | undefined;

/** This process, as the records it writes name it, and its probe. */
export function localProcess(): Promise<LocalProcess> {
  if (override !== undefined) return Promise.resolve(override);
  resolved ??= currentBootIdentity().then((bootId) => {
    const startTime = processStateOf(Deno.pid)?.startTime;
    const identity: ProcessIdentity = {
      host: processHostIdentity(),
      ...(bootId !== undefined ? { bootId } : {}),
      ...(startTime !== undefined ? { startTime } : {}),
    };
    return {
      pid: Deno.pid,
      identity,
      probe: probeProcess,
      // Windows has no boot id; everywhere else one missing places nothing.
      bootIdRequired: Deno.build.os !== "windows",
    };
  });
  return resolved;
}

/** Judges the writer `recorded` names from this process. */
export async function judgeRecorded(
  recorded: RecordedProcess,
): Promise<ProcessVerdict> {
  return judgeRecordedProcess(recorded, await localProcess());
}

/**
 * Makes {@link localProcess} answer `local` until it is called with
 * undefined, so a test can play another process, or probe planted pids,
 * without spawning one. Module-wide: a Worker sets its own.
 */
export function setLocalProcessForTesting(
  local: LocalProcess | undefined,
): void {
  override = local;
}
