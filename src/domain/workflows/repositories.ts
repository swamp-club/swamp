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

import type { WorkflowListing } from "./workflow_listing.ts";
import type { WorkflowId, WorkflowRunId } from "./workflow_id.ts";
import type { Workflow } from "./workflow.ts";
import type { WorkflowRun } from "./workflow_run.ts";
import type { RunWriteFence } from "./run_write_fence.ts";

export interface WorkflowRepository {
  findById(id: WorkflowId): Promise<Workflow | null>;

  findByName(name: string): Promise<Workflow | null>;

  findAll(): Promise<Workflow[]>;

  /**
   * ids are not unique, as a copied file keeps its id, so there can be more
   * than one. Optional: callers fall back to filtering findAll
   */
  findAllById?(id: WorkflowId): Promise<Workflow[]>;

  findAllListings?(): Promise<WorkflowListing[]>;

  getWritePath?(workflow: Workflow): string;

  /**
   * promises reuse only, not a consistent point in time. Create one per reader
   * and drop it with the reader, so later readers see later changes
   */
  memoizedView?(): WorkflowRepository;

  save(workflow: Workflow): Promise<void>;

  delete(id: WorkflowId, name?: string): Promise<void>;

  nextId(): WorkflowId;

  getPath(id: WorkflowId): string;
}

export interface RunSaveOptions {
  /**
   * a save that finds the fence closed just before its write writes nothing, and
   * its commit is withdrawn if the run is taken over by the time it lands
   */
  readonly fence?: Pick<RunWriteFence, "isClosed" | "isTakenOver">;
  readonly onRefused?: () => void;
}

export interface WorkflowRunRepository {
  findById(
    workflowId: WorkflowId,
    runId: WorkflowRunId,
  ): Promise<WorkflowRun | null>;

  findAllByWorkflowId(workflowId: WorkflowId): Promise<WorkflowRun[]>;

  findLatestByWorkflowId(workflowId: WorkflowId): Promise<WorkflowRun | null>;

  findAllGlobal(): Promise<{ run: WorkflowRun; workflowId: WorkflowId }[]>;

  findAllGlobalSince(
    cutoff: Date,
  ): Promise<{ run: WorkflowRun; workflowId: WorkflowId }[]>;

  findGlobalByStatus(
    status: string | string[],
    since?: Date,
  ): Promise<{ run: WorkflowRun; workflowId: WorkflowId }[]>;

  /**
   * a member can forward this repository's run records, so what a record says
   * is that member's report and its fields never stand in for a link a child
   * does not hold
   */
  recordsAreForwarded: boolean;

  verifyIndexes?(): Promise<void>;

  save(
    workflowId: WorkflowId,
    run: WorkflowRun,
    options?: RunSaveOptions,
  ): Promise<void>;

  nextId(): WorkflowRunId;

  getPath(workflowId: WorkflowId, runId: WorkflowRunId): string;

  deleteAllByWorkflowId(workflowId: WorkflowId): Promise<number>;

  /** running and suspended runs are never deleted regardless of age */
  deleteOlderThan(
    cutoff: Date,
    options?: { dryRun?: boolean; limit?: number },
  ): Promise<
    {
      deleted: number;
      bytesReclaimed: number;
      deletedRunIds?: string[];
      more?: boolean;
    }
  >;
}

export interface RunSnapshotInfo {
  runId: string;
  modifiedAt: Date;
  sizeBytes: number;
}

/**
 * a snapshot of a run that has not finished is kept, since cancel, reject and
 * orphan settlement read it
 */
export interface RunSnapshotRepository {
  listRunSnapshots(): Promise<RunSnapshotInfo[]>;

  deleteForRun(runId: string): Promise<void>;
}
