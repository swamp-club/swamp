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
import { join } from "@std/path";
import {
  clearCommittedAtBoot,
  clearUnpushedInterrupts,
  markedRunsStillRunning,
  pushSettledAtBoot,
  readUnpushedInterrupts,
  recordUnpushedInterrupts,
  UNPUSHED_INTERRUPTS_FILE,
} from "./unpushed_interrupts.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { Workflow } from "../domain/workflows/workflow.ts";
import { WorkflowRun } from "../domain/workflows/workflow_run.ts";
import { Job } from "../domain/workflows/job.ts";
import { Step } from "../domain/workflows/step.ts";
import { StepTask } from "../domain/workflows/step_task.ts";

await initializeLogging({});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

Deno.test("readUnpushedInterrupts: a missing marker is absent", async () => {
  await withTempDir(async (dir) => {
    assertEquals(
      await readUnpushedInterrupts(join(dir, UNPUSHED_INTERRUPTS_FILE)),
      { present: false },
    );
  });
});

Deno.test("recordUnpushedInterrupts: records run ids and merges with the ids already recorded", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, UNPUSHED_INTERRUPTS_FILE);
    await recordUnpushedInterrupts(path, [
      { runId: "a", workflowId: "wf" },
      { runId: "b" },
    ]);
    await recordUnpushedInterrupts(path, [
      { runId: "a" },
      { runId: "b", workflowId: "wf" },
      { runId: "c" },
    ]);

    assertEquals(await readUnpushedInterrupts(path), {
      present: true,
      runs: [
        { runId: "a", workflowId: "wf" },
        { runId: "b", workflowId: "wf" },
        { runId: "c" },
      ],
    });
    // Only the marker is left: the atomic write's temp file is renamed.
    const names = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names, [UNPUSHED_INTERRUPTS_FILE]);
  });
});

Deno.test("readUnpushedInterrupts: a malformed marker counts as present with no ids", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, UNPUSHED_INTERRUPTS_FILE);
    for (
      const content of [
        "not json",
        "null",
        "[]",
        '{"runs":"a"}',
        '{"runs":[1]}',
        '{"runs":[{"workflowId":"wf"}]}',
        '{"runs":[{"runId":"a","workflowId":1}]}',
        "{}",
      ]
    ) {
      await Deno.writeTextFile(path, content);
      assertEquals(await readUnpushedInterrupts(path), {
        present: true,
        runs: [],
      }, content);
    }
  });
});

Deno.test("recordUnpushedInterrupts: replaces a malformed marker with the new ids", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, UNPUSHED_INTERRUPTS_FILE);
    await Deno.writeTextFile(path, "not json");
    await recordUnpushedInterrupts(path, [{ runId: "a" }]);

    assertEquals(await readUnpushedInterrupts(path), {
      present: true,
      runs: [{ runId: "a" }],
    });
  });
});

Deno.test("clearUnpushedInterrupts: removes the marker, and a missing one is not an error", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, UNPUSHED_INTERRUPTS_FILE);
    await recordUnpushedInterrupts(path, [{ runId: "a" }]);
    await clearUnpushedInterrupts(path);
    assertEquals(await readUnpushedInterrupts(path), { present: false });
    await clearUnpushedInterrupts(path);
  });
});

Deno.test("pushSettledAtBoot: pushes nothing when nothing was reaped and no marker was left", async () => {
  let pushes = 0;
  await pushSettledAtBoot({
    reaped: 0,
    marker: { present: false },
    markerPath: "unused",
    push: () => {
      pushes++;
      return Promise.resolve();
    },
  });
  assertEquals(pushes, 0);
});

Deno.test("pushSettledAtBoot: pushes once for a reap and leaves no marker behind", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, UNPUSHED_INTERRUPTS_FILE);
    let pushes = 0;
    await pushSettledAtBoot({
      reaped: 2,
      marker: { present: false },
      markerPath: path,
      push: () => {
        pushes++;
        return Promise.resolve();
      },
    });
    assertEquals(pushes, 1);
    assertEquals(await readUnpushedInterrupts(path), { present: false });
  });
});

Deno.test("pushSettledAtBoot: pushes for a marker and clears it once the push lands", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, UNPUSHED_INTERRUPTS_FILE);
    await recordUnpushedInterrupts(path, [{ runId: "a" }]);
    let pushes = 0;
    await pushSettledAtBoot({
      reaped: 0,
      marker: await readUnpushedInterrupts(path),
      markerPath: path,
      push: () => {
        pushes++;
        return Promise.resolve();
      },
    });
    assertEquals(pushes, 1);
    assertEquals(await readUnpushedInterrupts(path), { present: false });
  });
});

Deno.test("pushSettledAtBoot: a failed push keeps the marker and is not thrown", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, UNPUSHED_INTERRUPTS_FILE);
    await recordUnpushedInterrupts(path, [{ runId: "a" }]);
    await pushSettledAtBoot({
      reaped: 0,
      marker: await readUnpushedInterrupts(path),
      markerPath: path,
      push: () => Promise.reject(new Error("S3 unreachable")),
    });
    assertEquals(await readUnpushedInterrupts(path), {
      present: true,
      runs: [{ runId: "a" }],
    });
  });
});

Deno.test("markedRunsStillRunning: reads each marked run by id and keeps those still running", async () => {
  const wf = Workflow.create({
    name: `wf-${crypto.randomUUID()}`,
    jobs: [
      Job.create({
        name: "main",
        steps: [
          Step.create({ name: "s", task: StepTask.manualApproval("ok?") }),
        ],
      }),
    ],
  });
  const running = WorkflowRun.create(wf);
  running.start();
  const done = WorkflowRun.create(wf);
  done.start();
  done.complete();
  const byId = new Map([[running.id, running], [done.id, done]]);
  const reads: string[] = [];

  const found = await markedRunsStillRunning(
    {
      present: true,
      runs: [
        { runId: running.id, workflowId: wf.id },
        { runId: done.id, workflowId: wf.id },
        // No workflow id, or one that is not a UUID: never read.
        { runId: crypto.randomUUID() },
        { runId: crypto.randomUUID(), workflowId: "../escape" },
      ],
    },
    (_workflowId, runId) => {
      reads.push(runId);
      return Promise.resolve(byId.get(runId) ?? null);
    },
  );

  assertEquals(found.map(({ run }) => run.id), [running.id]);
  assertEquals(reads, [running.id, done.id]);
});

Deno.test("markedRunsStillRunning: an absent marker reads nothing, and a failed read is left out", async () => {
  assertEquals(
    await markedRunsStillRunning({ present: false }, () => {
      throw new Error("not called");
    }),
    [],
  );
  assertEquals(
    await markedRunsStillRunning(
      {
        present: true,
        runs: [{ runId: crypto.randomUUID(), workflowId: crypto.randomUUID() }],
      },
      () => Promise.reject(new Error("unreadable")),
    ),
    [],
  );
});

Deno.test("clearCommittedAtBoot: clears the record once the boot reap committed it (swamp-club#3961)", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, UNPUSHED_INTERRUPTS_FILE);
    await recordUnpushedInterrupts(path, [{ runId: "a" }]);
    await clearCommittedAtBoot({
      marker: await readUnpushedInterrupts(path),
      markerPath: path,
    });
    assertEquals(await readUnpushedInterrupts(path), { present: false });
  });
});

Deno.test("clearCommittedAtBoot: with no record left it removes nothing", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, UNPUSHED_INTERRUPTS_FILE);
    // A record written after the boot read it is not the one that landed.
    await clearCommittedAtBoot({
      marker: { present: false },
      markerPath: path,
    });
    await recordUnpushedInterrupts(path, [{ runId: "b" }]);
    await clearCommittedAtBoot({
      marker: { present: false },
      markerPath: path,
    });
    assertEquals((await readUnpushedInterrupts(path)).present, true);
  });
});
