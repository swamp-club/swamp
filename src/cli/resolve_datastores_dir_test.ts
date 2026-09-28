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
import { resolveDatastoresDir } from "./resolve_datastores_dir.ts";
import type { RepoMarkerData } from "../infrastructure/persistence/repo_marker_repository.ts";
import { withMockedEnv } from "../infrastructure/persistence/path_test_helpers.ts";

Deno.test("resolveDatastoresDir returns default when no config", () => {
  withMockedEnv({ SWAMP_DATASTORES_DIR: undefined }, () => {
    assertEquals(resolveDatastoresDir(null), "extensions/datastores");
  });
});

Deno.test("resolveDatastoresDir uses marker datastoresDir when set", () => {
  withMockedEnv({ SWAMP_DATASTORES_DIR: undefined }, () => {
    const marker: RepoMarkerData = {
      swampVersion: "0.1.0",
      initializedAt: "2026-01-01T00:00:00Z",
      datastoresDir: "custom/datastores",
    };
    assertEquals(resolveDatastoresDir(marker), "custom/datastores");
  });
});

Deno.test("resolveDatastoresDir prefers env var over marker", () => {
  withMockedEnv({ SWAMP_DATASTORES_DIR: "env/datastores" }, () => {
    const marker: RepoMarkerData = {
      swampVersion: "0.1.0",
      initializedAt: "2026-01-01T00:00:00Z",
      datastoresDir: "custom/datastores",
    };
    assertEquals(resolveDatastoresDir(marker), "env/datastores");
  });
});
