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
import { walk } from "@std/fs";
import { basename, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  openV3Datastore,
  v3OutboxPath,
  v3SharedCommitsDbPath,
} from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { closeV3Datastores } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { acquireV3WriterLock } from "../src/infrastructure/datastore_v3/v3_writer_lock.ts";
import { startProcessHost } from "./process_host.ts";
import { withV3RowRepos } from "./usecase_v3_fixtures.ts";
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

function written(writer: Writer, id: string): Promise<LocalWriterMessage> {
  return writer.seen((m) => "written" in m && m.written === id, `write ${id}`);
}

function stagedNames(outboxPath: string): string[] {
  const db = new DatabaseSync(outboxPath);
  try {
    return (db.prepare("SELECT sha256 FROM outbox_staged").all() as {
      sha256: string;
    }[]).map((row) => row.sha256);
  } finally {
    db.close();
  }
}

/** every chunk file, by hash, aged past the sweep's grace */
async function ageChunks(datastorePath: string): Promise<Map<string, string>> {
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const chunks = new Map<string, string>();
  for await (
    const entry of walk(join(datastorePath, "_blobs"), { includeDirs: false })
  ) {
    await Deno.utime(entry.path, old, old);
    chunks.set(basename(entry.path), entry.path);
  }
  return chunks;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test({
  name:
    "v3 local chunk sweep: a chunk a live writer in another process staged and has not committed is kept past the grace, and its commit lands and reads back",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3RowRepos({}, async (repos, datastorePath) => {
      await closeV3Datastores();
      const peer = startWriter("peer");
      const reader = startWriter("reader");
      try {
        const type = repos.modelType.normalized;
        await opened(peer, repos.repoA, type);
        peer.send({ kind: "write", id: "warm", model: "m", data: "warm" });
        await written(peer, "warm");

        const outboxPath = v3OutboxPath(v3SharedCommitsDbPath(datastorePath));
        const sweeper = openV3Datastore({
          repoDir: repos.repoB,
          datastorePath,
        });
        const pad = crypto.randomUUID().repeat(8 * 1024);
        let staged: string[] = [];
        try {
          // the sweeper holds the lease, so the peer stages and then waits for
          // it to prepare and commit
          const release = await acquireV3WriterLock(datastorePath, {
            maxWaitMs: 30_000,
            fenceStore: {
              writerFence: () => sweeper.commitStore.writerFence(),
              raiseWriterFence: (fence: number) =>
                sweeper.raiseWriterFence(fence),
            },
          });
          try {
            peer.send({
              kind: "write",
              id: "big",
              model: "m",
              data: "big",
              pad,
            });
            await waitFor(
              () => {
                staged = stagedNames(outboxPath);
                return staged.length > 0;
              },
              "the peer staged its chunks",
              { timeoutMs: 60_000 },
            );
            const chunks = await ageChunks(datastorePath);
            for (const sha256 of staged) {
              assert(chunks.has(sha256), `staged chunk ${sha256} is stored`);
            }
            const report = await sweeper.collectChunks(
              AbortSignal.timeout(60_000),
            );
            assertEquals(report.deleted, 0);
            for (const sha256 of staged) {
              assert(
                await exists(chunks.get(sha256)!),
                `the sweep kept staged chunk ${sha256}`,
              );
            }
            assertEquals(
              peer.messages.some((m) => "written" in m && m.written === "big"),
              false,
              "the peer committed before the sweep ended",
            );
          } finally {
            await release({ clean: true });
          }
        } finally {
          await sweeper.close();
        }

        const big = await written(peer, "big");
        assert("written" in big);
        assertEquals(stagedNames(outboxPath), []);
        await closed(peer);

        await opened(reader, repos.repoB, type);
        reader.send({
          kind: "read",
          id: "r",
          modelId: big.modelId,
          data: "big",
        });
        const read = await reader.seen(
          (m) => "read" in m && m.read === "r",
          "the reader read the peer's commit",
        );
        assert("read" in read && read.content !== null, "the content reads");
        const body = JSON.parse(read.content!);
        assertEquals(body.by, "big");
        assertEquals(body.pad, pad);
        await closed(reader);
      } finally {
        peer.stop();
        reader.stop();
        await closeV3Datastores();
      }
    });
  },
});
