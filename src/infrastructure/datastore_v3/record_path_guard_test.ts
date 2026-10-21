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
import { join, resolve, SEPARATOR } from "@std/path";
import fc from "fast-check";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import { swampPath } from "../persistence/paths.ts";
import {
  isCheckoutLocalKey,
  MATERIALISED_SUBDIRS,
  READ_MODEL_STATE_DIR,
  readModelStateDir,
  refusedKeyReason,
  REPO_LOCAL_STREAM_SUBDIRS,
} from "./record_path_guard.ts";

// Paths are only resolved lexically: nothing here touches the filesystem.
const REPO = resolve("guard-repo");
const ROOT = swampPath(REPO);
const STATE = readModelStateDir(REPO);

function refused(key: string, root = ROOT, state = STATE): string | undefined {
  return refusedKeyReason(RecordKey.create(key), root, state);
}

function lands(key: string, root: string, dir: string): boolean {
  const path = resolve(join(root, ...key.split("/"))).toLowerCase();
  const inside = resolve(dir).toLowerCase();
  return path === inside || path.startsWith(inside + SEPARATOR);
}

Deno.test("readModelStateDir: is the checkout's own .swamp/_read_model_v3", () => {
  assertEquals(STATE, join(REPO, ".swamp", READ_MODEL_STATE_DIR));
});

Deno.test("refusedKeyReason: allows keys under a synced directory", () => {
  for (const dir of MATERIALISED_SUBDIRS) {
    assertEquals(refused(`${dir}/x/1/raw`), undefined);
  }
});

Deno.test("refusedKeyReason: refuses always-local, unknown and state-directory first segments", () => {
  for (
    const key of [
      "secrets/keyfile",
      "bundles/x.js",
      "audit-wal/1",
      "models/x.yaml",
      "Data/x",
      `${READ_MODEL_STATE_DIR}/_read_model_v3.db`,
      `${READ_MODEL_STATE_DIR}/read_model.lock`,
      `${READ_MODEL_STATE_DIR}/_catalog_v3.db`,
    ]
  ) {
    assertStringIncludes(
      refused(key) ?? "",
      "not a datastore-synced directory",
    );
  }
});

Deno.test("refusedKeyReason: refuses keys under a repo-local stream directory", () => {
  for (const dir of REPO_LOCAL_STREAM_SUBDIRS) {
    assertEquals(MATERIALISED_SUBDIRS.has(dir), false);
    for (
      const key of [
        `${dir}/commands-2026-10-12.jsonl`,
        `${dir}/x/1/raw`,
        dir,
      ]
    ) {
      assertStringIncludes(
        refused(key) ?? "",
        "not a datastore-synced directory",
      );
    }
  }
});

Deno.test("refusedKeyReason: refuses catalog databases and their side files", () => {
  for (
    const key of [
      "data/_catalog.db",
      "data/_catalog.db-wal",
      "data/_catalog.db-shm",
      "data/_catalog.db-journal",
      "data/_catalog_v3.db",
      "data/x/_CATALOG.DB",
    ]
  ) {
    assertEquals(refused(key), "it names a catalog database");
  }
});

Deno.test("refusedKeyReason: refuses a key landing in a state directory inside a synced one", () => {
  const state = join(ROOT, "data", "state");
  assertEquals(
    refused("data/state/x", ROOT, state),
    "it lands in the read model's state directory",
  );
  assertEquals(
    refused("data/STATE", ROOT, state),
    "it lands in the read model's state directory",
  );
  assertEquals(refused("data/stately/x", ROOT, state), undefined);
});

const SEGMENTS = [
  "data",
  "outputs",
  "secrets",
  READ_MODEL_STATE_DIR,
  READ_MODEL_STATE_DIR.toUpperCase(),
  "state",
  "_read_model_v3.db",
  "read_model.lock",
  "_catalog_v3.db",
  "raw",
];

const arbKey = fc.array(
  fc.oneof(
    fc.constantFrom(...SEGMENTS),
    fc.stringMatching(/^[A-Za-z0-9_.@-]{1,8}$/).filter((s) =>
      s !== "." && s !== ".."
    ),
  ),
  { minLength: 1, maxLength: 5 },
).map((segments) => segments.join("/"));

Deno.test("refusedKeyReason: no record key reaches the read model's state directory", () => {
  fc.assert(
    fc.property(arbKey, fc.boolean(), (key, stateInSyncedDir) => {
      // The real layout, and a state directory inside a synced directory, so
      // the state check is exercised and not only the first-segment check.
      const state = stateInSyncedDir ? join(ROOT, "data", "state") : STATE;
      if (lands(key, ROOT, state)) {
        assert(
          refused(key, ROOT, state) !== undefined,
          `${key} lands in ${state} but was not refused`,
        );
      }
    }),
    { numRuns: 2000 },
  );
});

Deno.test("isCheckoutLocalKey: dot paths, run logs and pulled extension sources are the checkout's own (swamp-club#3299)", () => {
  const local = [
    "workflow-runs/w1/.runs-index.json",
    "config/.lock",
    "data/t/m/.0f4e2a6c-1b3d-4c5e-8f90-a1b2c3d4e5f6.tmp",
    "data/t/m/.lock",
    "auto-definitions/.auto-definition-create/t-m.lock",
    "config/pulled-extensions/.swamp-staging/x/journal.json",
    "config/pulled-extensions/@x/y/mod.ts",
    "outputs/t/run/r-1.log",
    "workflow-runs/w1/workflow-run-1.log",
  ];
  for (const key of local) {
    assertEquals(isCheckoutLocalKey(key.split("/")), true, key);
  }
  const committed = [
    "data/t/m/result/1/raw",
    "outputs/t/run/r-1.yaml",
    "config/upstream_extensions.json",
    "data/t/m/notes.log",
    "auto-definitions/t/m.yaml",
  ];
  for (const key of committed) {
    assertEquals(isCheckoutLocalKey(key.split("/")), false, key);
  }
});

Deno.test("isCheckoutLocalKey: dot-named data, methods and other dot files are records (swamp-club#3736)", () => {
  const committed = [
    "data/t/m/.kubeconfig/1/raw",
    "data/t/m/.kubeconfig/1/metadata.yaml",
    "data/t/m/.kubeconfig/latest",
    "data/t/m/.env",
    "outputs/t/.probe/def-2026-10-21T00-00-00-000Z.yaml",
    "data/t/m/.terraformrc.tmp",
    "data/t/m/.0f.tmp",
    "data/t/m/.lock.d/1/raw",
    "config/.runs-index.json",
    "definitions-evaluated/.auto-definition-create/t.yaml",
  ];
  for (const key of committed) {
    assertEquals(isCheckoutLocalKey(key.split("/")), false, key);
  }
  // A directory segment is judged on its own, as the recovery sweep asks
  // before it descends: a dot-named data directory is walked.
  assertEquals(isCheckoutLocalKey(["data", "t", "m", ".kubeconfig"]), false);
  assertEquals(
    isCheckoutLocalKey(["auto-definitions", ".auto-definition-create"]),
    true,
  );
});
