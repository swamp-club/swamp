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
import { dirname, join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoService } from "../../domain/repo/repo_service.ts";
import { UserError } from "../../domain/errors.ts";
import { createDatastoreLock } from "../../infrastructure/persistence/datastore_global_lock.ts";
import { FileLock } from "../../infrastructure/persistence/file_lock.ts";
import {
  formatTicketName,
  fsLockQueueOps,
  lockQueueDir,
} from "../../infrastructure/persistence/lock_queue.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { modelLockKey } from "../../libswamp/datastores/lock.ts";
import { createModelLock, resolveDatastoreForRepo } from "../repo_context.ts";
import { VERSION } from "../../infrastructure/runtime/build_info.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

async function withRepo(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-datastore-lock-" });
  try {
    const homeDir = join(dir, "test-home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(dir), { tools: [] });
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function release(dir: string, args: string[]): Promise<void> {
  const { datastoreLockCommand } = await import("./datastore_lock.ts");
  const originalLog = console.log;
  console.log = () => {};
  try {
    await new Command()
      .globalOption("--json", "JSON output")
      .command("lock", datastoreLockCommand)
      .parse([
        "lock",
        "release",
        "--force",
        "--repo-dir",
        dir,
        ...args,
        "--json",
      ]);
  } finally {
    console.log = originalLog;
  }
}

// --behavior and its alias --model fill one option; a read of the old key would
// find nothing and release the global lock instead
for (const flag of ["--behavior", "--model"]) {
  Deno.test({
    name:
      `datastore lock release: ${flag} releases that behavior's lock, not the global one`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await withRepo(async (dir) => {
        const { datastoreConfig } = await resolveDatastoreForRepo(dir);
        const modelLock = await createModelLock(
          datastoreConfig,
          "aws-ec2",
          "my-server",
        );
        const globalLock = await createDatastoreLock(datastoreConfig);
        await modelLock.acquire();
        await globalLock.acquire();
        try {
          await release(dir, [flag, "aws-ec2/my-server"]);
          assertEquals(await modelLock.inspect(), null, "behavior lock");
          assert(await globalLock.inspect() !== null, "global lock kept");
        } finally {
          await globalLock.release();
          await modelLock.release().catch(() => {});
        }
      });
    },
  });

  Deno.test({
    name:
      `datastore lock release: ${flag} names a behavior by name too, and one that does not exist is refused naming the type/id form`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      await withRepo(async (dir) => {
        await assertRejects(
          () => release(dir, [flag, "no-such-behavior"]),
          UserError,
          "type/id",
        );
      });
    },
  });
}

async function statusDocuments(dir: string): Promise<unknown[]> {
  const { datastoreLockCommand } = await import("./datastore_lock.ts");
  const printed: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => printed.push(args.join(" "));
  try {
    await new Command()
      .globalOption("--json", "JSON output")
      .command("lock", datastoreLockCommand)
      .parse(["lock", "status", "--repo-dir", dir, "--json"]);
  } finally {
    console.log = originalLog;
  }
  return printed.map((text) => JSON.parse(text));
}

// swamp-uat reads one document per lock; a waiter's ticket must not add one
Deno.test({
  name:
    "datastore lock status: --json prints the same documents while runs are queued for a behavior's lock",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withRepo(async (dir) => {
      const { datastoreConfig } = await resolveDatastoreForRepo(dir);
      if (isCustomDatastoreConfig(datastoreConfig)) {
        throw new Error("expected a filesystem datastore");
      }
      const modelId = crypto.randomUUID();
      const lockKey = modelLockKey(
        datastoreConfig.namespace,
        "aws-ec2",
        modelId,
      );
      // a holder that never rewrites its file, so both reads see one record
      const lockPath = join(datastoreConfig.path, lockKey);
      await Deno.mkdir(dirname(lockPath), { recursive: true });
      await Deno.writeTextFile(
        lockPath,
        JSON.stringify({
          holder: "run@this-host",
          hostname: "this-host",
          pid: Deno.pid,
          acquiredAt: new Date().toISOString(),
          ttlMs: 600_000,
          nonce: crypto.randomUUID(),
        }),
      );
      const before = await statusDocuments(dir);
      assert(
        before.some((doc) => JSON.stringify(doc).includes(modelId)),
        "the behavior's lock is listed",
      );

      const queueDir = await lockQueueDir(
        datastoreConfig.path,
        undefined,
        lockKey,
      );
      await Deno.mkdir(queueDir, { recursive: true });
      await Deno.writeTextFile(
        join(
          queueDir,
          formatTicketName({
            seq: 1,
            hostIdHash: "ffffffff",
            pid: 1,
            nonce: "0".repeat(32),
          }),
        ),
        "",
      );
      const waiter = new FileLock(datastoreConfig.path, {
        lockKey,
        fairQueue: true,
        retryIntervalMs: 10,
        maxWaitMs: 120_000,
      });
      const abort = new AbortController();
      const waiting = waiter.acquire(abort.signal);
      try {
        await waitFor(
          async () => ((await fsLockQueueOps.list(queueDir)) ?? []).length >= 2,
          "the waiter queued",
        );
        assertEquals(await statusDocuments(dir), before);
      } finally {
        abort.abort(new Error("done"));
        await assertRejects(() => waiting);
      }
    });
  },
});
