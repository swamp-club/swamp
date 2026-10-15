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
 * What keeping a v3 copy current costs (swamp-club#3482, Phase 4 D2): the
 * check a command makes on a current copy, and a full restore (a fresh
 * machine's first command, or a refresh) at 1 MB and 100 MB.
 *
 *   SWAMP_LITESTREAM_PATH=<binary> deno run -A scripts/bench_v3_restore.ts \
 *     [--replica file|s3] [--sizes 1,100] [--runs 5]
 *
 * With `--replica s3`, set SWAMP_BENCH_S3_ENDPOINT (and the emulator's
 * AWS_* credentials); put an RTT proxy in front of it to model a far
 * bucket. The control plane stays on the filesystem in both: its cost is
 * one list and up to four small gets, measured separately on a bucket in
 * Phase 4E.
 */

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { LineageRegistry } from "../src/infrastructure/datastore_v3/litestream/lineage_registry.ts";
import {
  installByRename,
  restoreV3Copy,
} from "../src/infrastructure/datastore_v3/litestream/litestream_restorer.ts";
import { renderLitestreamRestoreConfig } from "../src/infrastructure/datastore_v3/litestream/replication_files.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import {
  decideLocalCopy,
  type LineageHead,
} from "../src/domain/datastore_v3/published_lineage.ts";
import { replicaPathFor } from "../src/domain/datastore_v3/replication_lineage.ts";
import {
  modelCommit,
  savePut,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import type { V3ReplicaSetting } from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";

const args = parseArgs(Deno.args, {
  string: ["replica", "sizes", "runs"],
  default: { replica: "file", sizes: "1,100", runs: "5" },
});
const binary = Deno.env.get("SWAMP_LITESTREAM_PATH");
if (binary === undefined) {
  console.error("Set SWAMP_LITESTREAM_PATH to the pinned Litestream binary.");
  Deno.exit(2);
}
const runs = Number(args.runs);
const root = await Deno.realPath(
  await Deno.makeTempDir({ dir: "/tmp", prefix: "swamp-bench-restore-" }),
);

function replicaFor(name: string): V3ReplicaSetting {
  if (args.replica === "s3") {
    const endpoint = Deno.env.get("SWAMP_BENCH_S3_ENDPOINT");
    if (endpoint === undefined) throw new Error("SWAMP_BENCH_S3_ENDPOINT");
    return {
      type: "s3",
      bucket: Deno.env.get("SWAMP_BENCH_S3_BUCKET") ?? "swamp-test",
      path: `bench-${name}-${crypto.randomUUID()}`,
      endpoint,
      region: "us-east-1",
    };
  }
  return { type: "file", path: join(root, `replica-${name}`) };
}

/** A commits.db of about `mb` megabytes, in inline commits of about 8 KB. */
async function build(path: string, mb: number): Promise<void> {
  const store = SqliteCommitStore.open(path);
  try {
    // Inline content stops at 8 KB once base64-encoded.
    const commits = Math.max(1, Math.round(mb * 122));
    for (let seq = 1; seq <= commits; seq++) {
      const bytes = new Uint8Array(4_500);
      crypto.getRandomValues(bytes);
      const text = btoa(String.fromCharCode(...bytes));
      await store.append(
        modelCommit(seq, [await savePut("a", seq, text), versionOp("a", seq)], {
          fence: 1,
        }),
      );
    }
  } finally {
    await store.close();
  }
}

/** Replicates `db` once, with the real binary, and returns its last TXID. */
async function replicate(
  db: string,
  replica: V3ReplicaSetting,
): Promise<string> {
  const config = join(root, `rep-${crypto.randomUUID()}.yml`);
  const path = replicaPathFor(replica.path, 1);
  await Deno.writeTextFile(
    config,
    renderLitestreamRestoreConfig(
      db,
      replica,
      replica.type === "file" ? path : path.replace(/^\/+/, ""),
    ),
  );
  // `replicate -exec` replicates while the command runs, then exits: the
  // command must outlast a sync interval (1 s) for anything to upload.
  const result = await new Deno.Command(binary!, {
    args: ["replicate", "-config", config, "-exec", "sleep 5"],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  const ltx = await new Deno.Command(binary!, {
    args: ["ltx", "-config", config, db],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const ids = [
    ...new TextDecoder().decode(ltx.stdout).matchAll(/\b([0-9a-f]{16})\b/g),
  ].map((match) => match[1]).sort();
  return ids.at(-1) ?? "0000000000000001";
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const datastore = join(root, "ds");
await Deno.mkdir(datastore);
const registry = new LineageRegistry(new FileSystemControlPlaneStore(datastore));
const replicaRoot = "bench";
await registry.start({
  fence: 1,
  holder: "bench",
  replicaRoot,
  startedAt: new Date().toISOString(),
});

for (const mb of args.sizes.split(",").map(Number)) {
  const source = join(root, `source-${mb}.db`);
  await build(source, mb);
  const replica = replicaFor(`${mb}`);
  const txid = await replicate(source, replica);
  const store = SqliteCommitStore.open(source);
  const mark = store.highWaterMark();
  await store.close();
  const head: LineageHead = {
    fence: 1,
    txid,
    writerFence: 1,
    mark,
    publishedAt: new Date().toISOString(),
  };
  await registry.publishHead(head);
  await registry.confirm({ fence: 1, txid, confirmedAt: head.publishedAt });

  const checks: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    const lineages = await registry.read(replicaRoot);
    const decision = decideLocalCopy(
      { copy: { replicaRoot, lineageFence: 1, txid } },
      lineages,
      replicaRoot,
    );
    checks.push(performance.now() - start);
    if (decision.kind !== "current") throw new Error(decision.kind);
  }
  const restores: number[] = [];
  for (let i = 0; i < runs; i++) {
    const dir = join(root, `copy-${mb}-${i}`);
    await Deno.mkdir(dir);
    const target = join(dir, "commits.db");
    const start = performance.now();
    await restoreV3Copy({
      binary,
      replica,
      head,
      target,
      configDir: dir,
      install: installByRename(target),
      deadlineMs: 30 * 60 * 1000,
    });
    restores.push(performance.now() - start);
  }
  const bytes = (await Deno.stat(source)).size;
  console.log(
    `${args.replica} ${(bytes / 1e6).toFixed(1)} MB: check on a current ` +
      `copy ${median(checks).toFixed(2)} ms, full restore ` +
      `${median(restores).toFixed(0)} ms (median of ${runs})`,
  );
}

await Deno.remove(root, { recursive: true });
