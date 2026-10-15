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
 * What confirming a serve write request costs (swamp-club#3489, Phase 4
 * D3): the latency a write request gains when serve waits for its commit
 * to be replicated and its head published before it answers, on a warm
 * sidecar, alone and with concurrent requests sharing syncs.
 *
 *   SWAMP_LITESTREAM_PATH=<binary> deno run -A scripts/bench_v3_serve_confirm.ts \
 *     [--replica file|s3] [--runs 50] [--concurrency 8]
 *
 * With `--replica s3`, set SWAMP_BENCH_S3_ENDPOINT (and the emulator's
 * AWS_* credentials); put an RTT proxy in front of it to model a far
 * bucket. The control plane, where heads are published, stays on the
 * filesystem.
 */

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import {
  closeV3Datastores,
  confirmV3Replicated,
  holdV3Writer,
  v3DatastoreFor,
} from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { initializeV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";
import { setV3ReplicationForTesting } from "../src/infrastructure/datastore_v3/litestream/v3_replication.ts";
import { unixLitestreamControl } from "../src/infrastructure/datastore_v3/litestream/litestream_control_client.ts";
import {
  V3_REPLICA_ENV,
  type V3ReplicaSetting,
} from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";
import {
  AutoDefinitionChanges,
  recordKeyOf,
} from "../src/domain/datastore_v3/repository_changes.ts";
import type { CommitLogUnitOfWork } from "../src/domain/datastore_v3/commit_log_unit_of_work.ts";

const args = parseArgs(Deno.args, {
  string: ["replica", "runs", "concurrency"],
  default: { replica: "file", runs: "50", concurrency: "8" },
});
const binary = Deno.env.get("SWAMP_LITESTREAM_PATH");
if (binary === undefined) {
  console.error("Set SWAMP_LITESTREAM_PATH to the pinned Litestream binary.");
  Deno.exit(2);
}
const runs = Number(args.runs);
const concurrency = Number(args.concurrency);
// Under /tmp: macOS TMPDIR is too long for the sidecar's socket path.
const root = await Deno.realPath(
  await Deno.makeTempDir({ dir: "/tmp", prefix: "swamp-bench-confirm-" }),
);
const datastorePath = join(root, "ds");
const repoDir = join(root, "repo");
const config = { type: "filesystem" as const, path: datastorePath };

function replica(): V3ReplicaSetting {
  if (args.replica === "s3") {
    const endpoint = Deno.env.get("SWAMP_BENCH_S3_ENDPOINT");
    if (endpoint === undefined) throw new Error("SWAMP_BENCH_S3_ENDPOINT");
    return {
      type: "s3",
      bucket: Deno.env.get("SWAMP_BENCH_S3_BUCKET") ?? "swamp-test",
      path: `bench-confirm-${crypto.randomUUID()}`,
      endpoint,
      region: "us-east-1",
    };
  }
  return { type: "file", path: join(root, "replica") };
}

/** One write request's commit: a small definition, as serve's are. */
async function commitOne(): Promise<void> {
  const engine = v3DatastoreFor(repoDir, config).engineFor(
    () => Promise.resolve(),
    () => {
      throw new Error("no run repository needed");
    },
  );
  await engine.runRoot({}, async () => {
    const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
    const content = new Uint8Array(512);
    crypto.getRandomValues(content);
    await unit.stageOps([
      new AutoDefinitionChanges(crypto.randomUUID()).write(
        recordKeyOf(["auto-definitions", `${crypto.randomUUID()}.yaml`]),
        content,
      ),
    ]);
    await unit.commit();
  });
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function summary(label: string, values: readonly number[]): string {
  return `${label}: p50 ${percentile(values, 0.5).toFixed(1)} ms, ` +
    `p95 ${percentile(values, 0.95).toFixed(1)} ms`;
}

let syncs = 0;
await initializeV3Datastore(datastorePath, "bench");
await Deno.mkdir(repoDir, { recursive: true });
Deno.env.set(V3_REPLICA_ENV, JSON.stringify(replica()));
setV3ReplicationForTesting({
  resolveBinary: () => Promise.resolve(binary),
  control: {
    info: unixLitestreamControl.info,
    sync: (socket, db, deadline) => {
      syncs++;
      return unixLitestreamControl.sync(socket, db, deadline);
    },
  },
});
try {
  await holdV3Writer(config, repoDir, { retakeLost: true });
  // Warm: the sidecar is up and the lineage confirmed.
  await commitOne();
  await confirmV3Replicated(datastorePath);

  const commit: number[] = [];
  const confirm: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await commitOne();
    const committed = performance.now();
    await confirmV3Replicated(datastorePath);
    commit.push(committed - start);
    confirm.push(performance.now() - committed);
  }

  const grouped: number[] = [];
  const before = syncs;
  const rounds = Math.max(1, Math.floor(runs / concurrency));
  for (let round = 0; round < rounds; round++) {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        await commitOne();
        const committed = performance.now();
        await confirmV3Replicated(datastorePath);
        grouped.push(performance.now() - committed);
      }),
    );
  }

  console.log(`replica: ${args.replica}, runs: ${runs}`);
  console.log(summary("commit alone", commit));
  console.log(summary("added by confirmation, one request", confirm));
  console.log(
    summary(
      `added by confirmation, ${concurrency} concurrent requests`,
      grouped,
    ),
  );
  console.log(
    `syncs for ${rounds * concurrency} concurrent requests: ${syncs - before}`,
  );
} finally {
  await closeV3Datastores().catch((error) => console.error(error));
  setV3ReplicationForTesting(undefined);
  await Deno.remove(root, { recursive: true }).catch(() => {});
}
