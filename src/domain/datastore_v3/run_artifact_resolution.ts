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
 * How a run record's data artifact resolves once history compaction
 * (swamp-club#3258) may have removed the version it named. Dormant: the v3
 * opt-in calls it where run records resolve their artifacts.
 *
 * A ref names `dataId`, `name` and `version`. Since swamp-club#3250 a version
 * removed by `delete`, `data gc` or `prune` can be recorded again, and a
 * re-save of a top version keeps the `dataId` (`Data.withNewVersion`), so a
 * live `name@version` is not necessarily the content the run produced, and
 * compaction removes the commits that held the original. The resolver
 * returns the live version only when it is evidently the one the ref's
 * producer wrote, and otherwise "content no longer available": never another
 * writer's content.
 *
 * @module
 */

import type { DataMetadata } from "../data/data_metadata.ts";

/** A run record's reference to a data version it produced. */
export interface RunArtifactRef {
  readonly dataId: string;
  readonly name: string;
  readonly version: number;
  /**
   * The SHA-256 of the version's content, when the ref records it. Refs
   * written today do not; the opt-in adds it, and then it decides alone.
   */
  readonly sha256?: string;
}

/** The run or method output whose record holds the ref. */
export interface ArtifactProducer {
  /** The workflow run's id, for a workflow step's output; absent otherwise. */
  readonly workflowRunId?: string;
  readonly startedAt: Date;
  /** Absent for an output that never finished. */
  readonly completedAt?: Date;
}

/** The live version a ref names, as the read model holds it. */
export interface LiveArtifactVersion {
  readonly metadata: DataMetadata;
  /** The SHA-256 of its content. */
  readonly sha256: string;
}

/** How a ref resolved. */
export type RunArtifactResolution =
  | { readonly kind: "available"; readonly metadata: DataMetadata }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Resolves `ref` against the version now live at its name and version, if
 * any:
 *
 * 1. No live version, or one with another `dataId`: unavailable.
 * 2. A ref carrying `sha256`: available exactly when the content matches.
 * 3. A version that records a workflow run (`ownerDefinition.workflowRunId`):
 *    available exactly when it is the producer's run.
 * 4. Otherwise (a method run's output, or data that records no run): available
 *    exactly when it was created within the producer's start and finish. An
 *    output that never finished resolves nothing.
 *
 * The one case rule 4 cannot tell apart: another writer removing and
 * re-saving the same top version inside the producer's own window. A ref
 * carrying `sha256` closes it. The window compares timestamps from one
 * clock, which holds while one process writes both.
 */
export function resolveRunArtifact(
  ref: RunArtifactRef,
  producer: ArtifactProducer,
  live: LiveArtifactVersion | undefined,
): RunArtifactResolution {
  const unavailable = (reason: string): RunArtifactResolution => ({
    kind: "unavailable",
    reason:
      `${ref.name}@${ref.version}: content no longer available (${reason})`,
  });
  if (live === undefined) return unavailable("the version is not live");
  const { metadata } = live;
  if (metadata.id !== ref.dataId) {
    return unavailable("the live version belongs to another data item");
  }
  const available: RunArtifactResolution = { kind: "available", metadata };
  if (ref.sha256 !== undefined) {
    return live.sha256 === ref.sha256
      ? available
      : unavailable("the live version has other content");
  }
  const runId = metadata.ownerDefinition.workflowRunId;
  if (runId !== undefined) {
    return runId === producer.workflowRunId
      ? available
      : unavailable("the live version was written by another run");
  }
  if (producer.completedAt === undefined) {
    return unavailable("its producer never finished");
  }
  const created = Date.parse(metadata.createdAt);
  if (
    Number.isNaN(created) || created < producer.startedAt.getTime() ||
    created > producer.completedAt.getTime()
  ) {
    return unavailable("the live version was written outside its producer");
  }
  return available;
}
