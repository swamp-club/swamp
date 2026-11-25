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

import { assert, assertEquals } from "@std/assert";
import { copy, exists, walk } from "@std/fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import fc from "fast-check";
import { waitFor } from "@swamp-club/swamp-testing";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import { listWriterMarkerFiles } from "../src/infrastructure/datastore_v3/interrupted_writer_recovery.ts";
import { v3CatalogPath } from "../src/infrastructure/datastore_v3/record_path_guard.ts";
import { closeV3Datastores } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { startProcessHost } from "./process_host.ts";
import { assertCheckoutsAgree, withV3RowRepos } from "./usecase_v3_fixtures.ts";
import {
  localWriterHost,
  type LocalWriterMessage,
  type LocalWriterRequest,
} from "./v3_local_writer_host.ts";

interface Writer {
  send(request: LocalWriterRequest): void;
  messages: LocalWriterMessage[];
  seen(
    test: (message: LocalWriterMessage) => boolean,
    description: string,
  ): Promise<LocalWriterMessage>;
  stop(): void;
}

function startWriter(name: string): Writer {
  const messages: LocalWriterMessage[] = [];
  const host = startProcessHost<LocalWriterRequest, LocalWriterMessage>(
    name,
    localWriterHost,
    (message) => messages.push(message),
  );
  return {
    send: (request) => host.postMessage(request),
    messages,
    async seen(test, description) {
      await waitFor(
        () => messages.some(test) || messages.some((m) => "failed" in m),
        description,
        { timeoutMs: 60_000 },
      );
      const failed = messages.find((m) => "failed" in m);
      if (failed !== undefined && "failed" in failed) {
        throw new Error(`${name} failed: ${failed.failed}`);
      }
      return messages.find(test)!;
    },
    stop: () => host.terminate(),
  };
}

async function opened(writer: Writer, repoDir: string, type: string) {
  writer.send({ kind: "open", repoDir, type });
  await writer.seen((m) => "opened" in m, "the writer opened its checkout");
}

async function closed(writer: Writer) {
  writer.send({ kind: "close" });
  await writer.seen((m) => "closed" in m, "the writer closed");
  writer.stop();
}

async function written(writer: Writer, id: string): Promise<number> {
  return (await landed(writer, id)).version;
}

async function landed(
  writer: Writer,
  id: string,
): Promise<{ version: number; count: number }> {
  const message = await writer.seen(
    (m) => "written" in m && m.written === id,
    `write ${id}`,
  );
  return "written" in message
    ? { version: message.version, count: message.count }
    : { version: -1, count: -1 };
}

/** a short lock wait, so a writer the old whole-command hold blocks fails fast */
const QUICK_LOCK = { SWAMP_LOCK_TIMEOUT_MS: "3000" };

Deno.test({
  name:
    "v3 local commit sections: a writer paused mid-command does not keep another checkout's writer of another behavior waiting",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3RowRepos({}, async (repos, datastorePath) => {
      await closeV3Datastores();
      await withMockedEnv(QUICK_LOCK, async () => {
        const slow = startWriter("slow");
        const quick = startWriter("quick");
        try {
          const type = repos.modelType.normalized;
          await opened(slow, repos.repoA, type);
          slow.send({
            kind: "write",
            id: "slow-1",
            model: "slow-model",
            data: "d",
            pause: true,
          });
          await slow.seen((m) => "paused" in m, "the slow step is under way");
          await opened(quick, repos.repoB, type);
          quick.send({
            kind: "write",
            id: "quick-1",
            model: "quick-model",
            data: "d",
          });
          assertEquals(await written(quick, "quick-1"), 1);
          assertEquals(
            slow.messages.some((m) => "written" in m),
            false,
            "the quick write landed while the slow one was still under way",
          );
          slow.send({ kind: "resume", id: "slow-1" });
          assertEquals(await written(slow, "slow-1"), 1);
          await closed(slow);
          await closed(quick);
        } finally {
          slow.stop();
          quick.stop();
        }
      });
      await assertCheckoutsAgree(repos, datastorePath, "after both");
    });
  },
});

Deno.test({
  name:
    "v3 local commit sections: writers in two checkouts land every write once, in each writer's order, whatever the interleaving",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const plan = fc.array(
      fc.record({
        writer: fc.integer({ min: 0, max: 1 }),
        model: fc.integer({ min: 0, max: 2 }),
        pause: fc.boolean(),
      }),
      { minLength: 2, maxLength: 8 },
    );
    await fc.assert(
      fc.asyncProperty(plan, fc.scheduler(), async (writes, scheduler) => {
        await withV3RowRepos({}, async (repos, datastorePath) => {
          await closeV3Datastores();
          const writers = [startWriter("w0"), startWriter("w1")];
          try {
            const type = repos.modelType.normalized;
            await opened(writers[0], repos.repoA, type);
            await opened(writers[1], repos.repoB, type);
            const expected = new Map<string, number>();
            const pending = writes.map((write, index) => {
              const writer = writers[write.writer];
              // each writer owns its behaviors, as per-behavior locks keep it
              const model = `w${write.writer}-m${write.model}`;
              expected.set(model, (expected.get(model) ?? 0) + 1);
              const id = `op-${index}`;
              return scheduler.schedule(Promise.resolve(), id).then(
                async () => {
                  writer.send({
                    kind: "write",
                    id,
                    model,
                    data: "d",
                    pause: write.pause,
                    lock: true,
                  });
                  if (write.pause) {
                    await writer.seen(
                      (m) => "paused" in m && m.paused === id,
                      `${id} paused`,
                    );
                    await scheduler.schedule(Promise.resolve(), `${id} resume`);
                    writer.send({ kind: "resume", id });
                  }
                  return { model, version: await written(writer, id) };
                },
              );
            });
            const landed = await scheduler.waitFor(Promise.all(pending));
            for (const writer of writers) await closed(writer);
            // each behavior's versions are 1..n, none lost, none twice
            for (const [model, count] of expected) {
              const versions = landed
                .filter((write) => write.model === model)
                .map((write) => write.version)
                .sort((a, b) => a - b);
              assertEquals(
                versions,
                Array.from({ length: count }, (_, i) => i + 1),
                model,
              );
            }
            await assertCheckoutsAgree(repos, datastorePath, "interleaved");
          } finally {
            for (const writer of writers) writer.stop();
          }
        });
      }),
      { numRuns: 6 },
    );
  },
});

Deno.test({
  name:
    "v3 local commit sections: writers in two checkouts take turns on one behavior by its lock, and every version lands",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3RowRepos({}, async (repos, datastorePath) => {
      await closeV3Datastores();
      const writers = [startWriter("a"), startWriter("b")];
      try {
        const type = repos.modelType.normalized;
        await opened(writers[0], repos.repoA, type);
        writers[0].send({
          kind: "write",
          id: "seed",
          model: "shared",
          data: "d",
          lock: true,
        });
        assertEquals(await written(writers[0], "seed"), 1);
        // definitions live in the repo, shared through git, not the datastore
        await copy(join(repos.repoA, "models"), join(repos.repoB, "models"), {
          overwrite: true,
        });
        await opened(writers[1], repos.repoB, type);
        const rounds = 3;
        // the writers alternate, so each writes when the other's commit is the
        // behavior's latest
        const versions: number[] = [];
        const counts: number[] = [];
        for (let turn = 0; turn < rounds * 2; turn++) {
          const writer = writers[turn % 2];
          const id = `turn-${turn}`;
          writer.send({
            kind: "write",
            id,
            model: "shared",
            data: "d",
            lock: true,
          });
          const { version, count } = await landed(writer, id);
          versions.push(version);
          counts.push(count);
        }
        // each turn read the other's count under the lock: no update is lost
        assertEquals(
          counts,
          Array.from({ length: rounds * 2 }, (_, i) => i + 2),
          "each turn counts on from the turn before",
        );
        for (const writer of writers) await closed(writer);
        assertEquals(
          versions,
          Array.from({ length: rounds * 2 }, (_, i) => i + 2),
          "each turn writes the next version",
        );
        const store = SqliteCommitStore.open(join(datastorePath, "commits.db"));
        try {
          const fences = (await store.changesSince(0, 10_000)).map((change) =>
            change.commit.fence ?? 0
          );
          assert(
            fences.every((fence, i) => i === 0 || fence >= fences[i - 1]),
            "fences never go back",
          );
        } finally {
          await store.close();
        }
        await assertCheckoutsAgree(repos, datastorePath, "shared behavior");
      } finally {
        for (const writer of writers) writer.stop();
      }
    });
  },
});

/** the latest-version marker of a data name in a checkout, or undefined */
async function latestOf(
  repoDir: string,
  dataName: string,
): Promise<string | undefined> {
  for await (
    const entry of walk(join(repoDir, ".swamp", "data"), {
      includeDirs: false,
      followSymlinks: false,
    })
  ) {
    if (entry.path.endsWith(join(dataName, "latest"))) {
      return (await Deno.readTextFile(entry.path)).trim();
    }
  }
  return undefined;
}

Deno.test({
  name:
    "v3 local commit sections: another process's catch-up in the same checkout leaves a paused writer's uncommitted files",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3RowRepos({}, async (repos, datastorePath) => {
      await closeV3Datastores();
      const writer = startWriter("writer");
      const reader = startWriter("reader");
      try {
        const type = repos.modelType.normalized;
        await opened(reader, repos.repoA, type);
        await opened(writer, repos.repoA, type);
        writer.send({
          kind: "write",
          id: "v1",
          model: "m",
          data: "d-w",
          lock: true,
        });
        assertEquals(await written(writer, "v1"), 1);
        writer.send({
          kind: "write",
          id: "v2",
          model: "m",
          data: "d-w",
          lock: true,
          pause: true,
        });
        await writer.seen((m) => "paused" in m, "v2 staged");
        assertEquals(await latestOf(repos.repoA, "d-w"), "2");
        reader.send({ kind: "catchUp" });
        await reader.seen((m) => "caughtUp" in m, "the reader caught up");
        assertEquals(
          await latestOf(repos.repoA, "d-w"),
          "2",
          "the catch-up replayed v1 over the writer's staged v2",
        );
        writer.send({ kind: "resume", id: "v2" });
        assertEquals(await written(writer, "v2"), 2);
        await closed(writer);
        await closed(reader);
        await assertCheckoutsAgree(repos, datastorePath, "after v2");
      } finally {
        writer.stop();
        reader.stop();
      }
    });
  },
});

/** as a checkout tracking its writes long before any writer started */
function backdateTracking(repoDir: string): void {
  const db = new DatabaseSync(v3CatalogPath(repoDir));
  try {
    db.prepare(
      "UPDATE catalog_meta SET value = '0' WHERE key IN ('dirty_tracking_since', 'touched_tracking_since')",
    ).run();
  } finally {
    db.close();
  }
}

/**
 * a killed writer with an uncommitted v2 of d-k and a live one with an
 * uncommitted v1 of d-l, both in repoA; returns the three writers
 */
async function killOneBesideALive(
  repos: Parameters<Parameters<typeof withV3RowRepos>[1]>[0],
  writers: { killed: Writer; live: Writer },
): Promise<void> {
  const { killed, live } = writers;
  const type = repos.modelType.normalized;
  await opened(killed, repos.repoA, type);
  await opened(live, repos.repoA, type);
  killed.send({
    kind: "write",
    id: "k1",
    model: "mk",
    data: "d-k",
    lock: true,
  });
  assertEquals(await written(killed, "k1"), 1);
  killed.send({
    kind: "write",
    id: "k2",
    model: "mk",
    data: "d-k",
    pause: true,
  });
  await killed.seen((m) => "paused" in m, "k2 staged");
  live.send({ kind: "write", id: "l1", model: "ml", data: "d-l", pause: true });
  await live.seen((m) => "paused" in m, "l1 staged");
  assertEquals(await latestOf(repos.repoA, "d-k"), "2");
  killed.send({ kind: "die" });
  killed.stop();
}

async function stagedVersionExists(
  repoDir: string,
  dataName: string,
  version: number,
): Promise<boolean> {
  for await (
    const entry of walk(join(repoDir, ".swamp", "data"), {
      includeFiles: false,
      followSymlinks: false,
    })
  ) {
    if (entry.path.endsWith(join(dataName, String(version)))) {
      return await exists(join(entry.path, "raw"));
    }
  }
  return false;
}

Deno.test({
  name:
    "v3 local commit sections: beside a live writer, a killed writer's recovery repairs only its own scopes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3RowRepos({}, async (repos, datastorePath) => {
      await closeV3Datastores();
      const killed = startWriter("killed");
      const live = startWriter("live");
      const next = startWriter("next");
      try {
        await killOneBesideALive(repos, { killed, live });
        backdateTracking(repos.repoA);
        await opened(next, repos.repoA, repos.modelType.normalized);
        next.send({ kind: "write", id: "n1", model: "mn", data: "d-n" });
        assertEquals(await written(next, "n1"), 1);
        assertEquals(
          await stagedVersionExists(repos.repoA, "d-k", 2),
          false,
          "the killed writer's uncommitted v2 is removed",
        );
        assertEquals(await latestOf(repos.repoA, "d-k"), "1");
        assertEquals(
          await stagedVersionExists(repos.repoA, "d-l", 1),
          true,
          "the live writer's staged v1 survived the recovery",
        );
        assertEquals(await latestOf(repos.repoA, "d-l"), "1");
        live.send({ kind: "resume", id: "l1" });
        assertEquals(await written(live, "l1"), 1);
        await closed(live);
        await closed(next);
        await assertCheckoutsAgree(repos, datastorePath, "after recovery");
      } finally {
        killed.stop();
        live.stop();
        next.stop();
      }
    });
  },
});

Deno.test({
  name:
    "v3 local commit sections: a killed writer's recovery that needs the whole checkout waits while another writer writes it, then runs",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3RowRepos({}, async (repos, datastorePath) => {
      await closeV3Datastores();
      const killed = startWriter("killed");
      const live = startWriter("live");
      const next = startWriter("next");
      const after = startWriter("after");
      try {
        await killOneBesideALive(repos, { killed, live });
        // a checkout that began tracking just now cannot bound the recovery
        await opened(next, repos.repoA, repos.modelType.normalized);
        next.send({ kind: "write", id: "n1", model: "mn", data: "d-n" });
        assertEquals(await written(next, "n1"), 1);
        assertEquals(
          await stagedVersionExists(repos.repoA, "d-l", 1),
          true,
          "the live writer's staged v1 survived",
        );
        assertEquals(
          (await listWriterMarkerFiles(repos.repoA)).length,
          3,
          "the killed writer's marker waits beside the two live ones",
        );
        live.send({ kind: "resume", id: "l1" });
        assertEquals(await written(live, "l1"), 1);
        await closed(live);
        await closed(next);
        await opened(after, repos.repoA, repos.modelType.normalized);
        after.send({ kind: "write", id: "a1", model: "ma", data: "d-a" });
        assertEquals(await written(after, "a1"), 1);
        await closed(after);
        assertEquals(await listWriterMarkerFiles(repos.repoA), []);
        assertEquals(await stagedVersionExists(repos.repoA, "d-k", 2), false);
        await assertCheckoutsAgree(repos, datastorePath, "once quiet");
      } finally {
        killed.stop();
        live.stop();
        next.stop();
        after.stop();
      }
    });
  },
});
