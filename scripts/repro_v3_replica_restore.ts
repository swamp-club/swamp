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
 * Reproduces swamp-club#3935 with Litestream alone: a replica that restores
 * to a database failing SQLite's integrity check, while the database it
 * replicates is intact.
 *
 *   SWAMP_LITESTREAM_PATH=<binary> deno run -A \
 *     scripts/repro_v3_replica_restore.ts [--runs 12] [--rounds 60] \
 *     [--autocheckpoint 1000] [--gap]
 *
 * Each run writes a WAL database in bursts the way a v3 writer writes
 * `commits.db` (indexed inserts of mixed sizes, rewrites, and deletes of old
 * rows as history compaction makes them), forces a sync through
 * Litestream's control socket after each burst as a write command does,
 * then restores the file replica and checks it. `--gap` also stops
 * Litestream between some bursts and writes with no sidecar running, as
 * after an idle exit. A run stops at the first restore that fails.
 *
 * Litestream 0.5.17 loses its long read transaction when a sync request
 * runs its setup or a checkpoint (benbjohnson/litestream#1578, fixed on
 * main by #1579 after 0.5.17). SQLite's auto-checkpoint in the writer's
 * own connection (`--autocheckpoint 1000`, the default) can then restart
 * the WAL before Litestream read its newest frames: about half the runs
 * end corrupt. With `--autocheckpoint 0`, as swamp now opens a replicated
 * `commits.db`, none do.
 */

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { unixLitestreamControl } from "../src/infrastructure/datastore_v3/litestream/litestream_control_client.ts";

const args = parseArgs(Deno.args, {
  string: ["runs", "rounds", "autocheckpoint", "seed"],
  boolean: ["gap"],
  default: { runs: "12", rounds: "60", autocheckpoint: "1000", seed: "1" },
});
const LITESTREAM = Deno.env.get("SWAMP_LITESTREAM_PATH");
if (LITESTREAM === undefined) {
  console.error("Set SWAMP_LITESTREAM_PATH to the Litestream binary.");
  Deno.exit(2);
}
const AUTOCHECKPOINT = Number(args.autocheckpoint);

/** A seeded generator, so a failing run can be repeated. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout=30000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=FULL");
  db.exec(`PRAGMA wal_autocheckpoint=${AUTOCHECKPOINT}`);
  return db;
}

function bytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  crypto.getRandomValues(out.subarray(0, Math.min(size, 65536)));
  return out;
}

/** One write command's commits. */
function burst(path: string, commits: number, rand: () => number): void {
  const db = open(path);
  try {
    for (let i = 0; i < commits; i++) {
      db.exec("BEGIN IMMEDIATE");
      const kind = rand();
      if (kind < 0.7) {
        const insert = db.prepare(
          "INSERT INTO commits(ns, part, txn, body) VALUES (?, ?, ?, ?)",
        );
        const rows = 1 + Math.floor(rand() * 8);
        for (let r = 0; r < rows; r++) {
          insert.run(
            `ns${Math.floor(rand() * 20)}`,
            `p${Math.floor(rand() * 500)}`,
            crypto.randomUUID(),
            bytes([200, 1500, 3000, 9000][Math.floor(rand() * 4)]),
          );
        }
      } else if (kind < 0.85) {
        db.prepare(
          "UPDATE commits SET body = ? WHERE cursor IN " +
            "(SELECT cursor FROM commits ORDER BY random() LIMIT 20)",
        ).run(bytes(rand() < 0.5 ? 100 : 2500));
      } else {
        db.prepare(
          "DELETE FROM commits WHERE cursor IN " +
            "(SELECT cursor FROM commits ORDER BY cursor LIMIT ?)",
        ).run(50 + Math.floor(rand() * 350));
      }
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
}

function summary(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(
      "SELECT count(*) AS n, coalesce(sum(length(body)), 0) AS b FROM commits",
    ).get() as { n: number; b: number };
    return `${row.n}/${row.b}`;
  } finally {
    db.close();
  }
}

/** Restores the replica and checks it: "ok", or what was wrong. */
async function check(dir: string, db: string): Promise<string> {
  const out = join(dir, `restore-${crypto.randomUUID()}.db`);
  const result = await new Deno.Command(LITESTREAM!, {
    args: ["restore", "-o", out, `file://${join(dir, "replica")}`],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!result.success) {
    return `restore failed: ${new TextDecoder().decode(result.stderr).trim()}`;
  }
  try {
    const restored = new DatabaseSync(out, { readOnly: true });
    let verdict: string;
    try {
      verdict = (restored.prepare("PRAGMA quick_check").all() as {
        quick_check: string;
      }[]).map((row) => row.quick_check).join("; ");
    } catch (error) {
      verdict = error instanceof Error ? error.message : String(error);
    } finally {
      restored.close();
    }
    if (verdict !== "ok") return `corrupt: ${verdict.slice(0, 160)}`;
    const want = summary(db);
    const got = summary(out);
    return want === got ? "ok" : `missing rows: ${got} of ${want}`;
  } finally {
    await Deno.remove(out).catch(() => {});
  }
}

async function run(seed: number): Promise<string> {
  const rand = random(seed);
  // Under /tmp: the control socket's path must stay short.
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "ls3935-" });
  const db = join(dir, "commits.db");
  const socket = join(dir, "ls.sock");
  const config = join(dir, "litestream.yml");
  await Deno.writeTextFile(
    config,
    `logging:\n  level: warn\nsocket:\n  enabled: true\n  path: "${socket}"\n` +
      `dbs:\n  - path: "${db}"\n    replica:\n      type: file\n` +
      `      path: "${join(dir, "replica")}"\n`,
  );
  const setup = open(db);
  setup.exec(
    "CREATE TABLE commits(cursor INTEGER PRIMARY KEY, ns TEXT, part TEXT, " +
      "txn TEXT, body BLOB); CREATE INDEX commits_part ON commits(ns, part, " +
      "txn); CREATE INDEX commits_txn ON commits(txn);",
  );
  setup.close();
  let child: Deno.ChildProcess | undefined;
  const start = async () => {
    child = new Deno.Command(LITESTREAM!, {
      args: ["replicate", "-config", config],
      stdout: "null",
      stderr: "null",
    }).spawn();
    for (let i = 0; i < 200; i++) {
      try {
        await Deno.stat(socket);
        return;
      } catch {
        await new Promise((done) => setTimeout(done, 50));
      }
    }
    throw new Error("Litestream did not open its control socket");
  };
  const stop = async () => {
    child?.kill("SIGTERM");
    await child?.status;
    child = undefined;
    await Deno.remove(socket).catch(() => {});
  };
  const sync = () => unixLitestreamControl.sync(socket, db, 30_000);
  try {
    await start();
    for (let round = 0; round < Number(args.rounds); round++) {
      burst(db, 50 + Math.floor(rand() * 350), rand);
      await sync();
      if (args.gap && rand() < 0.5) {
        await stop();
        burst(db, 5 + Math.floor(rand() * 95), rand);
        await start();
      }
      await sync();
      const verdict = await check(dir, db);
      if (verdict !== "ok") return `round ${round}: ${verdict}`;
    }
    return "ok";
  } finally {
    await stop();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const first = Number(args.seed);
const results = await Promise.all(
  Array.from({ length: Number(args.runs) }, (_, i) => run(first + i)),
);
results.forEach((result, i) => console.log(`seed ${first + i}: ${result}`));
const failed = results.filter((result) => result !== "ok").length;
console.log(
  `${failed} of ${results.length} runs failed (wal_autocheckpoint=${AUTOCHECKPOINT}${
    args.gap ? ", with gaps" : ""
  })`,
);
Deno.exit(failed === 0 ? 0 : 1);
