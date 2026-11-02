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

import type { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import {
  createWorkflowRunId,
  type WorkflowId,
  type WorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import { isUuid, matchByPartialId } from "../../domain/models/model_lookup.ts";

export interface PartialMatchResult {
  status: "found" | "not_found" | "ambiguous";
  match?: WorkflowRun;
  matches?: Array<{ id: string; run: WorkflowRun }>;
}

/**
 * structural on purpose so a test can count the lookup the fast path must skip;
 * a local test seam, not exported from mod.ts
 */
interface RunLookupRepository {
  findGlobalById(
    runId: WorkflowRunId,
  ): Promise<{ run: WorkflowRun; workflowId: WorkflowId } | null>;
  findAllGlobal(): Promise<{ run: WorkflowRun; workflowId: WorkflowId }[]>;
}

function toCanonicalUuid(value: string): string | null {
  const normalized = value.toLowerCase().replace(/-/g, "");
  if (normalized.length !== 32) return null;

  const dashed = [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20),
  ].join("-");

  return isUuid(dashed) ? dashed : null;
}

/**
 * a complete run UUID gets a targeted lookup; everything else falls through to
 * the global scan. Nothing is cached, so repeated lookups see a run's status as
 * it progresses.
 */
export function createRunMatcher(
  runRepo: RunLookupRepository,
): (idPrefix: string) => Promise<PartialMatchResult> {
  return async (idPrefix: string): Promise<PartialMatchResult> => {
    const canonical = toCanonicalUuid(idPrefix);
    if (canonical) {
      const hit = await runRepo.findGlobalById(createWorkflowRunId(canonical));
      if (hit) return { status: "found", match: hit.run };
      // Miss — the run may have been deleted mid-lookup, or be stored under a
      // non-canonical filename. Fall through to the scan rather than assume.
    }

    const allRuns = await runRepo.findAllGlobal();
    const result = matchByPartialId(
      allRuns.map((r) => ({ id: r.run.id, item: r.run })),
      idPrefix,
    );
    if (result.status === "found") {
      return { status: "found", match: result.match };
    }
    if (result.status === "ambiguous") {
      return {
        status: "ambiguous",
        matches: result.matches.map((m) => ({ id: m.id, run: m.match })),
      };
    }
    return { status: "not_found" };
  };
}
