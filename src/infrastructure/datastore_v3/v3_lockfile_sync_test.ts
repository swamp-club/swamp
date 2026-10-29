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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import { configEditConflictOf } from "../../domain/datastore_v3/config_edit_conflict.ts";
import type { PutExpect } from "../../domain/datastore_v3/op.ts";
import { MemoryStorage } from "../../domain/datastore_v3/v3_test_helpers.ts";
import { runInCommitLogRoot } from "./commit_log_root.ts";
import {
  contextHook,
  MemorySink,
  unitOptions,
} from "./commit_log_test_helpers.ts";
import {
  commitLogParentFor,
  createCommitLogUnitOfWork,
} from "./commit_log_unit_of_work.ts";
import { createV3LockfileSync } from "./v3_lockfile_sync.ts";
import {
  bindCommitLogEngine,
  runInRootUnitOfWork,
} from "../persistence/repo_unit_of_work.ts";
import { sha256Hex } from "../persistence/config_staging.ts";
import { currentUnitOfWork } from "../persistence/unit_of_work_scope.ts";

const PUBLISH = { mustUpload: true, earlierChangeOnly: false };

/** One checkout's lockfile, committing to `sink`. */
async function checkout(
  dir: string,
  name: string,
  sink: MemorySink,
): Promise<{ hook: MarkDirtyHook; lockfilePath: string; configBase: string }> {
  const configBase = join(dir, name, ".swamp", "config");
  await Deno.mkdir(configBase, { recursive: true });
  const hook = contextHook();
  const options = unitOptions(sink, new MemoryStorage());
  bindCommitLogEngine(hook, {
    openUnit: () =>
      createCommitLogUnitOfWork(hook, {
        ...options,
        parent: currentUnitOfWork(),
      }),
    hasOpenUnit: () =>
      commitLogParentFor(hook, currentUnitOfWork()) !== undefined,
    checkpointOpenUnit: () => Promise.resolve("no-unit"),
    committedBeforeThrowing: () => false,
    runRoot: (_rootOptions, fn) =>
      runInCommitLogRoot({ markDirty: hook }, options, (root) => fn(root)),
  });
  return {
    hook,
    lockfilePath: join(configBase, "upstream_extensions.json"),
    configBase,
  };
}

/** Runs one transaction's hydrate, its change and its publishes. */
async function transaction(
  side: { hook: MarkDirtyHook; lockfilePath: string; configBase: string },
  stored: PutExpect,
  change: () => Promise<void>,
  publishes = 1,
): Promise<void> {
  const sync = createV3LockfileSync({
    markDirty: side.hook,
    lockfilePath: side.lockfilePath,
    configBase: side.configBase,
    commitLog: { storedVersion: () => Promise.resolve(stored) },
  });
  await runInRootUnitOfWork(
    { markDirty: side.hook },
    { flush: undefined, checkpoint: () => Promise.resolve() },
    async () => {
      await sync.hydrate();
      await change();
      for (let i = 0; i < publishes; i++) {
        await Deno.writeTextFile(side.lockfilePath, `{"publish":${i}}`);
        await sync.publish(PUBLISH);
      }
    },
  );
}

async function versionOf(text: string): Promise<PutExpect> {
  return { sha256: await sha256Hex(new TextEncoder().encode(text)) };
}

Deno.test("createV3LockfileSync: a publish over a lockfile another checkout changed since the transaction started is refused as a lockfile edit conflict", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-lockfile-" });
  try {
    const sink = new MemorySink();
    const a = await checkout(dir, "a", sink);
    const b = await checkout(dir, "b", sink);
    // B starts from no lockfile; A lands one while B's change runs.
    const error = await assertRejects(() =>
      transaction(b, "absent", async () => {
        await Deno.writeTextFile(a.lockfilePath, "{}");
        await transaction(a, "absent", () => Promise.resolve());
      })
    );
    const conflict = configEditConflictOf(error);
    assert(conflict !== undefined, `not an edit conflict: ${error}`);
    assertEquals(conflict.code, "config_edit_conflict");
    assertEquals(conflict.conflicts.map((c) => c.kind), ["lockfile"]);
    assert(conflict.message.includes("Pull and retry"), conflict.message);
    // A's lockfile stands.
    assertEquals(sink.landed.length, 1);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("createV3LockfileSync: a publish over the lockfile the transaction started from lands, and so does the transaction's next publish", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-lockfile-" });
  try {
    const sink = new MemorySink();
    const a = await checkout(dir, "a", sink);
    await transaction(a, "absent", () => Promise.resolve());
    await transaction(
      a,
      await versionOf('{"publish":0}'),
      () => Promise.resolve(),
      2,
    );
    assertEquals(sink.landed.length, 3);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
