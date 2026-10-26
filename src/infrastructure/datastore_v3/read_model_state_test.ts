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
    assertEquals(READ_MODEL_STATE_SCHEMA_VERSION, 7);
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
        live: new Map(),
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
      // Built now: later applies keep it in step.
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
