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

import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import {
  DATA_ID,
  MemoryStorage,
  modelCommit,
  modelPartition,
  savePut,
  versionOp,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import {
  type CommitLogUnitOfWork,
  PartitionsRefusedError,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { initializeLogging } from "../logging/logger.ts";
import { unitOfWorkBinding } from "../persistence/unit_of_work_binding.ts";
import {
  currentUnitOfWork,
  signalChange,
  stageTyped,
  UnscopedWriteRefusedError,
} from "../persistence/unit_of_work_scope.ts";
import {
  type CommitLogOutcome,
  type CommitLogRoot,
  defaultDisposition,
  RUN_COMMIT_STATUSES,
  runInCommitLogRoot,
  runOutcomeDisposition,
  wasThrownAfterCommit,
} from "./commit_log_root.ts";
import { PathOnlyChangeRefusedError } from "./commit_log_unit_of_work.ts";
import {
  contextHook,
  MemorySink,
  runPartition,
  runPut,
  unitOptions,
} from "./commit_log_test_helpers.ts";

/** An in-memory chunk storage with small chunks, so content spans several. */
function memory(): MemoryStorage {
  return new MemoryStorage({ maxChunkBytes: 32 * 1024 });
}

await initializeLogging({});

const MODEL = modelPartition();

Deno.test("runInCommitLogRoot: commits when fn resolves and returns its value", async () => {
  const sink = new MemorySink();
  const value = await runInCommitLogRoot(
    { markDirty: contextHook() },
    unitOptions(sink, memory()),
    async (root) => {
      await root.stageOp({ partition: MODEL, op: await savePut("a", 1) });
      return 42;
    },
  );
  assertEquals(value, 42);
  assertEquals(sink.landed.length, 1);
});

Deno.test("runInCommitLogRoot: discards when fn throws, and rethrows fn's error", async () => {
  const sink = new MemorySink();
  const failure = new Error("operation failed");
  const error = await assertRejects(() =>
    runInCommitLogRoot(
      { markDirty: contextHook() },
      unitOptions(sink, memory()),
      async (root) => {
        await root.stageOp({ partition: MODEL, op: await savePut("a", 1) });
        throw failure;
      },
    )
  );
  assertStrictEquals(error, failure);
  assertEquals(sink.appendCalls, []);
});

Deno.test("runInCommitLogRoot: fn's error wins when ending the root also fails", async () => {
  const sink = new MemorySink();
  sink.beforeAppend = () => {
    throw new Error("disk full");
  };
  const failure = new Error("operation failed");
  const error = await assertRejects(() =>
    runInCommitLogRoot(
      { markDirty: contextHook() },
      { ...unitOptions(sink, memory()), disposition: () => "commit" },
      async (root) => {
        await root.stageOp({ partition: MODEL, op: await savePut("a", 1) });
        throw failure;
      },
    )
  );
  assertStrictEquals(error, failure);
});

Deno.test("runInCommitLogRoot: a failing commit after fn resolved is thrown", async () => {
  const sink = new MemorySink();
  sink.beforeAppend = () => {
    throw new Error("disk full");
  };
  await assertRejects(
    () =>
      runInCommitLogRoot(
        { markDirty: contextHook() },
        unitOptions(sink, memory()),
        async (root) => {
          await root.stageOp({ partition: MODEL, op: await savePut("a", 1) });
        },
      ),
    Error,
    "disk full",
  );
});

Deno.test("runInCommitLogRoot: refuses a context without a mark hook", async () => {
  await assertRejects(
    () =>
      runInCommitLogRoot(
        {},
        unitOptions(new MemorySink(), memory()),
        () => Promise.resolve(),
      ),
    Error,
    "needs the repository context's mark hook",
  );
});

Deno.test("runInCommitLogRoot: fn runs with the root ambient and bound to the context's hook", async () => {
  const hook = contextHook();
  await runInCommitLogRoot(
    { markDirty: hook },
    unitOptions(new MemorySink(), memory()),
    () => {
      const ambient = currentUnitOfWork();
      assertStrictEquals(
        ambient === undefined
          ? undefined
          : unitOfWorkBinding.boundHook(ambient),
        hook,
      );
      return Promise.resolve();
    },
  );
});

Deno.test("runInCommitLogRoot: marks the hook, so a write outside every unit bound to it is refused afterwards", async () => {
  const hook = contextHook();
  await runInCommitLogRoot(
    { markDirty: hook },
    unitOptions(new MemorySink(), memory()),
    () => Promise.resolve(),
  );
  assertEquals(unitOfWorkBinding.requiresUnit(hook), true);
  await assertRejects(
    () => signalChange(hook, { kind: "write", path: "/cache/a" }),
    UnscopedWriteRefusedError,
  );
});

Deno.test("runInCommitLogRoot: a repository's path-only write inside the root is refused", async () => {
  const hook = contextHook();
  await runInCommitLogRoot(
    { markDirty: hook },
    unitOptions(new MemorySink(), memory()),
    async () => {
      await assertRejects(
        () => signalChange(hook, { kind: "write", path: "/cache/a" }),
        PathOnlyChangeRefusedError,
      );
    },
  );
});

Deno.test("runInCommitLogRoot: nested over the same hook, the inner root is a child the outer root commits", async () => {
  const sink = new MemorySink();
  const hook = contextHook();
  await runInCommitLogRoot(
    { markDirty: hook },
    unitOptions(sink, memory()),
    async (outer) => {
      await outer.stageOp({ partition: MODEL, op: await savePut("a", 1) });
      await runInCommitLogRoot(
        { markDirty: hook },
        unitOptions(sink, memory()),
        async (inner) => {
          await inner.stageOp({ partition: MODEL, op: await savePut("b", 1) });
          await assertRejects(
            () => inner.checkpoint(),
            Error,
            "its root commits",
          );
        },
      );
      assertEquals(sink.appendCalls, []);
    },
  );
  assertEquals(sink.landed.length, 1);
  assertEquals(sink.landed[0].ops.length, 2);
});

Deno.test("runInCommitLogRoot: nested over another hook, the inner root commits on its own", async () => {
  const sink = new MemorySink();
  await runInCommitLogRoot(
    { markDirty: contextHook() },
    unitOptions(sink, memory()),
    async () => {
      await runInCommitLogRoot(
        { markDirty: contextHook() },
        unitOptions(sink, memory()),
        async (inner) => {
          await inner.stageOp({ partition: MODEL, op: await savePut("b", 1) });
        },
      );
      assertEquals(sink.landed.length, 1);
    },
  );
});

Deno.test("runInCommitLogRoot: checkpoint commits partway and the root commits the rest", async () => {
  const sink = new MemorySink();
  await runInCommitLogRoot(
    { markDirty: contextHook() },
    unitOptions(sink, memory()),
    async (root) => {
      await root.stageOp({ partition: MODEL, op: await savePut("a", 1) });
      await root.checkpoint();
      assertEquals(sink.landed.length, 1);
      await root.stageOp({ partition: MODEL, op: await savePut("b", 1) });
    },
  );
  assertEquals(sink.landed.map((commit) => commit.seq), [1, 2]);
});

Deno.test("defaultDisposition: commits a completed operation, discards a failed one", () => {
  assertEquals(
    defaultDisposition({ completed: true, value: undefined }),
    "commit",
  );
  assertEquals(
    defaultDisposition({ completed: false, error: new Error("x") }),
    "discard",
  );
});

Deno.test("runOutcomeDisposition: commits a run that ended succeeded, failed, suspended or cancelled; discards anything else", () => {
  for (const status of RUN_COMMIT_STATUSES) {
    assertEquals(
      runOutcomeDisposition({ completed: true, value: { status } }),
      "commit",
      status,
    );
  }
  for (const status of ["running", "pending", "interrupted", "completed"]) {
    assertEquals(
      runOutcomeDisposition({ completed: true, value: { status } }),
      "discard",
      status,
    );
  }
  const thrown: CommitLogOutcome<{ status: string }> = {
    completed: false,
    error: new Error("crashed"),
  };
  assertEquals(runOutcomeDisposition(thrown), "discard");
});

Deno.test("runInCommitLogRoot: with runOutcomeDisposition, a suspended run's record commits and a thrown run discards", async () => {
  const sink = new MemorySink();
  await runInCommitLogRoot(
    { markDirty: contextHook() },
    { ...unitOptions(sink, memory()), disposition: runOutcomeDisposition },
    async (root) => {
      await root.stageOp({ partition: runPartition(), op: await runPut("s") });
      return { status: "suspended" };
    },
  );
  assertEquals(sink.landed.length, 1);
  await assertRejects(() =>
    runInCommitLogRoot(
      { markDirty: contextHook() },
      { ...unitOptions(sink, memory()), disposition: runOutcomeDisposition },
      async (root) => {
        await root.stageOp({
          partition: runPartition(),
          op: await runPut("t"),
        });
        throw new Error("early stop");
      },
    )
  );
  assertEquals(sink.landed.length, 1);
});

Deno.test("runInCommitLogRoot: a repository's typed declaration and stageTyped land in stagedOps, never staged() (swamp-club#3250)", async () => {
  const sink = new MemorySink();
  const hook = contextHook();
  const put = await savePut("a", 1);
  await runInCommitLogRoot(
    { markDirty: hook },
    unitOptions(sink, memory()),
    async (root) => {
      await signalChange(hook, { kind: "write", path: "/c/a" }, {
        typed: true,
      });
      await stageTyped(hook, () => [{ partition: MODEL, op: put }]);
      assertEquals(root.stagedOps().length, 1);
      assertEquals(currentUnitOfWork()?.staged(), []);
      // Without the declaration the path-only change is refused.
      await assertRejects(
        () => signalChange(hook, { kind: "write", path: "/c/a" }),
        PathOnlyChangeRefusedError,
      );
    },
  );
  assertEquals(sink.landed.length, 1);
  assertEquals(sink.landed[0].ops, [put]);
  // After the root ended, a typed write is refused, not dropped.
  await assertRejects(
    () => stageTyped(hook, () => [{ partition: MODEL, op: put }]),
    UnscopedWriteRefusedError,
  );
});

/** A sink whose model partition refuses a unit fenced at 3 (stale fence). */
async function fencedSink(): Promise<MemorySink> {
  const sink = new MemorySink();
  await sink.append(modelCommit(1, [await savePut("seed", 1)], { fence: 5 }));
  return sink;
}

/** A run that wrote a data version, then saved its record. */
async function runWritingData(root: CommitLogRoot): Promise<void> {
  await root.stageOps([
    { partition: MODEL, op: await savePut("a", 1) },
    { partition: MODEL, op: versionOp("a", 1) },
  ]);
  await root.stageOp({
    partition: runPartition(),
    op: await runPut("succeeded"),
  });
}

Deno.test("runInCommitLogRoot: onRefused re-saves the held run in the root, which commits it and then throws the refusal (swamp-club#3257)", async () => {
  const sink = await fencedSink();
  const seen: PartitionsRefusedError[] = [];
  const error = await assertRejects(
    () =>
      runInCommitLogRoot(
        { markDirty: contextHook() },
        {
          ...unitOptions(sink, memory(), { fence: 3 }),
          onRefused: async (refusal) => {
            seen.push(refusal);
            // The re-save stages into the root, which is ambient.
            const root = currentUnitOfWork() as CommitLogUnitOfWork;
            await root.stageOp({
              partition: runPartition(),
              op: await runPut("failed"),
            });
          },
        },
        async (root) => {
          await runWritingData(root);
          return "done";
        },
      ),
    PartitionsRefusedError,
  );
  assertStrictEquals(seen[0], error);
  // Thrown after the commit, and marked so (swamp-club#3587).
  assertEquals(wasThrownAfterCommit(error), true);
  assertEquals(error.refusals[0].versions, [{ dataId: DATA_ID, version: 1 }]);
  assertEquals(error.heldRuns.map(String), [runPartition().toString()]);
  // Both run puts commit, in order: the last one is the re-saved record.
  const ops = sink.commitsOf(runPartition()).flatMap((commit) => commit.ops);
  assertEquals(
    ops.map((op) =>
      op.kind === "put" && "inline" in op.content
        ? atob(op.content.inline)
        : op.kind
    ),
    ["succeeded", "failed"],
  );
});

Deno.test("runInCommitLogRoot: without onRefused, a refusal commits no run record; a failing onRefused discards the root (swamp-club#3257)", async () => {
  const plain = await fencedSink();
  const thrownByCommit = await assertRejects(
    () =>
      runInCommitLogRoot(
        { markDirty: contextHook() },
        unitOptions(plain, memory(), { fence: 3 }),
        (root) => runWritingData(root),
      ),
    PartitionsRefusedError,
  );
  assertEquals(plain.commitsOf(runPartition()), []);
  // The root's own commit threw it, so the run record never landed
  // (swamp-club#3587).
  assertEquals(wasThrownAfterCommit(thrownByCommit), false);

  const failing = await fencedSink();
  await assertRejects(
    () =>
      runInCommitLogRoot(
        { markDirty: contextHook() },
        {
          ...unitOptions(failing, memory(), { fence: 3 }),
          onRefused: () => Promise.reject(new Error("cannot re-save")),
        },
        (root) => runWritingData(root),
      ),
    Error,
    "cannot re-save",
  );
  assertEquals(failing.commitsOf(runPartition()), []);
});

Deno.test("runInCommitLogRoot: a refusal behind a transient checkpoint failure is still settled by onRefused (swamp-club#3257)", async () => {
  const sink = await fencedSink();
  let transient = true;
  sink.beforeAppend = (commit) => {
    if (transient && commit.partition.equals(MODEL)) {
      transient = false;
      throw new Error("connection reset");
    }
  };
  const seen: PartitionsRefusedError[] = [];
  await assertRejects(
    () =>
      runInCommitLogRoot(
        { markDirty: contextHook() },
        {
          ...unitOptions(sink, memory(), { fence: 3 }),
          onRefused: async (refusal) => {
            seen.push(refusal);
            const root = currentUnitOfWork() as CommitLogUnitOfWork;
            await root.stageOp({
              partition: runPartition(),
              op: await runPut("failed"),
            });
          },
        },
        (root) => runWritingData(root),
      ),
    PartitionsRefusedError,
  );
  assertEquals(seen.length, 1);
  const ops = sink.commitsOf(runPartition()).flatMap((commit) => commit.ops);
  assertEquals(
    ops.map((op) =>
      op.kind === "put" && "inline" in op.content
        ? atob(op.content.inline)
        : op.kind
    ),
    ["succeeded", "failed"],
  );
});
