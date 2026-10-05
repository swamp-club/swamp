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

import { assertEquals, assertRejects } from "@std/assert";
import type { MarkDirtyHook } from "../domain/datastore/datastore_sync_service.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { openRepoUnitOfWork } from "../infrastructure/persistence/repo_unit_of_work.ts";
import { runCommandInRootUnit } from "./command_root_unit.ts";

await initializeLogging({});

/** A mark hook and push/release steps that record what ran, in order. */
function recorder(
  options: { failPush?: string; failRelease?: string } = {},
) {
  const events: string[] = [];
  const markDirty: MarkDirtyHook = (absPath?: string) => {
    events.push(absPath === undefined ? "mark(bulk)" : `mark ${absPath}`);
    return Promise.resolve();
  };
  const push = () => {
    events.push("push");
    return options.failPush === undefined
      ? Promise.resolve()
      : Promise.reject(new Error(options.failPush));
  };
  const release = () => {
    events.push("release");
    return options.failRelease === undefined
      ? Promise.resolve()
      : Promise.reject(new Error(options.failRelease));
  };
  return { events, repoContext: { markDirty }, push, release };
}

Deno.test("runCommandInRootUnit: pushes once when the root ends, then releases", async () => {
  const { events, repoContext, push, release } = recorder();
  const value = await runCommandInRootUnit(
    repoContext,
    { push, release },
    async (root) => {
      events.push("fn");
      await root.stage({ kind: "bulk", reason: "test" });
      return 42;
    },
  );
  assertEquals(value, 42);
  assertEquals(events, ["fn", "mark(bulk)", "push", "release"]);
});

Deno.test("runCommandInRootUnit: always pushes and releases when fn throws", async () => {
  const { events, repoContext, push, release } = recorder();
  await assertRejects(
    () =>
      runCommandInRootUnit(repoContext, { push, release }, () => {
        events.push("fn");
        return Promise.reject(new Error("use case failed"));
      }),
    Error,
    "use case failed",
  );
  assertEquals(events, ["fn", "push", "release"]);
});

Deno.test("runCommandInRootUnit: pushWhen completed skips the push when fn throws", async () => {
  const { events, repoContext, push, release } = recorder();
  await assertRejects(
    () =>
      runCommandInRootUnit(
        repoContext,
        { push, release, pushWhen: "completed" },
        () => Promise.reject(new Error("use case failed")),
      ),
    Error,
    "use case failed",
  );
  assertEquals(events, ["release"]);
});

Deno.test("runCommandInRootUnit: pushWhen completed pushes when fn resolves", async () => {
  const { events, repoContext, push } = recorder();
  await runCommandInRootUnit(
    repoContext,
    { push, pushWhen: "completed" },
    () => Promise.resolve(),
  );
  assertEquals(events, ["push"]);
});

Deno.test("runCommandInRootUnit: a push error is thrown after the release when fn resolved", async () => {
  const { events, repoContext, push, release } = recorder({
    failPush: "push failed",
  });
  await assertRejects(
    () =>
      runCommandInRootUnit(
        repoContext,
        { push, release },
        () => Promise.resolve(),
      ),
    Error,
    "push failed",
  );
  assertEquals(events, ["push", "release"]);
});

Deno.test("runCommandInRootUnit: fn's error wins over a push error without a handler", async () => {
  const { repoContext, push, release } = recorder({ failPush: "push failed" });
  await assertRejects(
    () =>
      runCommandInRootUnit(
        repoContext,
        { push, release },
        () => Promise.reject(new Error("use case failed")),
      ),
    Error,
    "use case failed",
  );
});

Deno.test("runCommandInRootUnit: a release error replaces the push error, as a finally does", async () => {
  const { events, repoContext, push, release } = recorder({
    failPush: "push failed",
    failRelease: "release failed",
  });
  const reported: string[] = [];
  await runCommandInRootUnit(
    repoContext,
    {
      push,
      release,
      onCleanupError: (error) => reported.push((error as Error).message),
    },
    () => Promise.resolve(),
  );
  assertEquals(events, ["push", "release"]);
  assertEquals(reported, ["release failed"]);
});

Deno.test("runCommandInRootUnit: the cleanup handler sees the push error and fn's value is returned", async () => {
  const { repoContext, push, release } = recorder({ failPush: "push failed" });
  const reported: string[] = [];
  const value = await runCommandInRootUnit(
    repoContext,
    {
      push,
      release,
      onCleanupError: (error) => reported.push((error as Error).message),
    },
    () => Promise.resolve("done"),
  );
  assertEquals(value, "done");
  assertEquals(reported, ["push failed"]);
});

Deno.test("runCommandInRootUnit: an error the cleanup handler throws propagates", async () => {
  const { repoContext, push } = recorder({ failPush: "push failed" });
  await assertRejects(
    () =>
      runCommandInRootUnit(
        repoContext,
        {
          push,
          onCleanupError: () => {
            throw new Error("unpublished");
          },
        },
        () => Promise.resolve(),
      ),
    Error,
    "unpublished",
  );
});

Deno.test("runCommandInRootUnit: without a push the root still stages and nothing pushes", async () => {
  const { events, repoContext, release } = recorder();
  await runCommandInRootUnit(
    repoContext,
    { push: undefined, release },
    async (root) => {
      await root.stage({ kind: "write", path: "/cache/a" });
    },
  );
  assertEquals(events, ["mark /cache/a", "release"]);
});

Deno.test("runCommandInRootUnit: a use case's unit opened inside fn rolls up into the root", async () => {
  const { events, repoContext, push } = recorder();
  let staged: string[] = [];
  await runCommandInRootUnit(repoContext, { push }, async (root) => {
    const child = openRepoUnitOfWork(repoContext.markDirty);
    await child.stage({ kind: "write", path: "/cache/a" });
    await child.commit();
    await root.stage({ kind: "bulk", reason: "test" });
    staged = root.staged().map((change) =>
      change.kind === "bulk" ? "bulk" : change.path
    );
  });
  assertEquals(staged, ["/cache/a", "bulk"]);
  assertEquals(events, ["mark /cache/a", "mark(bulk)", "push"]);
});
