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
import { putOp } from "../src/domain/datastore_v3/op.ts";
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
