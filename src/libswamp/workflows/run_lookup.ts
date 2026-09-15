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

/** Partial ID match result. */
export interface PartialMatchResult {
  status: "found" | "not_found" | "ambiguous";
  match?: WorkflowRun;
  matches?: Array<{ id: string }>;
}

/**
 * The run repository surface the matcher needs.
 *
 * Structural on purpose: the whole point of the fast path is a call that must
 * NOT happen, and this is the cheapest way for a test to count it. Deliberately
 * local to this module and not re-exported from `mod.ts` — it is a test seam,
 * not a public contract.
 */
interface RunLookupRepository {
  findGlobalById(
    runId: WorkflowRunId,
  ): Promise<{ run: WorkflowRun; workflowId: WorkflowId } | null>;
  findAllGlobal(): Promise<{ run: WorkflowRun; workflowId: WorkflowId }[]>;
}

/**
 * Rewrites a complete run UUID to its canonical dashed lowercase form.
 *
 * Applies the same normalization as {@link matchByPartialId} (strip dashes,
 * lowercase) so an uppercase or dashless UUID resolves the same way the scan
 * would have resolved it. Returns null for anything that is not a complete
 * UUID — prefixes, workflow names, malformed input — which is the signal to
 * fall back to the broader scan.
 */
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
 * Builds the run matcher shared by the workflow history commands.
 *
 * A complete run UUID is resolved with a targeted repository lookup, so a
 * single known run no longer costs a read and parse of every retained run in
 * the repository. Everything else — prefixes, workflow names, and complete
 * UUIDs with no matching run file — falls through to the global scan, which
 * keeps Docker-style prefix matching, ambiguity detection, and not-found
 * semantics exactly as they were. The scan is therefore only paid on input
 * that was never going to resolve cheaply.
 *
 * Nothing is cached: each call re-reads from the repository, so repeated
 * lookups observe a run's status as it progresses.
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
        matches: result.matches.map((m) => ({ id: m.id })),
      };
    }
    return { status: "not_found" };
  };
}
