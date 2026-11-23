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

import { normalizeModelTypeName } from "../models/control_plane_types.ts";
import type { IntentKind } from "./intent.ts";
import type { Op } from "./op.ts";
import type { PartitionKey } from "./partition_key.ts";

/**
 * shared: judged against its own and its locked partitions plus facts only an
 * exclusive commit writes, so it competes only on those partitions. exclusive:
 * writes a fact other commits are judged against, so it runs alone
 */
export type ForwardedCommitClass = "shared" | "exclusive";

/**
 * every other intent is exclusive, a new one included until it is shown to
 * write nothing another commit's judgment reads
 */
export const SHARED_INTENT_KINDS: ReadonlySet<IntentKind> = new Set<
  IntentKind
>([
  "data.save",
  "data.append",
  "data.delete",
  "data.gc",
  "data.rename",
  "output.save",
  "output.delete",
  "evaluated-definition.save",
  "evaluated-definition.delete",
  "evaluated-workflow.save",
  "evaluated-workflow.delete",
  "run.create",
  "run.update",
  "run.delete",
  "run-snapshot.save",
  "run-snapshot.delete",
  "run-start.save",
  "run-start.delete",
]);

/** their records decide what every caller may do, read or not through the policy snapshot */
export const ACCESS_CONTROL_MODEL_TYPES: ReadonlySet<string> = new Set([
  "swamp/grant",
  "swamp/group",
  "swamp/delegation",
  "swamp/server-token",
  "swamp/integration",
  "swamp/policy-release",
  "swamp/enrollment-token",
]);

export function forwardedCommitClass(
  partition: PartitionKey,
  ops: readonly Op[],
): ForwardedCommitClass {
  const identity = partition.identity;
  if (identity.kind === "model") {
    const type = normalizeModelTypeName(identity.type);
    if (type === null || ACCESS_CONTROL_MODEL_TYPES.has(type)) {
      return "exclusive";
    }
  }
  for (const op of ops) {
    if (op.kind === "lease" || op.kind === "data-version") continue;
    if (!SHARED_INTENT_KINDS.has(op.intent.kind)) return "exclusive";
  }
  return "shared";
}
