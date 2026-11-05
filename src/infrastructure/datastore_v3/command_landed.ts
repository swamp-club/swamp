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

import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";

// One CLI process runs one command, so the process is the command's scope;
// serve and worker processes read it only for their own exit.
let landed = false;

/**
 * what a rerun makes afresh rather than repeating: a new run's records, output
 * records and evaluated snapshots, and a workflow's own report data
 */
const RERUN_BOOKKEEPING: ReadonlySet<string> = new Set([
  "run.create",
  "run.update",
  "run.delete",
  "run-snapshot.save",
  "run-snapshot.delete",
  "run-start.save",
  "run-start.delete",
  "output.save",
  "output.delete",
  "evaluated-definition.save",
  "evaluated-definition.delete",
  "evaluated-workflow.save",
  "evaluated-workflow.delete",
  "auto-definition.save",
]);

/** intentKinds: each change's intent; one without counts as an effect */
export function noteCommandLanded(
  partition: PartitionKey,
  intentKinds: readonly (string | undefined)[],
): void {
  const identity = partition.identity;
  if (identity.kind === "run") return;
  if (identity.kind === "model" && identity.type === "workflow") {
    return;
  }
  if (
    intentKinds.some((kind) =>
      kind === undefined || !RERUN_BOOKKEEPING.has(kind)
    )
  ) {
    landed = true;
  }
}

/** a commit whose outcome is unknown may have landed */
export function noteCommandMayHaveLanded(): void {
  landed = true;
}

export function commandLanded(): boolean {
  return landed;
}

export function resetCommandLandedForTesting(): void {
  landed = false;
}
