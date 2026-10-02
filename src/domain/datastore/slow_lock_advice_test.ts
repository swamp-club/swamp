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
import { join, resolve, SEPARATOR } from "@std/path";
import {
  isShareableDatastore,
  type LockScope,
  SLOW_LOCK_THRESHOLD_MS,
  slowLockAdvice,
} from "./slow_lock_advice.ts";

const GLOBAL: LockScope = { kind: "global" };
const MODEL: LockScope = {
  kind: "model",
  modelType: "command/shell",
  modelId: "89bc5d0d",
};
const SLOW = SLOW_LOCK_THRESHOLD_MS + 1;

Deno.test("slowLockAdvice: a wait at the threshold is not slow", () => {
  for (const scope of [GLOBAL, MODEL]) {
    assertEquals(
      slowLockAdvice({
        waitedMs: SLOW_LOCK_THRESHOLD_MS,
        scope,
        shareable: true,
      }),
      undefined,
    );
  }
});

Deno.test("slowLockAdvice: a slow global lock on a shareable datastore without a namespace suggests one", () => {
  assertEquals(
    slowLockAdvice({ waitedMs: SLOW, scope: GLOBAL, shareable: true }),
    "namespace",
  );
});

Deno.test("slowLockAdvice: a slow global lock with a namespace says nothing", () => {
  assertEquals(
    slowLockAdvice({
      waitedMs: SLOW,
      scope: GLOBAL,
      shareable: true,
      namespace: "infra",
    }),
    undefined,
  );
});

Deno.test("slowLockAdvice: a slow global lock on a datastore no other repo can reach says nothing", () => {
  assertEquals(
    slowLockAdvice({ waitedMs: SLOW, scope: GLOBAL, shareable: false }),
    undefined,
  );
});

Deno.test("slowLockAdvice: a slow model lock names model contention, never a namespace", () => {
  for (const shareable of [true, false]) {
    for (const namespace of [undefined, "infra"]) {
      assertEquals(
        slowLockAdvice({ waitedMs: SLOW, scope: MODEL, shareable, namespace }),
        "model-contention",
      );
    }
  }
});

Deno.test("isShareableDatastore: an extension datastore is shareable", () => {
  assertEquals(
    isShareableDatastore(
      {
        type: "@swamp/s3-datastore",
        config: {},
        datastorePath: "bucket",
      },
      resolve("repo"),
    ),
    true,
  );
});

Deno.test("isShareableDatastore: the repo's own .swamp directory is not shareable", () => {
  const repoDir = resolve("repo");
  assertEquals(
    isShareableDatastore(
      { type: "filesystem", path: join(repoDir, ".swamp") },
      repoDir,
    ),
    false,
  );
});

Deno.test("isShareableDatastore: a relative .swamp path resolves to the repo's own directory", () => {
  assertEquals(
    isShareableDatastore(
      { type: "filesystem", path: ".swamp" },
      resolve("repo"),
    ),
    false,
  );
});

Deno.test("isShareableDatastore: a trailing separator still matches the repo's own directory", () => {
  const repoDir = resolve("repo");
  assertEquals(
    isShareableDatastore(
      { type: "filesystem", path: join(repoDir, ".swamp") + SEPARATOR },
      repoDir,
    ),
    false,
  );
});

Deno.test("isShareableDatastore: a filesystem datastore outside the repo is shareable", () => {
  assertEquals(
    isShareableDatastore(
      { type: "filesystem", path: resolve("shared", "datastore") },
      resolve("repo"),
    ),
    true,
  );
});
