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
 * Probing a recorded pid never disturbs it (swamp-club#3564): a stopped
 * process stays stopped through every liveness probe swamp runs, v3 writer
 * lease and non-v3 locks alike, and a zombie holder is taken over at once.
 * These spawn real children, so they live here rather than beside the
 * probes. POSIX only: Windows has no stopped or zombie processes to probe.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { hostname } from "node:os";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { reclaimModelLocks } from "../src/cli/repo_context.ts";
import { FileLock } from "../src/infrastructure/persistence/file_lock.ts";
import { localOwnerLiveness } from "../src/infrastructure/persistence/run_tracker_store.ts";
import { isProcessGone } from "../src/infrastructure/runtime/process.ts";
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import {
  closeV3Datastores,
  v3RepositoryFactoryConfig,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import {
  acquireV3WriterLock,
  V3WriterBusyError,
  v3WriterFence,
  v3WriterLockHandle,
} from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import {
  plantV3WriterLease,
  thisKernelIdentity,
} from "../src/infrastructure/datastore_v3/v3_writer_lock_test_helpers.ts";

await initializeLogging({});

const posix = Deno.build.os !== "windows";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-probe-signals-" });
  try {
    await fn(dir);
  } finally {
    await closeV3Datastores().catch(() => {});
    await Deno.remove(dir, { recursive: true });
  }
}

/** The process state `ps` reports: `T` stopped, `Z` zombie, `S` sleeping. */
function stateOf(pid: number): string {
  const { stdout } = new Deno.Command("ps", {
    args: ["-o", "stat=", "-p", String(pid)],
    stdout: "piped",
  }).outputSync();
  return new TextDecoder().decode(stdout).trim().slice(0, 1);
}

/** Runs `fn` with a stopped child, killed after. */
async function withStoppedChild(
  fn: (pid: number) => Promise<void>,
): Promise<void> {
  const child = new Deno.Command("sleep", { args: ["60"] }).spawn();
  try {
    Deno.kill(child.pid, "SIGSTOP");
    for (let i = 0; i < 100 && stateOf(child.pid) !== "T"; i++) {
      await new Promise((done) => setTimeout(done, 10));
    }
    assertEquals(stateOf(child.pid), "T");
    await fn(child.pid);
    assertEquals(stateOf(child.pid), "T", "still stopped after the probes");
  } finally {
    child.kill("SIGKILL");
    await child.status;
  }
}

Deno.test({
  name:
    "v3 writer lease: inspecting, acquiring and a read-only open leave a stopped holder stopped",
  ignore: !posix,
  async fn() {
    await withStoppedChild(async (pid) => {
      await withTempDir(async (dir) => {
        const datastorePath = join(dir, "datastore");
        await initializeV3Datastore(datastorePath, "test");
        const repoDir = join(dir, "repo");
        await Deno.mkdir(repoDir);
        const planted = await plantV3WriterLease(datastorePath, { pid });
        await Deno.writeTextFile(
          join(datastorePath, "_control", "writer.checkout.json"),
          JSON.stringify({
            repoDir: await Deno.realPath(repoDir),
            hostname: Deno.hostname(),
            pid,
            process: await thisKernelIdentity(),
            fence: planted.fence,
          }),
        );
        assertEquals(
          (await v3WriterLockHandle(datastorePath).inspect())?.pid,
          pid,
        );
        await assertRejects(
          () => acquireV3WriterLock(datastorePath, { maxWaitMs: 0 }),
          V3WriterBusyError,
        );
        await v3RepositoryFactoryConfig(repoDir, {
          type: "filesystem",
          path: datastorePath,
        });
      });
    });
  },
});

Deno.test({
  name: "FileLock: judging a stale holder leaves a stopped holder stopped",
  ignore: !posix,
  async fn() {
    await withStoppedChild(async (pid) => {
      await withTempDir(async (dir) => {
        const lock = new FileLock(dir, {
          lockKey: "test.lock",
          maxWaitMs: 50,
          retryIntervalMs: 10,
        });
        await Deno.writeTextFile(
          join(dir, "test.lock"),
          JSON.stringify({
            holder: "other",
            hostname: hostname(),
            pid,
            acquiredAt: new Date().toISOString(),
            ttlMs: 60_000,
            nonce: crypto.randomUUID(),
          }),
        );
        await assertRejects(() => lock.acquire());
      });
    });
  },
});

Deno.test({
  name:
    "run tracker and serve's orphaned-run reaper: their probe leaves a stopped owner stopped",
  ignore: !posix,
  async fn() {
    await withStoppedChild((pid) => {
      assertEquals(localOwnerLiveness().isDead(pid), false);
      // The probe serve hands reapOrphanedWorkflowRuns.
      assertEquals(isProcessGone(pid), false);
      return Promise.resolve();
    });
  },
});

Deno.test({
  name:
    "reclaimModelLocks: waiting on a structural command leaves its stopped process stopped",
  ignore: !posix,
  async fn() {
    await withStoppedChild(async (pid) => {
      await withTempDir(async (dir) => {
        const model = new FileLock(dir, { lockKey: "model.lock" });
        await model.acquire();
        try {
          // A structural command still at work under the lock this run
          // hands down: reclaiming waits on it, probing its pid.
          const skipping = [
            JSON.parse(await Deno.readTextFile(join(dir, "model.lock"))).nonce,
          ];
          await assertRejects(() =>
            reclaimModelLocks([model], {
              inspect: () =>
                Promise.resolve({
                  holder: "structural",
                  hostname: hostname(),
                  pid,
                  acquiredAt: new Date().toISOString(),
                  ttlMs: 60_000,
                  nonce: "global",
                  skipping,
                }),
            }, {
              timeoutMs: 50,
              pollMs: 10,
              progressWriter: () => {},
            })
          );
        } finally {
          await model.release();
        }
      });
    });
  },
});

Deno.test({
  name: "v3 writer lease: a zombie holder on this kernel is taken over at once",
  ignore: !posix,
  async fn() {
    // The parent never reaps the child that exits at once.
    const parent = new Deno.Command("sh", {
      args: ["-c", "sleep 0.05 & exec sleep 60"],
    }).spawn();
    try {
      let zombie: number | undefined;
      for (let i = 0; i < 200 && zombie === undefined; i++) {
        await new Promise((done) => setTimeout(done, 10));
        const { stdout } = new Deno.Command("ps", {
          args: ["-A", "-o", "pid=,ppid=,stat="],
          stdout: "piped",
        }).outputSync();
        for (const line of new TextDecoder().decode(stdout).split("\n")) {
          const [child, ppid, stat] = line.trim().split(/\s+/);
          if (ppid === String(parent.pid) && stat?.startsWith("Z")) {
            zombie = Number(child);
          }
        }
      }
      assert(zombie !== undefined, "the child became a zombie");
      await withTempDir(async (dir) => {
        await plantV3WriterLease(dir, { pid: zombie });
        const release = await acquireV3WriterLock(dir, { maxWaitMs: 0 });
        try {
          assertEquals(v3WriterFence(dir), 2);
        } finally {
          await release();
        }
      });
    } finally {
      parent.kill("SIGKILL");
      await parent.status;
    }
  },
});
