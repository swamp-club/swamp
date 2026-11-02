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


import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import { replicaPathFor } from "../src/domain/datastore_v3/replication_lineage.ts";
import {
  modelCommit,
  savePut,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import type { V3ReplicaSetting } from "../src/infrastructure/datastore_v3/litestream/replica_setting.ts";
import {
  ensurePrivateDir,
  ensureSharedDir,
  litestreamReplicaPath,
  renderLitestreamRestoreConfig,
  replicationPathsFor,
  writeCopyState,
} from "../src/infrastructure/datastore_v3/litestream/replication_files.ts";
import { verifyReplica } from "../src/infrastructure/datastore_v3/litestream/replica_verifier.ts";
import { readNewestSnapshotTxid } from "../src/infrastructure/datastore_v3/litestream/replica_snapshot.ts";

const args = parseArgs(Deno.args, {
  string: ["sizes", "s3", "gcs", "gcs-proxy-port", "bucket"],
  default: { sizes: "10,100", bucket: "measure", "gcs-proxy-port": "47393" },
});
const binary = Deno.env.get("SWAMP_LITESTREAM_PATH");
if (binary === undefined) {
  console.error("Set SWAMP_LITESTREAM_PATH to the pinned Litestream binary.");
  Deno.exit(2);
}
const root = await Deno.realPath(
  await Deno.makeTempDir({ dir: "/tmp", prefix: "swamp-measure-check-" }),
);

interface Traffic {
  up: number;
  down: number;
  connections: number;
  requests: Record<string, number>;
}

function countingProxy(upstreamPort: number, port = 0): {
  port: number;
  traffic: Traffic;
  reset(): void;
  close(): void;
} {
  const listener = Deno.listen({ hostname: "127.0.0.1", port });
  const state = {
    traffic: { up: 0, down: 0, connections: 0, requests: {} } as Traffic,
  };
  const pump = async (
    from: Deno.Conn,
    to: Deno.Conn,
    count: (chunk: Uint8Array) => void,
  ) => {
    const buffer = new Uint8Array(64 * 1024);
    try {
      while (true) {
        const n = await from.read(buffer);
        if (n === null) break;
        const chunk = buffer.subarray(0, n);
        count(chunk);
        let written = 0;
        while (written < n) written += await to.write(chunk.subarray(written));
      }
    } catch {
      // A side closed.
    } finally {
      try {
        to.closeWrite();
      } catch {
        // Closed already.
      }
    }
  };
  const serve = async () => {
    for await (const client of listener) {
      state.traffic.connections++;
      const upstream = await Deno.connect({
        hostname: "127.0.0.1",
        port: upstreamPort,
      });
      const decoder = new TextDecoder();
      Promise.all([
        pump(client, upstream, (chunk) => {
          state.traffic.up += chunk.length;
          for (
            const match of decoder.decode(chunk).matchAll(
              /^(GET|HEAD|PUT|POST|DELETE) \S+ HTTP\/1\.1/gm,
            )
          ) {
            state.traffic.requests[match[1]] =
              (state.traffic.requests[match[1]] ?? 0) + 1;
          }
        }),
        pump(upstream, client, (chunk) => {
          state.traffic.down += chunk.length;
        }),
      ]).finally(() => {
        client.close();
        upstream.close();
      }).catch(() => {});
    }
  };
  serve().catch(() => {});
  return {
    port: (listener.addr as Deno.NetAddr).port,
    get traffic() {
      return state.traffic;
    },
    reset() {
      state.traffic = { up: 0, down: 0, connections: 0, requests: {} };
    },
    close() {
      listener.close();
    },
  };
}

async function build(path: string, mb: number): Promise<void> {
  const store = SqliteCommitStore.open(path);
  try {
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

function settingFor(
  backend: "s3" | "gcs",
  endpoint: string,
  path: string,
): V3ReplicaSetting {
  return backend === "s3"
    ? {
      type: "s3",
      bucket: args.bucket,
      path,
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
    }
    : { type: "gcs", bucket: args.bucket, path };
}

async function withEmulatorHost<T>(
  backend: "s3" | "gcs",
  host: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (backend !== "gcs") return await fn();
  const before = Deno.env.get("STORAGE_EMULATOR_HOST");
  // A script, not a test: the child processes read the real environment.
  Deno.env.set("STORAGE_EMULATOR_HOST", host);
  try {
    return await fn();
  } finally {
    if (before !== undefined) Deno.env.set("STORAGE_EMULATOR_HOST", before);
    else Deno.env.delete("STORAGE_EMULATOR_HOST");
  }
}

async function measure(backend: "s3" | "gcs", mb: number) {
  const upstream = backend === "s3" ? args.s3! : `http://${args.gcs!}`;
  const upstreamPort = Number(new URL(upstream).port);
  const dir = join(root, `${backend}-${mb}`);
  await Deno.mkdir(join(dir, "ds"), { recursive: true });
  const commitsDb = join(dir, "ds", "commits.db");
  await build(commitsDb, mb);
  const size = (await Deno.stat(commitsDb)).size;
  const prefix = `measure-${crypto.randomUUID()}`;
  const lineagePath = replicaPathFor(prefix, 1);

  const proxy = countingProxy(
    upstreamPort,
    backend === "gcs" ? Number(args["gcs-proxy-port"]) : 0,
  );
  const host = `127.0.0.1:${proxy.port}`;
  const direct = settingFor(backend, upstream, prefix);
  const repConfig = join(dir, "replicate.yml");
  await Deno.writeTextFile(
    repConfig,
    renderLitestreamRestoreConfig(
      commitsDb,
      direct,
      litestreamReplicaPath(direct, lineagePath),
    ),
  );
  await withEmulatorHost(backend, host, async () => {
    const result = await new Deno.Command(binary!, {
      args: ["replicate", "-config", repConfig, "-exec", "sleep 8"],
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error(new TextDecoder().decode(result.stderr));
    }
  });

  const proxied = settingFor(
    backend,
    `http://127.0.0.1:${proxy.port}`,
    prefix,
  );
  const paths = await replicationPathsFor(commitsDb, join(dir, "priv"));
  await ensureSharedDir(paths);
  await ensurePrivateDir(paths);
  await Deno.writeTextFile(
    paths.config,
    renderLitestreamRestoreConfig(
      commitsDb,
      proxied,
      litestreamReplicaPath(proxied, lineagePath),
    ),
    { mode: 0o600 },
  );
  try {
    const listing = await withEmulatorHost(backend, host, async () => {
      proxy.reset();
      const started = performance.now();
      const snapshot = await readNewestSnapshotTxid({
        binary: binary!,
        config: paths.config,
        source: commitsDb,
        replicaType: backend,
        signal: AbortSignal.timeout(60_000),
      });
      return {
        snapshot,
        ms: Math.round(performance.now() - started),
        traffic: { ...proxy.traffic },
      };
    });
    if (listing.snapshot === undefined) throw new Error("no snapshot listed");
    await writeCopyState(paths, {
      replicaRoot: `${backend}:${prefix}`,
      lineageFence: 1,
      txid: listing.snapshot,
    });

    const timeFile = join(dir, "time.txt");
    const wrapper = join(dir, "litestream-timed");
    await Deno.writeTextFile(
      wrapper,
      `#!/bin/sh\nexec /usr/bin/time -l -a -o "${timeFile}" "${binary}" "$@"\n`,
    );
    await Deno.chmod(wrapper, 0o755);

    let peakTemp = 0;
    const rssBefore = Deno.memoryUsage().rss;
    let peakSelfRss = rssBefore;
    let watching = true;
    const watch = (async () => {
      while (watching) {
        peakSelfRss = Math.max(peakSelfRss, Deno.memoryUsage().rss);
        try {
          for await (const entry of Deno.readDir(paths.sharedDir)) {
            if (!entry.name.startsWith("verify-")) continue;
            const info = await Deno.stat(join(paths.sharedDir, entry.name))
              .catch(() => undefined);
            if (info !== undefined) peakTemp = Math.max(peakTemp, info.size);
          }
        } catch {
          // Read mid-removal.
        }
        await new Promise((done) => setTimeout(done, 25));
      }
    })();
    const check = await withEmulatorHost(backend, host, async () => {
      proxy.reset();
      const started = performance.now();
      const verdict = await verifyReplica({
        paths,
        lineageFence: 1,
        replicaType: backend,
        binary: wrapper,
        now: () => Date.now(),
        signal: AbortSignal.timeout(10 * 60_000),
        snapshotTxid: listing.snapshot,
      });
      return {
        ok: verdict?.ok,
        ms: Math.round(performance.now() - started),
        traffic: { ...proxy.traffic },
      };
    });
    watching = false;
    await watch;
    const timeText = await Deno.readTextFile(timeFile).catch(() => "");
    const litestreamPeak = Math.max(
      0,
      ...[...timeText.matchAll(/(\d+)\s+maximum resident set size/g)].map(
        (m) => Number(m[1]),
      ),
    );
    return {
      backend,
      dbMB: +(size / 1e6).toFixed(1),
      check: {
        ok: check.ok,
        ms: check.ms,
        downloadedMB: +(check.traffic.down / 1e6).toFixed(2),
        uploadedKB: +(check.traffic.up / 1e3).toFixed(1),
        requests: check.traffic.requests,
        connections: check.traffic.connections,
        litestreamPeakRssMB: +(litestreamPeak / 1e6).toFixed(1),
        swampRssGrowthMB: +((peakSelfRss - rssBefore) / 1e6).toFixed(1),
        peakTempMB: +(peakTemp / 1e6).toFixed(1),
      },
      snapshotListing: {
        ms: listing.ms,
        downloadedKB: +(listing.traffic.down / 1e3).toFixed(1),
        requests: listing.traffic.requests,
      },
    };
  } finally {
    proxy.close();
  }
}

const sizes = args.sizes.split(",").map(Number);
const backends = [
  ...(args.s3 !== undefined ? ["s3" as const] : []),
  ...(args.gcs !== undefined ? ["gcs" as const] : []),
];
try {
  for (const backend of backends) {
    for (const mb of sizes) {
      console.log(JSON.stringify(await measure(backend, mb)));
    }
  }
} finally {
  await Deno.remove(root, { recursive: true });
}
