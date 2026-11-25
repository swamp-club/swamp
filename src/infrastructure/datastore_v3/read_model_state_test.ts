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
import { DatabaseSync, StatementSync } from "node:sqlite";
import fc from "fast-check";
import {
  READ_MODEL_STATE_SCHEMA_VERSION,
  ReadModelState,
} from "./read_model_state.ts";
import type { CompactedBaseEntry } from "../../domain/datastore_v3/commit_store.ts";
import { DataMetadataSchema } from "../../domain/data/data_metadata.ts";
import {
  metadata,
  modelPartition,
} from "../../domain/datastore_v3/v3_test_helpers.ts";

async function withStatePath(
  fn: (path: string) => Promise<void> | void,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-read-model-state-" });
  try {
    await fn(join(dir, "_read_model_v3.db"));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("ReadModelState.configBase: keeps the first base a commit recorded across reopens and resets, until the definition is loaded or committed (swamp-club#4097)", async () => {
  const P = "config--workflow--deploy";
  const K = "config/workflows/workflow-deploy.yaml";
  await withStatePath((path) => {
    const state = ReadModelState.open(path);
    try {
      assertEquals(state.configBase("", P, K), undefined);
      state.recordConfigBase("", P, K, "a".repeat(64));
      state.recordConfigBase("", P, K, "b".repeat(64));
      assertEquals(state.configBase("", P, K), { sha256: "a".repeat(64) });
      state.reset(3, true);
    } finally {
      state.close();
    }
    const reopened = ReadModelState.open(path);
    try {
      assertEquals(reopened.configBase("", P, K), { sha256: "a".repeat(64) });
      assertEquals(reopened.configBase("team", P, K), undefined);
      reopened.clearConfigBases("", P, K);
      assertEquals(reopened.configBase("", P, K), undefined);
      reopened.recordConfigBase("", P, K, undefined);
      assertEquals(reopened.configBase("", P, K), "absent");
      reopened.clearConfigBases("", P);
      assertEquals(reopened.configBase("", P, K), undefined);
    } finally {
      reopened.close();
    }
  });
});

Deno.test("ReadModelState.stampFilterInputs: stamps the first inputs, keeps them against later ones, and a reset never clears them (swamp-club#3691)", async () => {
  await withStatePath((path) => {
    const state = ReadModelState.open(path);
    try {
      assertEquals(state.filterInputs(), undefined);
      assertEquals(state.stampFilterInputs('{"a":1}'), '{"a":1}');
      assertEquals(state.stampFilterInputs('{"a":2}'), '{"a":1}');
      state.reset(3, true);
      assertEquals(state.filterInputs(), '{"a":1}');
      assertEquals(state.catalogGeneration(), 3);
    } finally {
      state.close();
    }
    const reopened = ReadModelState.open(path);
    try {
      assertEquals(reopened.filterInputs(), '{"a":1}');
    } finally {
      reopened.close();
    }
  });
});

Deno.test("ReadModelState: a schema-5 state migrates to the checkout filter table, keeping its progress (swamp-club#3691)", async () => {
  await withStatePath((path) => {
    const state = ReadModelState.open(path);
    state.reset(7);
    state.close();
    const db = new DatabaseSync(path);
    db.exec("DROP TABLE checkout_filter; PRAGMA user_version=5");
    db.close();

    const reopened = ReadModelState.open(path);
    try {
      assertEquals(reopened.catalogGeneration(), 7);
      assertEquals(reopened.filterInputs(), undefined);
      assertEquals(reopened.stampFilterInputs("x"), "x");
    } finally {
      reopened.close();
    }
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      assertEquals(
        (check.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }).user_version,
        READ_MODEL_STATE_SCHEMA_VERSION,
      );
    } finally {
      check.close();
    }
    assertEquals(READ_MODEL_STATE_SCHEMA_VERSION, 10);
  });
});

Deno.test("ReadModelState.liveRecord: records who wrote each record, and a schema-7 row reads as unknown (swamp-club#3922)", async () => {
  await withStatePath((path) => {
    const state = ReadModelState.open(path);
    const apply = (seq: number, key: string, writer: string) =>
      state.recordApplied({
        namespace: "",
        partition: "p",
        seq,
        records: new Map([[key, { sha256: "a".repeat(64), writer }]]),
        versions: new Map(),
      });
    try {
      apply(1, "serve.yaml", "");
      apply(2, "forwarded.yaml", "user:ana");
      assertEquals(state.liveRecord("", "p", "serve.yaml")?.writer, "");
      assertEquals(
        state.liveRecord("", "p", "forwarded.yaml")?.writer,
        "user:ana",
      );
      assertEquals(state.liveRecord("", "p", "absent.yaml"), undefined);
      assertEquals(state.holdsRecordsUnder("", "p"), true);
      assertEquals(state.holdsRecordsUnder("", "q"), false);
    } finally {
      state.close();
    }
    const db = new DatabaseSync(path);
    db.exec(
      "ALTER TABLE live_records DROP COLUMN writer; PRAGMA user_version=7",
    );
    db.close();
    const reopened = ReadModelState.open(path);
    try {
      assertEquals(reopened.liveRecord("", "p", "serve.yaml")?.writer, null);
    } finally {
      reopened.close();
    }
  });
});

Deno.test("ReadModelState.presentKeysFoldedTo: keeps in step with applied files, and forgets what a rollback or reset undoes (swamp-club#3939)", async () => {
  await withStatePath((path) => {
    const state = ReadModelState.open(path);
    let seq = 0;
    const apply = (files: [string, boolean][]) =>
      state.recordApplied({
        namespace: "",
        partition: "p",
        seq: ++seq,
        records: new Map(),
        versions: new Map(),
        files: new Map(
          files.map((
            [key, present],
          ) => [key, { owner: "p", mark: seq, present }]),
        ),
      });
    const keys = () => [...state.presentKeysFoldedTo("", "data/vpc/1/raw")];
    try {
      apply([["data/vpc/1/raw", true]]);
      assertEquals(keys(), ["data/vpc/1/raw"]);
      apply([["data/VPC/1/raw", true]]);
      assertEquals(keys().toSorted(), ["data/VPC/1/raw", "data/vpc/1/raw"]);
      apply([["data/vpc/1/raw", false]]);
      assertEquals(keys(), ["data/VPC/1/raw"]);
      assertEquals(
        [...state.presentKeysFoldedTo("alpha", "data/vpc/1/raw")],
        [],
      );

      state.beginBatch();
      apply([["data/Vpc/1/raw", true]]);
      assertEquals(keys().toSorted(), ["data/VPC/1/raw", "data/Vpc/1/raw"]);
      state.rollbackBatch();
      seq--;
      assertEquals(keys(), ["data/VPC/1/raw"]);

      state.reset(1);
      assertEquals(keys(), []);
    } finally {
      state.close();
    }
  });
});

Deno.test("ReadModelState.incompletePid: names the process whose reset or base load cleared the complete mark, until a catch-up completes (swamp-club#4277)", async () => {
  await withStatePath((path) => {
    const writer = ReadModelState.open(path, { pid: 41 });
    try {
      assertEquals(writer.incompletePid(), undefined);
      writer.reset(1);
      assertEquals(writer.incompletePid(), 41);
      writer.markComplete();
      assertEquals(writer.incompletePid(), undefined);
      writer.finishLoad(3);
      assertEquals(writer.incompletePid(), 41);
    } finally {
      writer.close();
    }
    const reader = ReadModelState.open(path, { pid: 42 });
    try {
      assertEquals(reader.incompletePid(), 41);
      reader.reset(2);
      assertEquals(reader.incompletePid(), 42);
      reader.markComplete();
      assertEquals(reader.incompletePid(), undefined);
    } finally {
      reader.close();
    }
  });
});

function baseEntries(names: number): CompactedBaseEntry[] {
  const partition = modelPartition().toString();
  const entries: CompactedBaseEntry[] = [
    { kind: "partition", namespace: "", partition, seq: names },
  ];
  for (let i = 0; i < names; i++) {
    const name = `name-${i}`;
    const key = `data/${name}/1/raw`;
    const meta = DataMetadataSchema.parse(metadata(name, 1));
    entries.push(
      {
        kind: "record",
        namespace: "",
        partition,
        key,
        record: { sha256: "a".repeat(64), content: { inline: "eA==" } },
      },
      {
        kind: "version",
        namespace: "",
        partition,
        version: { version: 1, metadata: meta },
      },
      { kind: "catalog-row", namespace: "", partition, metadata: meta },
      { kind: "forward", namespace: "", partition, name, to: `${name}-new` },
      {
        kind: "file",
        namespace: "",
        key,
        ownership: { owner: partition, mark: 1, present: true },
      },
    );
  }
  return entries;
}

Deno.test("ReadModelState.stageBase: prepares no statement however many entries it stages", async () => {
  for (const names of [5, 100]) {
    await withStatePath((path) => {
      const state = ReadModelState.open(path);
      try {
        const prepare = DatabaseSync.prototype.prepare;
        let prepared = 0;
        DatabaseSync.prototype.prepare = function (
          this: DatabaseSync,
          ...args: Parameters<typeof prepare>
        ) {
          prepared++;
          return prepare.apply(this, args);
        };
        try {
          state.stageBase(baseEntries(names));
        } finally {
          DatabaseSync.prototype.prepare = prepare;
        }
        assertEquals(prepared, 0);
        assertEquals(state.stagedFiles().length, names);
        assertEquals(state.loadCatalogNames().length, names);
        assertEquals(
          state.loadContent("", "data/name-0/1/raw"),
          { inline: "eA==" },
        );
      } finally {
        state.close();
      }
    });
  }
});

Deno.test("ReadModelState.presentKeyCount: counts a namespace's present keys as presentKeys lists them (swamp-club#4702)", async () => {
  await withStatePath((path) => {
    const state = ReadModelState.open(path);
    let seq = 0;
    const apply = (namespace: string, files: [string, boolean][]) =>
      state.recordApplied({
        namespace,
        partition: "p",
        seq: ++seq,
        records: new Map(),
        versions: new Map(),
        files: new Map(
          files.map((
            [key, present],
          ) => [key, { owner: "p", mark: seq, present }]),
        ),
      });
    try {
      assertEquals(state.presentKeyCount(""), 0);
      apply("", [["data/a/1/raw", true], ["data/b/1/raw", true]]);
      apply("team", [["data/c/1/raw", true]]);
      apply("", [["data/a/1/raw", false]]);
      for (const namespace of ["", "team", "other"]) {
        assertEquals(
          state.presentKeyCount(namespace),
          state.presentKeys(namespace).size,
        );
      }
      assertEquals(state.presentKeyCount(""), 1);
    } finally {
      state.close();
    }
  });
});

function keyedCommit(
  seq: number,
  keys: number,
  boot: string,
): Parameters<ReadModelState["recordApplied"]>[0] {
  const names = Array.from(
    { length: keys },
    (_, i) => `data/n${i}/${seq}/raw`,
  );
  return {
    namespace: "",
    partition: "p",
    seq,
    cursor: seq,
    records: new Map(names.map((key) => [key, { sha256: "a".repeat(64) }])),
    versions: new Map(),
    files: new Map(
      names.map((key) => [key, { owner: "p", mark: seq, present: true }]),
    ),
    unsynced: { keys: new Set(names), boot },
    decided: new Set(names),
    unreadable: new Map(),
  };
}

/** every node:sqlite call `fn` makes, by kind */
function sqliteCalls(fn: () => void): number {
  const db = DatabaseSync.prototype as unknown as Record<string, unknown>;
  const statement = StatementSync.prototype as unknown as Record<
    string,
    unknown
  >;
  const saved: [Record<string, unknown>, string, unknown][] = [];
  let calls = 0;
  const wrap = (target: Record<string, unknown>, method: string) => {
    const original = target[method] as (...args: unknown[]) => unknown;
    saved.push([target, method, original]);
    target[method] = function (this: unknown, ...args: unknown[]) {
      calls++;
      return original.apply(this, args);
    };
  };
  for (const method of ["exec", "prepare"]) wrap(db, method);
  for (const method of ["run", "get", "all", "iterate"]) {
    wrap(statement, method);
  }
  try {
    fn();
  } finally {
    for (const [target, method, original] of saved) target[method] = original;
  }
  return calls;
}

Deno.test("ReadModelState.recordApplied: in a batch, a commit costs the same nine SQLite calls however many keys it writes (swamp-club#5094)", async () => {
  for (const keys of [1, 14, 40]) {
    await withStatePath((path) => {
      const state = ReadModelState.open(path);
      try {
        state.beginBatch();
        state.recordApplied(keyedCommit(1, keys, "boot-1"));
        const commits = 10;
        const calls = sqliteCalls(() => {
          for (let seq = 2; seq < 2 + commits; seq++) {
            state.recordApplied(keyedCommit(seq, keys, "boot-1"));
          }
        });
        state.commitBatch();
        assertEquals({ keys, perCommit: calls / commits }, {
          keys,
          perCommit: 9,
        });
        assertEquals(state.unsyncedKeys(1000).length, keys * (1 + commits));
        assertEquals(state.unsyncedBoot(), "boot-1");
      } finally {
        state.close();
      }
    });
  }
});

Deno.test("ReadModelState.recordApplied: a decided key's unreadable record is forgotten whether it was noted before the batch, in it, or by another connection between batches (swamp-club#5094)", async () => {
  await withStatePath((path) => {
    const state = ReadModelState.open(path);
    const unreadable = (namespace: string, key: string, seq: number) => ({
      namespace,
      recordKey: key,
      partition: "p",
      seq,
      position: seq,
      reason: "missing" as const,
      lastAttempt: new Date(0),
    });
    const decide = (namespace: string, seq: number, keys: string[]) =>
      state.recordApplied({
        namespace,
        partition: "p",
        seq,
        records: new Map(),
        versions: new Map(),
        decided: new Set(keys),
      });
    try {
      state.noteUnreadableAttempts([unreadable("", "k1", 1)]);
      state.beginBatch();
      decide("team", 1, ["k1"]);
      decide("", 1, ["k0"]);
      assertEquals(state.unreadableRecord("", "k1")?.recordKey, "k1");
      decide("", 2, ["k1"]);
      assertEquals(state.unreadableRecord("", "k1"), undefined);
      decide("team", 2, ["k2"]);
      state.noteUnreadableAttempts([unreadable("team", "k2", 2)]);
      decide("team", 3, ["k2"]);
      assertEquals(state.unreadableRecord("team", "k2"), undefined);
      decide("ops", 1, ["k3"]);
      state.commitBatch();

      const other = ReadModelState.open(path);
      try {
        other.noteUnreadableAttempts([unreadable("ops", "k3", 2)]);
      } finally {
        other.close();
      }
      state.beginBatch();
      decide("ops", 2, ["k3"]);
      state.commitBatch();
      assertEquals(state.unreadableRecord("ops", "k3"), undefined);
    } finally {
      state.close();
    }
  });
});

type StateStep =
  | {
    readonly kind: "commit";
    readonly namespace: string;
    readonly partition: string;
    readonly puts: readonly string[];
    readonly removes: readonly string[];
    readonly files: readonly (readonly [string, boolean])[];
    readonly decided: readonly string[];
    readonly unreadable: readonly string[];
    readonly unsynced: readonly string[];
    readonly boot: string;
  }
  | { readonly kind: "forget-unreadable"; readonly key: string }
  | { readonly kind: "clear-unsynced" }
  | { readonly kind: "forget-unsynced"; readonly key: string };

const stateKey = fc.constantFrom("k1", "k2", "k3", "k4");
const stateKeys = fc.uniqueArray(stateKey, { maxLength: 4 });
const stateStep: fc.Arbitrary<StateStep> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant("commit" as const),
      namespace: fc.constantFrom("", "team"),
      partition: fc.constantFrom("p", "q"),
      puts: stateKeys,
      removes: stateKeys,
      files: fc.uniqueArray(fc.tuple(stateKey, fc.boolean()), {
        maxLength: 4,
        selector: ([key]) => key,
      }),
      decided: stateKeys,
      unreadable: stateKeys,
      unsynced: stateKeys,
      boot: fc.constantFrom("b1", "b2"),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("forget-unreadable" as const),
      key: stateKey,
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "clear-unsynced" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("forget-unsynced" as const),
      key: stateKey,
    }),
  },
);

function applyStep(
  state: ReadModelState,
  step: StateStep,
  seqs: Map<string, number>,
  cursor: number,
): void {
  switch (step.kind) {
    case "commit": {
      const id = `${step.namespace}/${step.partition}`;
      const seq = (seqs.get(id) ?? 0) + 1;
      seqs.set(id, seq);
      const records = new Map<string, { sha256: string } | null>();
      for (const key of step.removes) records.set(key, null);
      for (const key of step.puts) {
        records.set(key, { sha256: `${seq}`.padStart(64, "0") });
      }
      state.recordApplied({
        namespace: step.namespace,
        partition: step.partition,
        seq,
        cursor,
        records,
        versions: new Map(),
        files: new Map(
          step.files.map((
            [key, present],
          ) => [key, { owner: step.partition, mark: cursor, present }]),
        ),
        decided: new Set(step.decided),
        unreadable: new Map(step.unreadable.map((key) => [key, {
          namespace: step.namespace,
          recordKey: key,
          partition: step.partition,
          seq,
          position: cursor,
          reason: "missing" as const,
          lastAttempt: new Date(cursor),
        }])),
        ...(step.unsynced.length === 0
          ? {}
          : { unsynced: { keys: new Set(step.unsynced), boot: step.boot } }),
      });
      return;
    }
    case "forget-unreadable":
      state.forgetUnreadable("", step.key);
      return;
    case "clear-unsynced":
      state.clearUnsynced();
      return;
    case "forget-unsynced":
      state.forgetUnsynced([{ namespace: "", record_key: step.key }]);
      return;
  }
}

function dumpState(path: string): Record<string, string[]> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as { name: string }[]).map((row) => row.name);
    const dump: Record<string, string[]> = {};
    for (const table of tables) {
      dump[table] = (db.prepare(`SELECT * FROM "${table}"`).all())
        .map((row) => JSON.stringify(row)).toSorted();
    }
    return dump;
  } finally {
    db.close();
  }
}

Deno.test("ReadModelState.recordApplied: commits applied a batch at a time leave, at each batch's end, the same state as each in its own transaction (swamp-club#5094)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.tuple(stateStep, fc.boolean()), {
        minLength: 1,
        maxLength: 30,
      }),
      async (steps) => {
        const unbatched: Record<string, string[]>[] = [];
        await withStatePath((path) => {
          const state = ReadModelState.open(path, { pid: 7 });
          const seqs = new Map<string, number>();
          try {
            steps.forEach(([step], i) => {
              applyStep(state, step, seqs, i + 1);
              unbatched.push(dumpState(path));
            });
          } finally {
            state.close();
          }
        });
        await withStatePath((path) => {
          const state = ReadModelState.open(path, { pid: 7 });
          const seqs = new Map<string, number>();
          try {
            let open = false;
            steps.forEach(([step, endsBatch], i) => {
              if (!open) {
                state.beginBatch();
                open = true;
              }
              applyStep(state, step, seqs, i + 1);
              if (endsBatch || i === steps.length - 1) {
                state.commitBatch();
                open = false;
                assertEquals(dumpState(path), unbatched[i], `after step ${i}`);
              }
            });
          } finally {
            state.close();
          }
        });
      },
    ),
    { numRuns: 150 },
  );
});
