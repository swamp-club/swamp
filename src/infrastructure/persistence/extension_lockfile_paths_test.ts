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

import { assert, assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import { resolveExtensionLockfilePaths } from "./extension_lockfile_paths.ts";
import { registerManagedConfig } from "./paths.ts";
import { withMockedEnv } from "./path_test_helpers.ts";
import type { RepoMarkerData } from "./repo_marker_repository.ts";

function uniqueRepo(): string {
  return resolve(`/tmp/swamp-lockfile-paths-${crypto.randomUUID()}`);
}

const LOCKFILE = "upstream_extensions.json";

Deno.test("resolveExtensionLockfilePaths: includes the default non-managed lockfile", () => {
  const repoDir = uniqueRepo();
  const paths = withMockedEnv(
    { SWAMP_MODELS_DIR: undefined },
    () => resolveExtensionLockfilePaths(repoDir, null),
  );
  assert(paths.includes(join(repoDir, "extensions", "models", LOCKFILE)));
  assert(paths.includes(join(repoDir, ".swamp", "config", LOCKFILE)));
});

Deno.test("resolveExtensionLockfilePaths: follows the marker's models dir", () => {
  const repoDir = uniqueRepo();
  const marker = { modelsDir: "custom/models" } as RepoMarkerData;
  const paths = withMockedEnv(
    { SWAMP_MODELS_DIR: undefined },
    () => resolveExtensionLockfilePaths(repoDir, marker),
  );
  assert(paths.includes(join(repoDir, "custom", "models", LOCKFILE)));
  assert(paths.includes(join(repoDir, "extensions", "models", LOCKFILE)));
});

Deno.test("resolveExtensionLockfilePaths: follows SWAMP_MODELS_DIR", () => {
  const repoDir = uniqueRepo();
  const envDir = resolve("/tmp/swamp-env-models");
  const paths = withMockedEnv(
    { SWAMP_MODELS_DIR: envDir },
    () => resolveExtensionLockfilePaths(repoDir, null),
  );
  assert(paths.includes(join(envDir, LOCKFILE)));
});

Deno.test("resolveExtensionLockfilePaths: includes a registered managed-config base", () => {
  const repoDir = uniqueRepo();
  const base = resolve("/tmp/swamp-cache/tier");
  registerManagedConfig(repoDir, true, base);
  const paths = withMockedEnv(
    { SWAMP_MODELS_DIR: undefined },
    () => resolveExtensionLockfilePaths(repoDir, null),
  );
  assert(paths.includes(join(base, LOCKFILE)));
  assert(paths.includes(join(repoDir, ".swamp", "config", LOCKFILE)));
  assertEquals(new Set(paths).size, paths.length);
});
