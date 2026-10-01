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

import type { Principal } from "../../domain/access/principal.ts";
import { canonicalResources } from "./resource_resolution.ts";
import { type ConnectionContext, resourceDecider } from "./shared.ts";

/** A workflow a nested-run field names. */
export interface NamedWorkflow {
  workflowId: string;
  workflowName: string;
}

/**
 * Decides, silently and per request, whether the principal may read a
 * workflow that a nested-run field names (swamp-club#2736). The fields that
 * link a run to its parent or to the nested runs it waits on are returned
 * only when this allows the workflow they name; the run's own row is
 * authorized as before. Child identity that a run already carried (a
 * succeeded nested step's output, forwarded child events) is unchanged.
 */
export function nestedRunReadDecider(
  ctx: ConnectionContext,
  socket: WebSocket,
  principal: Principal | null,
): (workflow: NamedWorkflow) => Promise<boolean> {
  if (ctx.authConfig.mode === "none") return () => Promise.resolve(true);
  const canonical = canonicalResources(ctx);
  const allows = resourceDecider(socket, principal, "read", ctx);
  const decided = new Map<string, Promise<boolean>>();
  return (workflow) => {
    const key = JSON.stringify([workflow.workflowId, workflow.workflowName]);
    let found = decided.get(key);
    if (!found) {
      found = canonical.workflowOwners(
        workflow.workflowId,
        workflow.workflowName,
      ).then((resources) => resources.length > 0 && resources.every(allows))
        .catch(() => false);
      decided.set(key, found);
    }
    return found;
  };
}

/**
 * Removes the parent link from a row whose parent workflow the principal
 * may not read, together with anything derived from it.
 */
export async function redactParentRun<
  T extends { parentRun?: NamedWorkflow; parentWaiting?: boolean },
>(
  row: T,
  canRead: (workflow: NamedWorkflow) => Promise<boolean>,
): Promise<void> {
  if (row.parentRun && !(await canRead(row.parentRun))) {
    delete row.parentRun;
    delete row.parentWaiting;
  }
}

/** Keeps only the nested runs whose workflow the principal may read. */
export async function readableNestedRuns<T extends { workflowName: string }>(
  runs: T[] | undefined,
  workflowIdOf: (run: T) => string | undefined,
  canRead: (workflow: NamedWorkflow) => Promise<boolean>,
): Promise<T[] | undefined> {
  if (!runs) return undefined;
  const kept: T[] = [];
  for (const run of runs) {
    const workflowId = workflowIdOf(run);
    if (
      workflowId !== undefined &&
      await canRead({ workflowId, workflowName: run.workflowName })
    ) {
      kept.push(run);
    }
  }
  return kept.length > 0 ? kept : undefined;
}
