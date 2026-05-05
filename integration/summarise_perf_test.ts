// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { YamlWorkflowRunRepository } from "../src/infrastructure/persistence/yaml_workflow_run_repository.ts";

// Regression test for swamp-club#240: pin the mtime pre-filter on
// `findAllGlobalSince`. Counts the number of files actually parsed vs the
// number of files in the fixture; if the pre-filter ever stops working, the
// parse count would jump back to N_TOTAL and this test would fail with a
// concrete, deterministic error. Wall-clock is intentionally NOT asserted —
// it's flaky across CI runners and we don't need it: the parse count is the
// thing we actually care about.

const N_TOTAL = 500;
const N_IN_WINDOW = 10;

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp-issue-240-" });
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native handles yet.
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

async function seedWorkflowRuns(
  repoDir: string,
  cutoff: Date,
): Promise<{ inWindow: number; outOfWindow: number }> {
  const workflowId = "550e8400-e29b-41d4-a716-446655440000";
  const runsDir = join(repoDir, ".swamp", "workflow-runs", workflowId);
  await ensureDir(runsDir);

  const now = Date.now();
  const oldDate = new Date(cutoff.getTime() - 7 * 24 * 60 * 60 * 1000);
  let inWindow = 0;
  let outOfWindow = 0;

  for (let i = 0; i < N_TOTAL; i++) {
    const isFresh = i < N_IN_WINDOW;
    const startedAt = isFresh
      ? new Date(now - 1000 * 60)
      : new Date(cutoff.getTime() - 1000 * 60 * 60 * (i + 1));
    const runId = crypto.randomUUID();
    const data = {
      id: runId,
      workflowId,
      workflowName: "synthetic",
      status: "succeeded",
      startedAt: startedAt.toISOString(),
      completedAt: new Date(startedAt.getTime() + 1000).toISOString(),
      jobs: [{
        jobName: "job1",
        status: "succeeded",
        steps: [{ stepName: "step1", status: "succeeded" }],
      }],
      tags: {},
    };
    const path = join(runsDir, `workflow-run-${runId}.yaml`);
    await Deno.writeTextFile(path, stringifyYaml(data));
    if (isFresh) {
      inWindow++;
    } else {
      // Stamp mtime in the past so the mtime pre-filter rejects this file
      // without parsing it. Mirrors what swamp itself produces — old runs
      // aren't re-saved, so their mtime stays at last-completion time.
      await Deno.utime(path, oldDate, oldDate);
      outOfWindow++;
    }
  }

  return { inWindow, outOfWindow };
}

/**
 * Counts every Deno.readTextFile call against the YAML run files. Wraps the
 * builtin so we don't need to plumb instrumentation through the repo class.
 */
function instrumentReadCounter(): { count: () => number; restore: () => void } {
  const original = Deno.readTextFile.bind(Deno);
  let parses = 0;
  Deno.readTextFile = ((
    path: string | URL,
    options?: Deno.ReadFileOptions,
  ) => {
    const p = typeof path === "string" ? path : path.pathname;
    if (p.includes("workflow-run-") && p.endsWith(".yaml")) {
      parses++;
    }
    return original(path, options);
  }) as typeof Deno.readTextFile;
  return {
    count: () => parses,
    restore: () => {
      Deno.readTextFile = original;
    },
  };
}

Deno.test(
  "swamp-club#240: findAllGlobalSince mtime-pre-filter skips parse for out-of-window runs",
  async () => {
    await withTempDir(async (repoDir) => {
      const cutoff = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
      const seeded = await seedWorkflowRuns(repoDir, cutoff);
      assertEquals(seeded.inWindow, N_IN_WINDOW);
      assertEquals(seeded.outOfWindow, N_TOTAL - N_IN_WINDOW);

      const repo = new YamlWorkflowRunRepository(repoDir);
      const counter = instrumentReadCounter();
      try {
        const results = await repo.findAllGlobalSince(cutoff);

        // Correctness: only in-window runs come back.
        assertEquals(results.length, N_IN_WINDOW);

        // Performance: the parse count stays bounded by in-window count.
        // Allow a small constant for any directory-walk artifacts. If the
        // pre-filter regresses, this jumps to N_TOTAL.
        const parses = counter.count();
        const budget = N_IN_WINDOW + 5;
        if (parses > budget) {
          throw new Error(
            `mtime pre-filter regressed: parsed ${parses} files (budget ${budget}, fixture ${N_TOTAL})`,
          );
        }
      } finally {
        counter.restore();
      }
    });
  },
);
