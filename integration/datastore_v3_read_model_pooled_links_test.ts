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
import { join, relative } from "@std/path";
import { putOp, tombstoneOp } from "../src/domain/datastore_v3/op.ts";
import { RecordKey } from "../src/domain/datastore_v3/record_key.ts";
import {
  base64,
  modelIntent,
  modelPartition,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { DurableWriteBatch } from "../src/infrastructure/datastore_v3/atomic_stream_write.ts";
import type { SqliteReadModelOptions } from "../src/infrastructure/datastore_v3/sqlite_read_model.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  commitOf,
  type V3Env,
  withV3Env,
} from "./datastore_v3_read_model_helpers.ts";

const PARTITION = modelPartition();

/** a batch that does not sync, holding the write to `held` until released */
class HeldWriteBatch extends DurableWriteBatch {
  readonly gate = Promise.withResolvers<void>();

  constructor(readonly held: string) {
    super({ sync: false });
  }

  override async write(
    path: string,
    content: Uint8Array | ReadableStream<Uint8Array>,
    signal: AbortSignal,
    options?: Parameters<DurableWriteBatch["write"]>[3],
  ): Promise<void> {
    if (path === this.held) await this.gate.promise;
    return await super.write(path, content, signal, options);
  }
}

function dataPath(env: V3Env, ...segments: string[]): string {
  return join(swampPath(env.repoDir), "data", ...segments);
}

/** the tree as lstat sees it, links unfollowed */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const seen: Record<string, string> = {};
  const visit = async (at: string, rel: string): Promise<void> => {
    const entries = await Array.fromAsync(Deno.readDir(at));
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = join(at, entry.name);
      const name = `${rel}/${entry.name}`;
      const info = await Deno.lstat(path);
      if (info.isSymlink) seen[name] = `link:${await Deno.readLink(path)}`;
      else if (info.isDirectory) {
        seen[name] = "dir";
        await visit(path, name);
      } else seen[name] = `file:${await Deno.readTextFile(path)}`;
    }
  };
  await visit(dir, "data");
  return seen;
}

/** link data/a to l, then put l/a and a/a in one page */
async function play(
  env: V3Env,
  options: (env: V3Env) => Partial<SqliteReadModelOptions>,
): Promise<unknown> {
  await Deno.mkdir(dataPath(env), { recursive: true });
  await Deno.symlink("l", dataPath(env, "a"), { type: "dir" });
  const put = async (key: string, text: string) =>
    await putOp({
      intent: modelIntent({ kind: "data.save", name: "n", version: 1 }),
      key: RecordKey.create(key),
      inline: base64(text),
    });
  await env.store.append(
    commitOf({
      seq: 1,
      partition: PARTITION,
      namespace: "",
      ops: [await put("data/l/a", "p"), await put("data/a/a", "q")],
    }),
  );
  const readModel = env.openReadModel({
    bootIdentity: () => Promise.resolve("boot-1"),
    ...options(env),
  });
  let outcome = "ok";
  try {
    await readModel.catchUp(AbortSignal.timeout(30_000));
  } catch (error) {
    outcome = (error as Error).name;
  }
  try {
    const index = outcome === "ok"
      ? (await readModel.liveRecords("", PARTITION)).map((record) => [
        record.key.toString(),
        record.sha256,
      ])
      : [];
    return { outcome, index, tree: await snapshot(dataPath(env)) };
  } finally {
    await readModel.close();
  }
}

Deno.test({
  name:
    "SqliteReadModel.catchUp: a put through a link inside the root waits for a pooled write to the link's target, as writes one at a time do",
  // directory symlinks need a privilege on Windows
  ignore: Deno.build.os === "windows",
  fn: async () => {
    let oneAtATime: unknown;
    await withV3Env(async (env) => {
      oneAtATime = await play(env, () => ({ pooledWrites: 1 }));
    });
    let pooled: unknown;
    await withV3Env(async (env) => {
      const batch = new HeldWriteBatch(dataPath(env, "l", "a"));
      try {
        pooled = await play(env, () => ({
          writeBatch: () => batch,
          // l/a lands only once the page waits for it
          onPoolDrain: () => batch.gate.resolve(),
        }));
      } finally {
        batch.gate.resolve();
      }
    });
    assertEquals(pooled, oneAtATime);
  },
});

Deno.test("SqliteReadModel.catchUp: a pooled put of data/ß waits for the pooled write that makes data/SS, which a case-insensitive filesystem folds it into", async () => {
  await withV3Env(async (env) => {
    // with data/ made, only the fold of ß to SS makes the two writes meet
    await Deno.mkdir(dataPath(env), { recursive: true });
    const writes: string[] = [];
    const batch = new (class extends HeldWriteBatch {
      override async write(
        path: string,
        content: Uint8Array | ReadableStream<Uint8Array>,
        signal: AbortSignal,
        options?: Parameters<DurableWriteBatch["write"]>[3],
      ): Promise<void> {
        const name = relative(dataPath(env), path);
        writes.push(`start ${name}`);
        await super.write(path, content, signal, options);
        writes.push(`end ${name}`);
      }
    })(dataPath(env, "SS", "a"));
    const put = async (key: string) =>
      await putOp({
        intent: modelIntent({ kind: "data.save", name: "n", version: 1 }),
        key: RecordKey.create(key),
        inline: base64("p"),
      });
    await env.store.append(
      commitOf({
        seq: 1,
        partition: PARTITION,
        namespace: "",
        ops: [await put("data/SS/a"), await put("data/ß")],
      }),
    );
    const readModel = env.openReadModel({
      bootIdentity: () => Promise.resolve("boot-1"),
      writeBatch: () => batch,
      // SS/a lands only once the page waits for it
      onPoolDrain: () => batch.gate.resolve(),
    });
    try {
      await readModel.catchUp(AbortSignal.timeout(30_000));
    } finally {
      batch.gate.resolve();
      await readModel.close();
    }
    // a folding filesystem then skips ß as a directory, so it may not start
    assertEquals(writes.slice(0, 2), [
      `start ${join("SS", "a")}`,
      `end ${join("SS", "a")}`,
    ]);
  });
});

/** the property's counterexample: put l/a once l links to a removed a */
async function playDanglingLink(
  env: V3Env,
  options: Partial<SqliteReadModelOptions>,
): Promise<unknown> {
  await Deno.mkdir(dataPath(env), { recursive: true });
  await Deno.symlink("a", dataPath(env, "l"), { type: "dir" });
  const intent = (kind: "data.save" | "data.delete") =>
    modelIntent({ kind, name: "n", version: 1 });
  const put = async (key: string) =>
    await putOp({
      intent: intent("data.save"),
      key: RecordKey.create(key),
      inline: base64("p"),
    });
  const remove = (key: string) =>
    tombstoneOp({ intent: intent("data.delete"), key: RecordKey.create(key) });
  const commits = [
    [await put("data/a")],
    [remove("data/a/a")],
    [remove("data/l"), remove("data/A")],
    [remove("data/a"), await put("data/l/a")],
    [remove("data/a")],
  ];
  for (const [i, ops] of commits.entries()) {
    await env.store.append(
      commitOf({ seq: i + 1, partition: PARTITION, namespace: "", ops }),
    );
  }
  const readModel = env.openReadModel({
    pageSize: 2,
    spellingFolding: "canonical",
    bootIdentity: () => Promise.resolve("boot-1"),
    ...options,
  });
  try {
    let outcome = "ok";
    try {
      await readModel.catchUp(AbortSignal.timeout(30_000));
    } catch (error) {
      outcome = (error as Error).message;
    }
    const index = (await readModel.liveRecords("", PARTITION)).map((record) =>
      record.key.toString()
    );
    return { outcome, index, tree: await snapshot(dataPath(env)) };
  } finally {
    await readModel.close();
  }
}

Deno.test({
  name:
    "SqliteReadModel.catchUp: a put under a link to nothing is skipped and stays indexed, pooled or one at a time, rather than failing every catch-up",
  // directory symlinks need a privilege on Windows
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const expected = {
      outcome: "ok",
      index: ["data/l/a"],
      tree: { "data/l": "link:a" },
    };
    for (const options of [{ pooledWrites: 1 }, {}]) {
      await withV3Env(async (env) => {
        assertEquals(await playDanglingLink(env, options), expected);
      });
    }
  },
});
