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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import {
  CANNOT_COMMIT_WINDOW_MS,
  type CommitOutcomeEvent,
  LeaderCommitHealth,
  leaderUnreadyReason,
  probeStorage,
  storageFailureCause,
  wireLeaderCommitHealth,
} from "./leader_commit_health.ts";
import { ReadModelApplyError } from "../domain/datastore_v3/read_model.ts";
import { PreconditionConflictError } from "../infrastructure/datastore_v3/forwarded_commit.ts";
import { LitestreamControlError } from "../infrastructure/datastore_v3/litestream/litestream_control_client.ts";
import { V3ReplicationError } from "../domain/datastore_v3/litestream_replication.ts";

function realSqliteFull(): Error {
  const dir = Deno.makeTempDirSync();
  const db = new DatabaseSync(join(dir, "full.db"));
  try {
    db.exec("PRAGMA page_size=4096; CREATE TABLE t(v BLOB);");
    db.exec("PRAGMA max_page_count=4");
    const insert = db.prepare("INSERT INTO t VALUES (?)");
    for (let i = 0; i < 100; i++) insert.run(new Uint8Array(4000));
  } catch (error) {
    return error as Error;
  } finally {
    db.close();
    Deno.removeSync(dir, { recursive: true });
  }
  throw new Error("the capped database never filled");
}

function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const full = () =>
  Object.assign(new Error("database or disk is full"), { errcode: 13 });

Deno.test("storageFailureCause: a real SQLITE_FULL is storage_full", () => {
  assertEquals(storageFailureCause(realSqliteFull()), "storage_full");
});

Deno.test("storageFailureCause: finds the storage failure along the cause chain", () => {
  const wrapped = new ReadModelApplyError("", "p", 4, "apply failed", {
    cause: realSqliteFull(),
  });
  assertEquals(storageFailureCause(wrapped), "storage_full");
});

Deno.test("storageFailureCause: classifies file-system codes and SQLite codes", () => {
  const coded = (code: string) => Object.assign(new Error("x"), { code });
  assertEquals(storageFailureCause(coded("ENOSPC")), "storage_full");
  assertEquals(storageFailureCause(coded("EIO")), "storage_io_error");
  assertEquals(storageFailureCause(coded("EROFS")), "storage_read_only");
  const sqlite = (errcode: number) =>
    Object.assign(new Error("x"), { errcode });
  // SQLITE_IOERR_FSYNC is an extended code whose low byte is SQLITE_IOERR
  assertEquals(storageFailureCause(sqlite(1034)), "storage_io_error");
  assertEquals(storageFailureCause(sqlite(8)), "storage_read_only");
});

Deno.test("storageFailureCause: locks, refusals and the network are not storage failures", () => {
  assertEquals(storageFailureCause(new Error("database is locked")), undefined);
  assertEquals(
    storageFailureCause(Object.assign(new Error("x"), { errcode: 5 })),
    undefined,
  );
  assertEquals(
    storageFailureCause(
      Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
    ),
    undefined,
  );
  assertEquals(storageFailureCause("disk full"), undefined);
  assertEquals(storageFailureCause(undefined), undefined);
});

Deno.test("LeaderCommitHealth: one storage failure never trips", () => {
  const time = clock();
  const health = new LeaderCommitHealth({ now: time.now });
  health.recordFailure(full());
  time.advance(60_000);
  assertEquals(health.cannotCommit(), undefined);
});

Deno.test("LeaderCommitHealth: trips on the count once the window has passed", () => {
  const time = clock();
  const health = new LeaderCommitHealth({ now: time.now });
  const seen: unknown[] = [];
  health.onCannotCommit((state) => seen.push(state));
  health.recordFailure(full());
  time.advance(4_000);
  health.recordFailure(full());
  assertEquals(health.cannotCommit(), undefined);
  time.advance(6_000);
  const third = full();
  health.recordFailure(third);
  assertEquals(health.cannotCommit(), {
    cause: "storage_full",
    failures: 3,
    sinceMs: CANNOT_COMMIT_WINDOW_MS,
    error: third,
  });
  assertEquals(seen.length, 1);
});

Deno.test("LeaderCommitHealth: a burst inside the window does not trip", () => {
  const time = clock();
  const health = new LeaderCommitHealth({ now: time.now });
  for (let i = 0; i < 50; i++) health.recordFailure(full());
  time.advance(CANNOT_COMMIT_WINDOW_MS - 1);
  health.recordFailure(full());
  assertEquals(health.cannotCommit(), undefined);
});

Deno.test("LeaderCommitHealth: a success starts the run again", () => {
  const time = clock();
  const health = new LeaderCommitHealth({ now: time.now });
  health.recordFailure(full());
  health.recordFailure(full());
  time.advance(CANNOT_COMMIT_WINDOW_MS);
  health.recordSuccess();
  health.recordFailure(full());
  assertEquals(health.cannotCommit(), undefined);
});

Deno.test("LeaderCommitHealth: other errors neither count nor reset", () => {
  const time = clock();
  const health = new LeaderCommitHealth({ now: time.now });
  health.recordFailure(full());
  health.recordFailure(new Error("database is locked"));
  health.recordFailure(full());
  time.advance(CANNOT_COMMIT_WINDOW_MS);
  health.recordFailure(new Error("stale seq"));
  health.recordFailure(full());
  assertEquals(health.cannotCommit()?.failures, 3);
});

Deno.test("LeaderCommitHealth: one failure reported twice counts once", () => {
  const time = clock();
  const health = new LeaderCommitHealth({ now: time.now });
  const cause = full();
  health.recordFailure(cause);
  time.advance(CANNOT_COMMIT_WINDOW_MS);
  // the datastore saw the cause, the request handler the error wrapping it
  health.recordFailure(new ReadModelApplyError("", "p", 1, "x", { cause }));
  health.recordFailure(cause);
  assertEquals(health.cannotCommit(), undefined);
  health.recordFailure(full());
  assertEquals(health.cannotCommit(), undefined);
  health.recordFailure(full());
  assertEquals(health.cannotCommit()?.failures, 3);
});

Deno.test("LeaderCommitHealth: a trip lasts, whatever succeeds after it", () => {
  const time = clock();
  const health = new LeaderCommitHealth({ now: time.now });
  for (let i = 0; i < 3; i++) {
    health.recordFailure(full());
    time.advance(CANNOT_COMMIT_WINDOW_MS);
  }
  assert(health.cannotCommit() !== undefined);
  health.recordSuccess();
  assert(health.cannotCommit() !== undefined);
});

Deno.test("leaderUnreadyReason: names the cause class, never the error", () => {
  const reason = leaderUnreadyReason({
    cause: "storage_full",
    failures: 4,
    sinceMs: 12_400,
    error: new Error("/secret/path/commits.db: database or disk is full"),
  });
  assertEquals(reason.includes("/secret"), false);
  assertStringIncludes(reason, "storage is full");
  assertStringIncludes(reason, "4 times");
  assertStringIncludes(reason, "12s");
});

function wired(options: { leads?: () => boolean } = {}) {
  const time = clock();
  const calls: string[] = [];
  const listeners = new Set<
    (path: string, outcome: CommitOutcomeEvent) => void
  >();
  const wiring = wireLeaderCommitHealth({
    datastorePath: "/ds",
    leads: options.leads ?? (() => true),
    onCommitOutcome: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stopRenewal: () => {
      calls.push("stop-renewal");
      return Promise.resolve();
    },
    stepDown: () => {
      calls.push("step-down");
      return Promise.resolve();
    },
    health: new LeaderCommitHealth({ now: time.now }),
  });
  const tell = (path: string, outcome: CommitOutcomeEvent) => {
    for (const listener of listeners) listener(path, outcome);
  };
  return { time, calls, wiring, tell, listeners };
}

Deno.test("wireLeaderCommitHealth: a trip stops renewing, then steps down, once", async () => {
  const { time, calls, wiring, tell } = wired();
  for (let i = 0; i < 5; i++) {
    tell("/ds", { kind: "failed", error: full() });
    time.advance(CANNOT_COMMIT_WINDOW_MS);
  }
  await wiring.steppedDown();
  assertEquals(calls, ["stop-renewal", "step-down"]);
  assert(wiring.port.cannotCommit() !== undefined);
});

Deno.test("wireLeaderCommitHealth: another datastore's commits and a follower's never count", async () => {
  let leading = false;
  const { time, calls, wiring, tell } = wired({ leads: () => leading });
  for (let i = 0; i < 4; i++) {
    tell("/ds", { kind: "failed", error: full() });
    wiring.port.recordFailure(full());
    tell("/other", { kind: "failed", error: full() });
    time.advance(CANNOT_COMMIT_WINDOW_MS);
  }
  leading = true;
  for (let i = 0; i < 4; i++) {
    tell("/other", { kind: "failed", error: full() });
    time.advance(CANNOT_COMMIT_WINDOW_MS);
  }
  await wiring.steppedDown();
  assertEquals(calls, []);
  assertEquals(wiring.port.cannotCommit(), undefined);
});

Deno.test("wireLeaderCommitHealth: an applied commit resets the run, and stop unsubscribes", () => {
  const { time, wiring, tell, listeners } = wired();
  tell("/ds", { kind: "failed", error: full() });
  tell("/ds", { kind: "failed", error: full() });
  time.advance(CANNOT_COMMIT_WINDOW_MS);
  tell("/ds", { kind: "applied" });
  tell("/ds", { kind: "failed", error: full() });
  assertEquals(wiring.port.cannotCommit(), undefined);
  wiring.stop();
  assertEquals(listeners.size, 0);
});

Deno.test("storageFailureCause: storage-error text a client put in a refusal is never a storage failure", () => {
  for (
    const key of [
      "No space left on device",
      "database or disk is full",
      "disk I/O error/os error 5",
      "Read-only file system (os error 30)",
    ]
  ) {
    assertEquals(
      storageFailureCause(
        new PreconditionConflictError(key, 3, "user:x", undefined),
      ),
      undefined,
      key,
    );
  }
  assertEquals(
    storageFailureCause(new Error("No space left on device (os error 28)")),
    undefined,
  );
});

Deno.test("LeaderCommitHealth: refusals naming storage errors, spread across the window, never trip", () => {
  const time = clock();
  const health = new LeaderCommitHealth({ now: time.now });
  for (let i = 0; i < 5; i++) {
    health.recordFailure(
      new PreconditionConflictError(
        "No space left on device",
        i,
        undefined,
        undefined,
      ),
    );
    time.advance(CANNOT_COMMIT_WINDOW_MS);
  }
  assertEquals(health.cannotCommit(), undefined);
});

function sidecarFailed(sidecarError: string | undefined, timedOut = false) {
  return new V3ReplicationError("the Litestream sidecar failed", {
    cause: new LitestreamControlError(
      `POST /sync answered 500${sidecarError ? `: ${sidecarError}` : ""}`,
      timedOut,
      sidecarError === undefined ? {} : { sidecarError },
    ),
  });
}

Deno.test("storageFailureCause: the sidecar failing to write on this node is a storage failure", () => {
  assertEquals(
    storageFailureCause(
      sidecarFailed(
        "sync database: db sync: sync: stage-write ltx file /x/0020.ltx.tmp: disk full: write page index: write page index element: write /x/0020.ltx.tmp: no space left on device",
      ),
    ),
    "storage_full",
  );
  assertEquals(
    storageFailureCause(sidecarFailed("write /x.ltx.tmp: input/output error")),
    "storage_io_error",
  );
  assertEquals(
    storageFailureCause(
      sidecarFailed("open /x.ltx.tmp: read-only file system"),
    ),
    "storage_read_only",
  );
});

Deno.test("storageFailureCause: the bucket, the network, a timeout and an abandoned sync are never storage failures", () => {
  for (
    const reported of [
      "sync database: replica sync: googleapi: Error 503: backendError",
      "replica sync: RequestError: send request failed: dial tcp: i/o timeout",
      "replica sync: AccessDenied: Access Denied",
    ]
  ) {
    assertEquals(
      storageFailureCause(sidecarFailed(reported)),
      undefined,
      reported,
    );
  }
  assertEquals(storageFailureCause(sidecarFailed(undefined, true)), undefined);
  // the client's own wording, not the sidecar's, names no storage failure
  assertEquals(
    storageFailureCause(
      new LitestreamControlError(
        "POST /sync was given up: no space left on device",
        false,
      ),
    ),
    undefined,
  );
});

Deno.test("storageFailureCause: SQLite I/O codes for memory, locking or a file already gone are not storage failures", () => {
  const sqlite = (errcode: number) =>
    Object.assign(new Error("x"), { errcode });
  for (
    const errcode of [3082, 3850, 2314, 2058, 3594, 5130, 5898, 264, 520, 1032]
  ) {
    assertEquals(storageFailureCause(sqlite(errcode)), undefined, `${errcode}`);
  }
  assertEquals(storageFailureCause(sqlite(10)), "storage_io_error");
});

Deno.test("wireLeaderCommitHealth: a renewal stop that fails still steps down", async () => {
  const time = clock();
  const calls: string[] = [];
  const listeners = new Set<
    (path: string, outcome: CommitOutcomeEvent) => void
  >();
  const wiring = wireLeaderCommitHealth({
    datastorePath: "/ds",
    leads: () => true,
    onCommitOutcome: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stopRenewal: () => Promise.reject(new Error("the lease move failed")),
    stepDown: () => {
      calls.push("step-down");
      return Promise.resolve();
    },
    health: new LeaderCommitHealth({ now: time.now }),
  });
  try {
    for (let i = 0; i < 3; i++) {
      for (const listener of listeners) {
        listener("/ds", { kind: "failed", error: full() });
      }
      time.advance(CANNOT_COMMIT_WINDOW_MS);
    }
    await wiring.steppedDown();
    assertEquals(calls, ["step-down"]);
  } finally {
    wiring.stop();
  }
});

function probed(probe: () => Promise<void>) {
  const calls: string[] = [];
  let probes = 0;
  const listeners = new Set<
    (path: string, outcome: CommitOutcomeEvent) => void
  >();
  const health = new LeaderCommitHealth({ windowMs: 100 });
  const wiring = wireLeaderCommitHealth({
    datastorePath: "/ds",
    leads: () => true,
    onCommitOutcome: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stopRenewal: () => Promise.resolve(),
    stepDown: () => {
      calls.push("step-down");
      return Promise.resolve();
    },
    probe: () => {
      probes++;
      return probe();
    },
    probeIntervalMs: 10,
    health,
  });
  const tell = (outcome: CommitOutcomeEvent) => {
    for (const listener of listeners) listener("/ds", outcome);
  };
  return { calls, health, wiring, tell, probes: () => probes };
}

const enospc = () =>
  Promise.reject(
    Object.assign(new Error("No space left on device (os error 28)"), {
      code: "ENOSPC",
    }),
  );

Deno.test("wireLeaderCommitHealth: once a storage failure begins a run, failing probes trip it within the window, with no further commit", async () => {
  const { calls, health, wiring, tell } = probed(enospc);
  try {
    tell({ kind: "failed", error: full() });
    await waitFor(() => health.cannotCommit() !== undefined, "the trip");
    await wiring.steppedDown();
    assertEquals(calls, ["step-down"]);
  } finally {
    wiring.stop();
  }
});

Deno.test("wireLeaderCommitHealth: a probe that succeeds neither trips nor resets the run", async () => {
  const { health, wiring, tell, probes } = probed(() => Promise.resolve());
  try {
    tell({ kind: "failed", error: full() });
    await waitFor(() => probes() >= 5, "several probes");
    assertEquals(health.cannotCommit(), undefined);
    assert(health.failing(), "the run is still open");
    tell({ kind: "applied" });
    const after = probes();
    await new Promise((done) => setTimeout(done, 50));
    assertEquals(health.failing(), false);
    assert(probes() <= after + 1, "probing ends with the run");
  } finally {
    wiring.stop();
  }
});

Deno.test("wireLeaderCommitHealth: nothing is probed before a storage failure, or after stop", async () => {
  const { wiring, tell, probes } = probed(enospc);
  tell({ kind: "failed", error: new Error("database is locked") });
  await new Promise((done) => setTimeout(done, 50));
  assertEquals(probes(), 0);
  wiring.stop();
  tell({ kind: "failed", error: full() });
  await new Promise((done) => setTimeout(done, 50));
  assertEquals(probes(), 0);
});

Deno.test("probeStorage: writes and removes its file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await probeStorage(dir);
    assertEquals([...Deno.readDirSync(dir)].length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("LeaderCommitHealth: failures more than a window apart are separate runs, and a quiet run is no longer failing", () => {
  const time = clock();
  const health = new LeaderCommitHealth({ now: time.now });
  health.recordFailure(full());
  health.recordFailure(full());
  health.recordFailure(full());
  assert(health.failing());
  time.advance(CANNOT_COMMIT_WINDOW_MS + 1);
  assertEquals(health.failing(), false);
  // hours later, one more failure starts a run of its own
  time.advance(8 * 3_600_000);
  health.recordFailure(full());
  assertEquals(health.cannotCommit(), undefined);
  assert(health.failing());
});

function realExecFull(): Error {
  const dir = Deno.makeTempDirSync();
  const db = new DatabaseSync(join(dir, "full.db"));
  try {
    db.exec("PRAGMA page_size=4096; CREATE TABLE t(v BLOB);");
    db.exec("PRAGMA max_page_count=4");
    for (let i = 0; i < 100; i++) {
      db.exec("INSERT INTO t VALUES (zeroblob(4000))");
    }
  } catch (error) {
    return error as Error;
  } finally {
    db.close();
    Deno.removeSync(dir, { recursive: true });
  }
  throw new Error("the capped database never filled");
}

Deno.test("storageFailureCause: a SQLITE_FULL thrown by exec(), which carries no errcode, is storage_full", () => {
  const error = realExecFull();
  assertEquals((error as { errcode?: unknown }).errcode, undefined);
  assertEquals(storageFailureCause(error), "storage_full");
  assertEquals(
    storageFailureCause(new Error("wrapped", { cause: error })),
    "storage_full",
  );
});

Deno.test("storageFailureCause: SQLite's other exec() errors, and the same text without node:sqlite's code, are not storage failures", () => {
  const exec = (message: string) =>
    Object.assign(new Error(message), { code: "ERR_SQLITE_ERROR" });
  assertEquals(storageFailureCause(exec("database is locked")), undefined);
  assertEquals(
    storageFailureCause(exec("UNIQUE constraint failed: t.v")),
    undefined,
  );
  assertEquals(
    storageFailureCause(exec("database or disk is full; and more")),
    undefined,
  );
  assertEquals(
    storageFailureCause(new Error("database or disk is full")),
    undefined,
  );
});
