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
import { configure, type LogRecord, reset } from "@logtape/logtape";
import type { DatastoreSyncOptions } from "../domain/datastore/datastore_sync_service.ts";
import type { UnitOfWork } from "../domain/datastore/unit_of_work.ts";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { createLegacyUnitOfWork } from "../infrastructure/persistence/legacy_unit_of_work.ts";
import { useUnitOfWorkFactoryForTesting } from "../infrastructure/persistence/repo_unit_of_work.ts";
import {
  signalChange,
  type UnscopedChange,
  useUnscopedChangeReporterForTesting,
} from "../infrastructure/persistence/unit_of_work_scope.ts";
import {
  createGrantWriteCommit,
  publishGrantWrites,
} from "./grant_write_tracking.ts";
import { createSyncGate, type SyncGate } from "./sync_gate.ts";

await initializeLogging({});

type SyncEvent =
  | { kind: "mark"; path: string }
  | { kind: "push"; namespace?: string; gateHeld?: boolean };

function recordingDeps(gate?: SyncGate, failPush = false) {
  const events: SyncEvent[] = [];
  return {
    events,
    deps: {
      syncService: {
        pushChanged(options?: DatastoreSyncOptions) {
          events.push({
            kind: "push",
            namespace: options?.namespace,
            gateHeld: gate?.exclusiveHeld,
          });
          return failPush
            ? Promise.reject(new Error("datastore unreachable"))
            : Promise.resolve(0);
        },
      },
      markDirty(path?: string) {
        events.push({ kind: "mark", path: path ?? "<bare>" });
        return Promise.resolve();
      },
      namespace: "infra",
    },
  };
}

Deno.test("publishGrantWrites: marks each path, then pushes once to the namespace", async () => {
  const { events, deps } = recordingDeps();

  await publishGrantWrites(["a", "b"], deps);

  assertEquals(events, [
    { kind: "mark", path: "a" },
    { kind: "mark", path: "b" },
    { kind: "push", namespace: "infra", gateHeld: undefined },
  ]);
});

Deno.test("publishGrantWrites: does not push when nothing was written", async () => {
  const { events, deps } = recordingDeps();

  await publishGrantWrites([], deps);

  assertEquals(events, []);
});

Deno.test("publishGrantWrites: is a no-op without a sync service", async () => {
  await publishGrantWrites(["a"], {});
});

/**
 * Runs `fn` with grant-write-tracking's log records captured, and returns the
 * level and `error` property of each.
 */
async function capturingWarnings(
  fn: () => Promise<void>,
): Promise<{ level: string; error: unknown }[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category: ["serve", "grant-write-tracking"],
        lowestLevel: "debug",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await reset();
    await initializeLogging({});
  }
  return records.map((record) => ({
    level: record.level,
    error: record.properties.error,
  }));
}

Deno.test("publishGrantWrites: logs a failed push instead of throwing", async () => {
  const { events, deps } = recordingDeps(undefined, true);

  const warnings = await capturingWarnings(() =>
    publishGrantWrites(["a"], deps)
  );

  assertEquals(events.at(-1)?.kind, "push");
  assertEquals(warnings, [{
    level: "warning",
    error: "datastore unreachable",
  }]);
});

Deno.test("publishGrantWrites: stages each path through one root unit over the same hook", async () => {
  const { events, deps } = recordingDeps();
  const roots: { unit: UnitOfWork; hookMatches: boolean }[] = [];
  const dispose = useUnitOfWorkFactoryForTesting((markDirty, options) => {
    const unit = createLegacyUnitOfWork(markDirty, {
      flush: options.flush,
      parent: options.parent,
      afterCommit: "reject",
    });
    if (options.role === "root") {
      roots.push({ unit, hookMatches: markDirty === deps.markDirty });
    }
    return unit;
  });
  try {
    await publishGrantWrites(["a", "b"], deps);
  } finally {
    dispose();
  }

  assertEquals(roots.length, 1);
  assertEquals(roots[0].hookMatches, true);
  assertEquals(roots[0].unit.staged(), [
    { kind: "write", path: "a" },
    { kind: "write", path: "b" },
  ]);
  assertEquals(events.map((event) => event.kind), ["mark", "mark", "push"]);
});

Deno.test("publishGrantWrites: a failed mark skips the push and is logged, not thrown", async () => {
  const { events, deps } = recordingDeps();
  const failing = {
    ...deps,
    markDirty(path?: string) {
      if (path === "b") return Promise.reject(new Error("index unwritable"));
      return deps.markDirty(path);
    },
  };

  const warnings = await capturingWarnings(() =>
    publishGrantWrites(["a", "b", "c"], failing)
  );

  assertEquals(events, [{ kind: "mark", path: "a" }]);
  assertEquals(warnings, [{ level: "warning", error: "index unwritable" }]);
});

Deno.test("createGrantWriteCommit: pushes the unit's writes inside the exclusive gate", async () => {
  const gate = createSyncGate();
  const { events, deps } = recordingDeps(gate);
  let pending = ["left-by-a-failed-unit"];
  const tracking = {
    takeWrittenPaths() {
      const paths = pending;
      pending = [];
      return paths;
    },
  };
  const commit = createGrantWriteCommit(gate, tracking, deps);

  const result = await commit(() => {
    assertEquals(gate.exclusiveHeld, true);
    pending.push("grant-data-dir");
    return Promise.resolve("done");
  });

  assertEquals(result, "done");
  assertEquals(events, [
    { kind: "mark", path: "left-by-a-failed-unit" },
    { kind: "mark", path: "grant-data-dir" },
    { kind: "push", namespace: "infra", gateHeld: true },
  ]);
  assertEquals(gate.exclusiveHeld, false);
});

Deno.test("createGrantWriteCommit: a unit that throws pushes nothing, rethrows, and leaves its paths for the next unit", async () => {
  const gate = createSyncGate();
  const { events, deps } = recordingDeps(gate);
  let pending: string[] = [];
  const tracking = {
    takeWrittenPaths() {
      const paths = pending;
      pending = [];
      return paths;
    },
  };
  const commit = createGrantWriteCommit(gate, tracking, deps);

  let caught: unknown;
  try {
    await commit(() => {
      pending.push("half-written-grant");
      return Promise.reject(new Error("reconcile failed"));
    });
  } catch (error) {
    caught = error;
  }

  assertEquals((caught as Error).message, "reconcile failed");
  assertEquals(events, []);
  assertEquals(pending, ["half-written-grant"]);
  assertEquals(gate.exclusiveHeld, false);
});

Deno.test("createGrantWriteCommit: the unit's writes stage into a root over the same hook, not through the hook fallback (swamp-club#3056)", async () => {
  const gate = createSyncGate();
  const { events, deps } = recordingDeps(gate);
  let pending: string[] = [];
  const tracking = {
    takeWrittenPaths() {
      const paths = pending;
      pending = [];
      return paths;
    },
  };
  const commit = createGrantWriteCommit(gate, tracking, deps);
  const reports: UnscopedChange[] = [];
  const dispose = useUnscopedChangeReporterForTesting((report) => {
    reports.push(report);
  });
  try {
    await commit(async () => {
      // As a grant store's repository signals before writing.
      await signalChange(deps.markDirty, {
        kind: "write",
        path: "grant-data-dir",
      });
      pending.push("grant-data-dir");
    });
  } finally {
    dispose();
  }

  assertEquals(reports, []);
  assertEquals(events, [
    { kind: "mark", path: "grant-data-dir" },
    { kind: "mark", path: "grant-data-dir" },
    { kind: "push", namespace: "infra", gateHeld: true },
  ]);
});
