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
let mayHaveLanded = false;

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

/** ride along with a put and name no intent by design */
const INTENTLESS_OP_KINDS: ReadonlySet<string> = new Set([
  "data-version",
  "lease",
]);

/**
 * each op's intent for the landed rule: undefined for an op with none, which
 * counts as an effect, and nothing for the op kinds that never carry one
 */
export function intentKindsOfOps(
  ops: readonly {
    readonly kind: string;
    readonly intent?: { readonly kind: string };
  }[],
): (string | undefined)[] {
  return ops.flatMap((op) =>
    op.intent !== undefined
      ? [op.intent.kind]
      : INTENTLESS_OP_KINDS.has(op.kind)
      ? []
      : [undefined]
  );
}

function hasEffect(
  partition: PartitionKey,
  intentKinds: readonly (string | undefined)[],
): boolean {
  const identity = partition.identity;
  if (identity.kind === "run") return false;
  if (identity.kind === "model" && identity.type === "workflow") return false;
  return intentKinds.some((kind) =>
    kind === undefined || !RERUN_BOOKKEEPING.has(kind)
  );
}

/** intentKinds: each change's intent; one without counts as an effect */
export function noteCommandLanded(
  partition: PartitionKey,
  intentKinds: readonly (string | undefined)[],
): void {
  if (hasEffect(partition, intentKinds)) landed = true;
}

/** a commit whose outcome is unknown, filtered as noteCommandLanded is */
export function noteCommandMayHaveLanded(
  partition: PartitionKey,
  intentKinds: readonly (string | undefined)[],
): void {
  if (hasEffect(partition, intentKinds)) mayHaveLanded = true;
}

/** true when a change with effects landed or may have */
export function commandLanded(): boolean {
  return landed || mayHaveLanded;
}

/** true when a change with effects may have landed, outcome unknown */
export function commandMayHaveLanded(): boolean {
  return mayHaveLanded;
}

export function resetCommandLandedForTesting(): void {
  landed = false;
  mayHaveLanded = false;
}
