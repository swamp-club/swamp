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

import { assertEquals } from "@std/assert";
import type { DataMetadata } from "../data/data_metadata.ts";
import { DataMetadataSchema } from "../data/data_metadata.ts";
import {
  type ArtifactProducer,
  resolveRunArtifact,
} from "./run_artifact_resolution.ts";
import { DATA_ID, metadata } from "./v3_test_helpers.ts";

const RUN = "2b9d1f4e-7c3a-4e5b-9d6f-1a2b3c4d5e6f";
const OTHER_RUN = "8e7d6c5b-4a39-4281-9f0e-1d2c3b4a5968";
const STARTED = new Date("2026-10-11T00:00:00.000Z");
const COMPLETED = new Date("2026-10-11T00:05:00.000Z");
const REF = { dataId: DATA_ID, name: "a", version: 1 };

function live(
  fields: { createdAt?: string; workflowRunId?: string; id?: string } = {},
): { metadata: DataMetadata; sha256: string } {
  const base = metadata("a", 1) as Record<string, unknown>;
  const owner = base.ownerDefinition as Record<string, unknown>;
  return {
    metadata: DataMetadataSchema.parse({
      ...base,
      id: fields.id ?? DATA_ID,
      createdAt: fields.createdAt ?? "2026-10-11T00:01:00.000Z",
      ownerDefinition: fields.workflowRunId === undefined
        ? owner
        : { ...owner, workflowRunId: fields.workflowRunId },
    }),
    sha256: "a".repeat(64),
  };
}

const METHOD_RUN: ArtifactProducer = {
  startedAt: STARTED,
  completedAt: COMPLETED,
};
const WORKFLOW_RUN: ArtifactProducer = { ...METHOD_RUN, workflowRunId: RUN };

Deno.test("resolveRunArtifact: a version that is not live, or of another data item, is unavailable", () => {
  assertEquals(
    resolveRunArtifact(REF, METHOD_RUN, undefined).kind,
    "unavailable",
  );
  assertEquals(
    resolveRunArtifact(
      REF,
      METHOD_RUN,
      live({ id: "11111111-2222-4333-8444-555555555555" }),
    ).kind,
    "unavailable",
  );
});

Deno.test("resolveRunArtifact: a workflow step's version resolves only from its own run", () => {
  const version = live({ workflowRunId: RUN });
  assertEquals(resolveRunArtifact(REF, WORKFLOW_RUN, version), {
    kind: "available",
    metadata: version.metadata,
  });
  // The version was deleted and saved again by another run.
  assertEquals(
    resolveRunArtifact(REF, WORKFLOW_RUN, live({ workflowRunId: OTHER_RUN })),
    {
      kind: "unavailable",
      reason:
        "a@1: content no longer available (the live version was written by another run)",
    },
  );
  // A method run never produced a version that records a workflow run.
  assertEquals(
    resolveRunArtifact(REF, METHOD_RUN, version).kind,
    "unavailable",
  );
});

Deno.test("resolveRunArtifact: a method run's version resolves when it was created within the run", () => {
  assertEquals(resolveRunArtifact(REF, METHOD_RUN, live()).kind, "available");
  // Report data and the like record no run: the window decides for a
  // workflow run too.
  assertEquals(resolveRunArtifact(REF, WORKFLOW_RUN, live()).kind, "available");
  // Saved again after the run finished, or before it started.
  assertEquals(
    resolveRunArtifact(
      REF,
      METHOD_RUN,
      live({ createdAt: "2026-10-11T00:06:00.000Z" }),
    ).kind,
    "unavailable",
  );
  assertEquals(
    resolveRunArtifact(
      REF,
      METHOD_RUN,
      live({ createdAt: "2026-10-10T23:59:59.000Z" }),
    ).kind,
    "unavailable",
  );
});

Deno.test("resolveRunArtifact: an output that never finished resolves nothing by time", () => {
  assertEquals(
    resolveRunArtifact(REF, { startedAt: STARTED }, live()),
    {
      kind: "unavailable",
      reason: "a@1: content no longer available (its producer never finished)",
    },
  );
});

Deno.test("resolveRunArtifact: a ref recording its content resolves exactly when the content matches", () => {
  const version = live({ workflowRunId: OTHER_RUN });
  assertEquals(
    resolveRunArtifact(
      { ...REF, sha256: version.sha256 },
      { startedAt: STARTED },
      version,
    ).kind,
    "available",
  );
  assertEquals(
    resolveRunArtifact(
      { ...REF, sha256: "b".repeat(64) },
      WORKFLOW_RUN,
      live({
        workflowRunId: RUN,
      }),
    ).kind,
    "unavailable",
  );
});
