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
import { runGc, type RunGcDeps, runGcPreview } from "./run_gc.ts";
import { createLibSwampContext } from "../context.ts";
import { getLogger } from "@logtape/logtape";

function createMockCtx() {
  return createLibSwampContext({ logger: getLogger(["test"]) });
}

function createMockDeps(result: {
  workflowRunsDeleted: number;
  workflowRunBytesReclaimed: number;
  outputsDeleted: number;
  outputBytesReclaimed: number;
  dryRun: boolean;
}): RunGcDeps {
  return {
    gcAll: () => Promise.resolve(result),
  };
}

Deno.test("runGcPreview: returns preview with dryRun=true", async () => {
  const deps = createMockDeps({
    workflowRunsDeleted: 10,
    workflowRunBytesReclaimed: 5000,
    outputsDeleted: 5,
    outputBytesReclaimed: 2000,
    dryRun: true,
  });

  const preview = await runGcPreview(createMockCtx(), deps, {
    dryRun: false,
    workflowRunRetentionDays: 7,
    outputRetentionDays: 7,
  });

  assertEquals(preview.workflowRunsToDelete, 10);
  assertEquals(preview.workflowRunBytesReclaimable, 5000);
  assertEquals(preview.outputsToDelete, 5);
  assertEquals(preview.outputBytesReclaimable, 2000);
  assertEquals(preview.totalBytesReclaimable, 7000);
});

Deno.test("runGc: yields collecting then completed events", async () => {
  const deps = createMockDeps({
    workflowRunsDeleted: 3,
    workflowRunBytesReclaimed: 1500,
    outputsDeleted: 2,
    outputBytesReclaimed: 800,
    dryRun: false,
  });

  const events = [];
  for await (
    const event of runGc(createMockCtx(), deps, {
      dryRun: false,
      workflowRunRetentionDays: 30,
      outputRetentionDays: 30,
    })
  ) {
    events.push(event);
  }

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "collecting");
  assertEquals(events[1].kind, "completed");
  if (events[1].kind === "completed") {
    assertEquals(events[1].data.workflowRunsDeleted, 3);
    assertEquals(events[1].data.outputsDeleted, 2);
    assertEquals(events[1].data.totalBytesReclaimed, 2300);
    assertEquals(events[1].data.dryRun, false);
  }
});

Deno.test("runGc: uses default retention when not specified", async () => {
  let capturedOptions: Record<string, unknown> | undefined;
  const deps: RunGcDeps = {
    gcAll: (options) => {
      capturedOptions = options;
      return Promise.resolve({
        workflowRunsDeleted: 0,
        workflowRunBytesReclaimed: 0,
        outputsDeleted: 0,
        outputBytesReclaimed: 0,
        dryRun: true,
      });
    },
  };

  for await (
    const _event of runGc(createMockCtx(), deps, { dryRun: true })
  ) {
    // consume
  }

  assertEquals(capturedOptions?.workflowRunRetentionDays, 30);
  assertEquals(capturedOptions?.outputRetentionDays, 30);
  assertEquals(capturedOptions?.dryRun, true);
});
