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
import { DatabaseSync } from "node:sqlite";
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
    assertEquals(READ_MODEL_STATE_SCHEMA_VERSION, 9);
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
