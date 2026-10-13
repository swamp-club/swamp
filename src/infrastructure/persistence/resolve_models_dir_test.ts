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
import { resolveBehaviorsDir, resolveModelsDir } from "./resolve_models_dir.ts";
import type { RepoMarkerData } from "./repo_marker_repository.ts";
import { withMockedEnv } from "./path_test_helpers.ts";

const marker = (modelsDir?: string): RepoMarkerData => ({
  swampVersion: "",
  initializedAt: "",
  ...(modelsDir !== undefined ? { modelsDir } : {}),
});

Deno.test("resolveBehaviorsDir: extensions/behaviors beside the default models directory", () => {
  withMockedEnv({ SWAMP_MODELS_DIR: undefined }, () => {
    assertEquals(resolveModelsDir(null), "extensions/models");
    assertEquals(resolveBehaviorsDir(null), "extensions/behaviors");
    assertEquals(resolveBehaviorsDir(marker()), "extensions/behaviors");
    assertEquals(
      resolveBehaviorsDir(marker("extensions/models")),
      "extensions/behaviors",
    );
  });
});

Deno.test("resolveBehaviorsDir: none once the models directory is configured", () => {
  withMockedEnv({ SWAMP_MODELS_DIR: undefined }, () => {
    assertEquals(resolveBehaviorsDir(marker("src/models")), undefined);
  });
  withMockedEnv({ SWAMP_MODELS_DIR: "/abs/models" }, () => {
    assertEquals(resolveBehaviorsDir(null), undefined);
  });
});
