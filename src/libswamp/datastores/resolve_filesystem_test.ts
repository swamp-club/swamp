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

import { assertEquals, assertRejects } from "@std/assert";
import { join, resolve } from "@std/path";
import { DefaultDatastorePathResolver } from "../../infrastructure/persistence/default_datastore_path_resolver.ts";
import {
  assertPathEquals,
  withMockedEnv,
} from "../../infrastructure/persistence/path_test_helpers.ts";
import { resolveFilesystemDatastoreConfig } from "./resolve_filesystem.ts";

Deno.test("resolveFilesystemDatastoreConfig: expands paths against the repository without changing omitted routing defaults", async () => {
  const repo = resolve("filesystem-normalizer-repo");
  const home = resolve("filesystem-normalizer-home");
  await withMockedEnv(
    { HOME: home, STORE_PATH: "external-store" },
    async () => {
      for (
        const [path, expected] of [
          ["$STORE_PATH/data", join(repo, "external-store", "data")],
          ["${STORE_PATH}/data", join(repo, "external-store", "data")],
          ["~/data", join(home, "data")],
          [join(home, "absolute-store"), join(home, "absolute-store")],
        ]
      ) {
        const config = await resolveFilesystemDatastoreConfig({
          type: "filesystem",
          path,
        }, repo);
        assertPathEquals(config.path, expected);
        assertEquals(config.directories, undefined);
        assertEquals(config.exclude, undefined);
        assertEquals(config.namespace, undefined);
        assertEquals(config.format, undefined);
      }
    },
  );
});

Deno.test("resolveFilesystemDatastoreConfig: expression-selected routing and exclusions use the intended filesystem tier", async () => {
  const repo = resolve("filesystem-routing-repo");
  const store = resolve("filesystem-routing-store");
  await withMockedEnv({
    ROUTING_STORE: store,
    ROUTING_DIR: "data",
    LOCAL_NAME: "private",
    ROUTING_NAMESPACE: "team-a",
  }, async () => {
    const input = {
      type: "filesystem",
      path: "$ROUTING_STORE",
      directories: ["${{ env.ROUTING_DIR }}", "outputs"],
      exclude: ["outputs/${{ env.LOCAL_NAME }}/**"],
      namespace: "${{ env.ROUTING_NAMESPACE }}",
      format: 2,
    };
    const config = await resolveFilesystemDatastoreConfig(input, repo);
    const resolver = new DefaultDatastorePathResolver(repo, config);
    assertPathEquals(
      resolver.resolvePath("data", "record.json"),
      join(store, "team-a", "data", "record.json"),
    );
    assertPathEquals(
      resolver.resolvePath("outputs", "public", "run.yaml"),
      join(store, "team-a", "outputs", "public", "run.yaml"),
    );
    assertPathEquals(
      resolver.resolvePath("outputs", "private", "run.yaml"),
      join(repo, ".swamp", "outputs", "private", "run.yaml"),
    );
    assertPathEquals(
      resolver.resolvePath("workflow-runs", "run.yaml"),
      join(repo, ".swamp", "workflow-runs", "run.yaml"),
    );
    assertEquals(config.format, 2);
    assertEquals(input.directories, ["${{ env.ROUTING_DIR }}", "outputs"]);
    assertEquals(input.exclude, ["outputs/${{ env.LOCAL_NAME }}/**"]);
  });
});

Deno.test("resolveFilesystemDatastoreConfig: explicit blocks require a path", async () => {
  for (const path of [undefined, ""]) {
    await assertRejects(
      () => resolveFilesystemDatastoreConfig({ type: "filesystem", path }, "."),
      Error,
      "requires a 'path' field",
    );
  }
});

Deno.test("resolveFilesystemDatastoreConfig: validates format before routing fields", async () => {
  for (const format of [0, 1, 4, 2.5, NaN, "2" as unknown as number]) {
    await assertRejects(
      () =>
        resolveFilesystemDatastoreConfig({
          type: "filesystem",
          path: ".swamp",
          format,
          directories: ["${{ env.UNSET_ROUTING_VARIABLE }}"],
        }, "."),
      Error,
      "datastore format must be 2 or 3",
    );
  }
  const config = await resolveFilesystemDatastoreConfig({
    type: "filesystem",
    path: ".swamp",
    format: 3,
  }, ".");
  assertEquals(config.format, 3);
});

Deno.test("resolveFilesystemDatastoreConfig: missing expression inputs fail instead of choosing a fallback tier", async () => {
  await withMockedEnv({ UNSET_ROUTING_VARIABLE: undefined }, async () => {
    for (const field of ["directories", "exclude"] as const) {
      await assertRejects(
        () =>
          resolveFilesystemDatastoreConfig({
            type: "filesystem",
            path: ".swamp",
            [field]: ["${{ env.UNSET_ROUTING_VARIABLE }}"],
          }, "."),
        Error,
        'Environment variable "UNSET_ROUTING_VARIABLE" is not set or empty',
      );
    }
  });
});

Deno.test("resolveFilesystemDatastoreConfig: awaits location admission before resolving routing expressions", async () => {
  const repo = resolve("filesystem-admission-repo");
  const entered = Promise.withResolvers<void>();
  const admission = Promise.withResolvers<void>();
  const refusal = new Error("filesystem location refused");
  let settled = false;
  const outcome = withMockedEnv(
    { UNSET_ROUTING_VARIABLE: undefined },
    () =>
      resolveFilesystemDatastoreConfig(
        {
          type: "filesystem",
          path: "store",
          format: 2,
          directories: ["${{ env.UNSET_ROUTING_VARIABLE }}"],
        },
        repo,
        {
          beforeExpressions(base) {
            assertPathEquals(base.path, join(repo, "store"));
            assertEquals(base.type, "filesystem");
            assertEquals(base.format, 2);
            assertEquals(base.directories, undefined);
            entered.resolve();
            return admission.promise;
          },
        },
      ),
  ).then(
    (config) => {
      settled = true;
      return config;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    assertEquals(
      await Promise.race([
        entered.promise.then(() => "admission"),
        outcome.then(() => "settled"),
      ]),
      "admission",
    );
    assertEquals(settled, false);
    admission.reject(refusal);
    assertEquals(
      await outcome,
      refusal,
      "admission refusal precedes the missing routing variable",
    );
  } finally {
    admission.resolve();
    await outcome;
  }
});

Deno.test("resolveFilesystemDatastoreConfig: location admission preserves the normal resolved result", async () => {
  const repo = resolve("filesystem-admitted-repo");
  let admissions = 0;
  await withMockedEnv({ ROUTING_DIRECTORY: "data" }, async () => {
    const config = await resolveFilesystemDatastoreConfig(
      {
        type: "filesystem",
        path: "store",
        directories: ["${{ env.ROUTING_DIRECTORY }}"],
      },
      repo,
      {
        beforeExpressions(base) {
          admissions++;
          assertPathEquals(base.path, join(repo, "store"));
          assertEquals(base.format, undefined);
          return Promise.resolve();
        },
      },
    );
    assertEquals(admissions, 1);
    assertPathEquals(config.path, join(repo, "store"));
    assertEquals(config.directories, ["data"]);
    assertEquals(config.format, undefined);
    assertEquals(config.namespace, undefined);
  });
});
