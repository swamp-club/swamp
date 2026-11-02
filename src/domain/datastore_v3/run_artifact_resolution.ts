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
 * a re-saved top version keeps its dataId, so the resolver returns the live
 * version only when evidently the one the producer wrote; otherwise content is
 * unavailable, never another writer's content
 */

import type { DataMetadata } from "../data/data_metadata.ts";

export interface RunArtifactRef {
  readonly dataId: string;
  readonly name: string;
  readonly version: number;
  /**
   * the SHA-256 of the version's content, when the ref records it; when present
   * it decides alone
   */
  readonly sha256?: string;
}

export interface ArtifactProducer {
  readonly workflowRunId?: string;
  readonly startedAt: Date;
  readonly completedAt?: Date;
}

export interface LiveArtifactVersion {
  readonly metadata: DataMetadata;
  readonly sha256: string;
}

export type RunArtifactResolution =
  | { readonly kind: "available"; readonly metadata: DataMetadata }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * rule 4 cannot tell apart another writer removing and re-saving the same top
 * version inside the producer's window; a ref with sha256 closes it. Timestamps
 * assume one clock.
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
