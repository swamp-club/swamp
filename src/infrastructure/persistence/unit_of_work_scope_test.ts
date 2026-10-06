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

import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type {
  StagedChange,
  UnitOfWork,
} from "../../domain/datastore/unit_of_work.ts";
import { createLegacyUnitOfWork } from "./legacy_unit_of_work.ts";
import {
  currentUnitOfWork,
  runInUnitOfWork,
  signalChange,
  unscopedCallerFrom,
  type UnscopedChange,
  useUnscopedChangeReporterForTesting,
} from "./unit_of_work_scope.ts";

/** A mark hook that records its arguments and can reject the next call. */
function recordingHook(): {
  hook: MarkDirtyHook;
  calls: (string | undefined)[];
  failNext: (error: Error) => void;
} {
  const calls: (string | undefined)[] = [];
  let failure: Error | undefined;
  const hook: MarkDirtyHook = (relPath?: string) => {
    calls.push(relPath);
    const error = failure;
    failure = undefined;
    return error ? Promise.reject(error) : Promise.resolve();
  };
  return { hook, calls, failNext: (error) => failure = error };
}

const WRITE: StagedChange = { kind: "write", path: "/cache/data/a/raw" };
const REMOVE: StagedChange = { kind: "remove", path: "/cache/data/b" };
const BULK: StagedChange = { kind: "bulk", reason: "test" };

Deno.test("signalChange: with no scope, calls the hook with the path, and nothing for bulk", async () => {
  const { hook, calls } = recordingHook();
  await signalChange(hook, WRITE);
  await signalChange(hook, REMOVE);
  await signalChange(hook, BULK);
  assertEquals(calls, ["/cache/data/a/raw", "/cache/data/b", undefined]);
});

Deno.test("signalChange: in a scope bound to the hook, stages once and the unit marks once", async () => {
  const { hook, calls } = recordingHook();
  const uow = createLegacyUnitOfWork(hook, { flush: undefined });
  await runInUnitOfWork(uow, async () => {
    await signalChange(hook, WRITE);
    await signalChange(hook, BULK);
  });
  assertEquals(uow.staged(), [WRITE, BULK]);
  assertEquals(calls, ["/cache/data/a/raw", undefined]);
});

Deno.test("signalChange: in a scope bound to another hook, calls its own hook and stages nothing", async () => {
  const mine = recordingHook();
  const theirs = recordingHook();
  const uow = createLegacyUnitOfWork(theirs.hook, { flush: undefined });
  await runInUnitOfWork(uow, () => signalChange(mine.hook, WRITE));
  assertEquals(uow.staged(), []);
  assertEquals(theirs.calls, []);
  assertEquals(mine.calls, ["/cache/data/a/raw"]);
});

Deno.test("signalChange: with no hook, sends and stages nothing, even inside a scope", async () => {
  const { hook, calls } = recordingHook();
  const bound = createLegacyUnitOfWork(hook, { flush: undefined });
  const hookless = createLegacyUnitOfWork(undefined, { flush: undefined });
  await signalChange(undefined, WRITE);
  await runInUnitOfWork(bound, () => signalChange(undefined, WRITE));
  await runInUnitOfWork(hookless, () => signalChange(undefined, WRITE));
  assertEquals(bound.staged(), []);
  assertEquals(hookless.staged(), []);
  assertEquals(calls, []);
});

Deno.test("signalChange: a unit of work not built by the legacy adapter is never staged into", async () => {
  const { hook, calls } = recordingHook();
  const staged: StagedChange[] = [];
  const foreign: UnitOfWork = {
    stage: (change) => {
      staged.push(change);
      return Promise.resolve();
    },
    commit: () => Promise.resolve(),
    abandon: () => Promise.resolve(),
    staged: () => staged,
  };
  await runInUnitOfWork(foreign, () => signalChange(hook, WRITE));
  assertEquals(staged, []);
  assertEquals(calls, ["/cache/data/a/raw"]);
});

Deno.test("signalChange: a hook rejection rejects with the same error on both routes", async () => {
  const { hook, failNext } = recordingHook();
  const direct = new Error("direct");
  failNext(direct);
  const thrownDirect = await assertRejects(() => signalChange(hook, WRITE));
  assertStrictEquals(thrownDirect, direct);

  const staged = new Error("staged");
  const uow = createLegacyUnitOfWork(hook, { flush: undefined });
  failNext(staged);
  const thrownStaged = await assertRejects(() =>
    runInUnitOfWork(uow, () => signalChange(hook, WRITE))
  );
  assertStrictEquals(thrownStaged, staged);
  assertEquals(uow.staged(), [WRITE]);
});

Deno.test("currentUnitOfWork: undefined outside, innermost inside nested scopes, outer restored after", async () => {
  const outer = createLegacyUnitOfWork(undefined, { flush: undefined });
  const inner = createLegacyUnitOfWork(undefined, { flush: undefined });
  assertStrictEquals(currentUnitOfWork(), undefined);
  await runInUnitOfWork(outer, async () => {
    assertStrictEquals(currentUnitOfWork(), outer);
    await runInUnitOfWork(inner, () => {
      assertStrictEquals(currentUnitOfWork(), inner);
      return Promise.resolve();
    });
    assertStrictEquals(currentUnitOfWork(), outer);
  });
  assertStrictEquals(currentUnitOfWork(), undefined);
});

Deno.test("runInUnitOfWork: returns fn's value and rejects with fn's error", async () => {
  const uow = createLegacyUnitOfWork(undefined, { flush: undefined });
  assertEquals(await runInUnitOfWork(uow, () => Promise.resolve(42)), 42);
  const error = new Error("boom");
  const thrown = await assertRejects(() =>
    runInUnitOfWork(uow, () => Promise.reject(error))
  );
  assertStrictEquals(thrown, error);
  assertStrictEquals(currentUnitOfWork(), undefined);
});

/** Runs `fn` with a reporter that records every route-2 report. */
async function withReports(
  fn: (reports: UnscopedChange[]) => Promise<void>,
): Promise<void> {
  const reports: UnscopedChange[] = [];
  const dispose = useUnscopedChangeReporterForTesting((report) => {
    reports.push(report);
  });
  try {
    await fn(reports);
  } finally {
    dispose();
  }
}

Deno.test("signalChange: route 2 marks exactly as before, then reports each change", async () => {
  await withReports(async (reports) => {
    const { hook, calls } = recordingHook();
    await signalChange(hook, WRITE);
    await signalChange(hook, REMOVE);
    await signalChange(hook, BULK);
    assertEquals(calls, [WRITE.path, REMOVE.path, undefined]);
    assertEquals(reports.map((report) => report.change), [WRITE, REMOVE, BULK]);
  });
});

Deno.test("signalChange: route 2 sends the mark before the reporter runs, and a throwing reporter rejects after it", async () => {
  const { hook, calls } = recordingHook();
  const marksSeen: number[] = [];
  const dispose = useUnscopedChangeReporterForTesting(() => {
    marksSeen.push(calls.length);
    throw new Error("unscoped write");
  });
  try {
    await assertRejects(
      () => signalChange(hook, WRITE),
      Error,
      "unscoped write",
    );
  } finally {
    dispose();
  }
  assertEquals(calls, [WRITE.path]);
  assertEquals(marksSeen, [1]);
});

Deno.test("signalChange: a rejected hook is not reported", async () => {
  await withReports(async (reports) => {
    const { hook, failNext } = recordingHook();
    failNext(new Error("mark failed"));
    await assertRejects(() => signalChange(hook, WRITE), Error, "mark failed");
    assertEquals(reports, []);
  });
});

Deno.test("signalChange: routes 1 and 3 never report", async () => {
  await withReports(async (reports) => {
    const { hook } = recordingHook();
    const uow = createLegacyUnitOfWork(hook, { flush: undefined });
    await runInUnitOfWork(uow, async () => {
      await signalChange(hook, WRITE);
      await signalChange(undefined, WRITE);
    });
    await signalChange(undefined, REMOVE);
    assertEquals(reports, []);
  });
});

Deno.test("signalChange: a scope bound to another hook is route 2 and reports", async () => {
  await withReports(async (reports) => {
    const own = recordingHook();
    const other = recordingHook();
    await runInUnitOfWork(
      createLegacyUnitOfWork(other.hook, { flush: undefined }),
      async () => {
        await signalChange(own.hook, WRITE);
      },
    );
    assertEquals(own.calls, [WRITE.path]);
    assertEquals(reports.map((report) => report.change), [WRITE]);
  });
});

Deno.test("useUnscopedChangeReporterForTesting: refuses a second reporter until the first is disposed", () => {
  const dispose = useUnscopedChangeReporterForTesting(() => {});
  try {
    assertThrows(
      () => useUnscopedChangeReporterForTesting(() => {}),
      Error,
      "already installed",
    );
  } finally {
    dispose();
  }
  useUnscopedChangeReporterForTesting(() => {})();
});

const ROOT = "file:///Users/dev/src/swamp/";

/** A V8 stack trace whose frames are `[name, url, line]`. */
function stackOf(frames: [string | undefined, string, number][]): string {
  return [
    "Error",
    ...frames.map(([name, url, line]) =>
      name === undefined
        ? `    at async ${url}:${line}:5`
        : `    at async ${name} (${url}:${line}:5)`
    ),
  ].join("\n");
}

Deno.test("unscopedCallerFrom: names the first source frame outside the persistence layer", () => {
  const stack = stackOf([
    [
      "signalChange",
      `${ROOT}src/infrastructure/persistence/unit_of_work_scope.ts`,
      114,
    ],
    [
      "FileSystemUnifiedDataRepository.save",
      `${ROOT}src/infrastructure/persistence/unified_data_repository.ts`,
      701,
    ],
    ["reapBatch", `${ROOT}src/serve/bookkeeping_gc.ts`, 256],
    ["runGated", `${ROOT}src/serve/sync_gate.ts`, 40],
  ]);
  assertEquals(unscopedCallerFrom(stack, ROOT), {
    file: "src/serve/bookkeeping_gc.ts",
    line: 256,
    fn: "reapBatch",
  });
});

Deno.test("unscopedCallerFrom: an anonymous frame takes the nearest named frame below it in the same file", () => {
  const stack = stackOf([
    [
      "YamlWorkflowRunRepository.save",
      `${ROOT}src/infrastructure/persistence/yaml_workflow_run_repository.ts`,
      567,
    ],
    [undefined, `${ROOT}src/cli/commands/workflow_cancel.ts`, 440],
    ["Object.withClaim", `${ROOT}src/cli/repo_context.ts`, 1428],
    ["settleCancelledRun", `${ROOT}src/cli/commands/workflow_cancel.ts`, 401],
  ]);
  assertEquals(unscopedCallerFrom(stack, ROOT), {
    file: "src/cli/commands/workflow_cancel.ts",
    line: 440,
    fn: "settleCancelledRun",
  });
});

Deno.test("unscopedCallerFrom: strips Object. and [as alias], and skips runtime and dependency frames", () => {
  const stack = [
    "Error",
    `    at signalChange (${ROOT}src/infrastructure/persistence/unit_of_work_scope.ts:114:21)`,
    "    at async Promise.all (index 0)",
    "    at async ext:cli/40_test.js:300:5",
    "    at async https://jsr.io/@std/async/1.0.0/retry.ts:10:5",
    `    at async Object.createAndSaveDefinition [as saveDefinition] (${ROOT}src/libswamp/worker/run_deps.ts:143:7)`,
  ].join("\n");
  assertEquals(unscopedCallerFrom(stack, ROOT), {
    file: "src/libswamp/worker/run_deps.ts",
    line: 143,
    fn: "createAndSaveDefinition",
  });
});

Deno.test("unscopedCallerFrom: paths are relative to the root, so a checkout under a src directory and the compiled binary both resolve", () => {
  const compiled = "file:///var/folders/x/T/deno-compile-swamp/";
  for (const root of [ROOT, compiled]) {
    const stack = stackOf([
      [
        "save",
        `${root}src/infrastructure/persistence/yaml_definition_repository.ts`,
        747,
      ],
      [undefined, `${root}integration/serve_request_harness.ts`, 90],
    ]);
    assertEquals(unscopedCallerFrom(stack, root), {
      file: "integration/serve_request_harness.ts",
      line: 90,
      fn: undefined,
    });
  }
});

Deno.test("unscopedCallerFrom: with no source frame outside persistence, names the first file frame outside the repository by its URL", () => {
  const stack = [
    "Error",
    `    at signalChange (${ROOT}src/infrastructure/persistence/unit_of_work_scope.ts:114:21)`,
    "    at async ext:cli/40_test.js:300:5",
    // Persistence frames from another layout are never the caller.
    "    at async save (file:///opt/swamp/src/infrastructure/persistence/yaml_definition_repository.ts:747:5)",
    "    at async saveIt (file:///home/me/.swamp/extensions/x/mod.ts:12:3)",
    "    at async later (file:///home/me/.swamp/extensions/x/mod.ts:40:3)",
  ].join("\n");
  assertEquals(unscopedCallerFrom(stack, ROOT), {
    file: "file:///home/me/.swamp/extensions/x/mod.ts",
    line: 12,
    fn: "saveIt",
  });
});

Deno.test("unscopedCallerFrom: undefined when every source frame is in the persistence layer", () => {
  const stack = stackOf([
    [
      "signalChange",
      `${ROOT}src/infrastructure/persistence/unit_of_work_scope.ts`,
      114,
    ],
    [
      undefined,
      `${ROOT}src/infrastructure/persistence/unified_data_repository_test.ts`,
      30,
    ],
  ]);
  assertEquals(unscopedCallerFrom(stack, ROOT), undefined);
});
