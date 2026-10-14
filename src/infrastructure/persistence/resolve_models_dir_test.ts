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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  modelsDirEnvConflict,
  resolveBehaviorsDir,
  resolveModelsDir,
} from "./resolve_models_dir.ts";
import type { RepoMarkerData } from "./repo_marker_repository.ts";
import { withMockedEnv } from "./path_test_helpers.ts";

const marker = (modelsDir?: string): RepoMarkerData => ({
  swampVersion: "",
  initializedAt: "",
  ...(modelsDir !== undefined ? { modelsDir } : {}),
});

Deno.test("resolveBehaviorsDir: extensions/behaviors beside the default models directory", () => {
  withMockedEnv(
    { SWAMP_MODELS_DIR: undefined, SWAMP_BEHAVIORS_DIR: undefined },
    () => {
      assertEquals(resolveModelsDir(null), "extensions/models");
      assertEquals(resolveBehaviorsDir(null), "extensions/behaviors");
      assertEquals(resolveBehaviorsDir(marker()), "extensions/behaviors");
      assertEquals(
        resolveBehaviorsDir(marker("extensions/models")),
        "extensions/behaviors",
      );
    },
  );
});

Deno.test("resolveBehaviorsDir: none once the models directory is configured", () => {
  withMockedEnv(
    { SWAMP_MODELS_DIR: undefined, SWAMP_BEHAVIORS_DIR: undefined },
    () => {
      assertEquals(resolveBehaviorsDir(marker("src/models")), undefined);
    },
  );
  withMockedEnv({
    SWAMP_MODELS_DIR: "/abs/models",
    SWAMP_BEHAVIORS_DIR: undefined,
  }, () => {
    assertEquals(resolveBehaviorsDir(null), undefined);
  });
});

Deno.test("resolveModelsDir: SWAMP_BEHAVIORS_DIR names the models directory like SWAMP_MODELS_DIR", () => {
  withMockedEnv(
    { SWAMP_MODELS_DIR: undefined, SWAMP_BEHAVIORS_DIR: "env/behaviors" },
    () => {
      assertEquals(resolveModelsDir(null), "env/behaviors");
      // It wins over .swamp.yaml, as SWAMP_MODELS_DIR does.
      assertEquals(resolveModelsDir(marker("src/models")), "env/behaviors");
      // A moved models directory has no behaviors sibling.
      assertEquals(resolveBehaviorsDir(null), undefined);
    },
  );
});

Deno.test("resolveModelsDir: SWAMP_MODELS_DIR wins over SWAMP_BEHAVIORS_DIR", () => {
  withMockedEnv(
    { SWAMP_MODELS_DIR: "env/models", SWAMP_BEHAVIORS_DIR: "env/behaviors" },
    () => {
      assertEquals(resolveModelsDir(marker("src/models")), "env/models");
    },
  );
});

Deno.test("resolveModelsDir: an empty variable counts as unset", () => {
  withMockedEnv({ SWAMP_MODELS_DIR: "", SWAMP_BEHAVIORS_DIR: "" }, () => {
    assertEquals(resolveModelsDir(null), "extensions/models");
    assertEquals(resolveModelsDir(marker("src/models")), "src/models");
    assertEquals(resolveBehaviorsDir(null), "extensions/behaviors");
  });
  withMockedEnv(
    { SWAMP_MODELS_DIR: "", SWAMP_BEHAVIORS_DIR: "env/behaviors" },
    () => {
      assertEquals(resolveModelsDir(null), "env/behaviors");
    },
  );
  withMockedEnv(
    { SWAMP_MODELS_DIR: "env/models", SWAMP_BEHAVIORS_DIR: "" },
    () => {
      assertEquals(resolveModelsDir(null), "env/models");
    },
  );
});

Deno.test("modelsDirEnvConflict: only different non-empty values conflict", () => {
  const cases: Array<[string | undefined, string | undefined]> = [
    [undefined, undefined],
    ["env/models", undefined],
    [undefined, "env/behaviors"],
    ["", "env/behaviors"],
    ["env/models", ""],
    ["same/dir", "same/dir"],
  ];
  for (const [modelsDir, behaviorsDir] of cases) {
    withMockedEnv(
      { SWAMP_MODELS_DIR: modelsDir, SWAMP_BEHAVIORS_DIR: behaviorsDir },
      () => {
        assertEquals(
          modelsDirEnvConflict(),
          undefined,
          `${modelsDir} / ${behaviorsDir}`,
        );
      },
    );
  }
  withMockedEnv(
    { SWAMP_MODELS_DIR: "env/models", SWAMP_BEHAVIORS_DIR: "env/behaviors" },
    () => {
      const conflict = modelsDirEnvConflict();
      assertStringIncludes(conflict ?? "", "SWAMP_MODELS_DIR (env/models)");
      assertStringIncludes(
        conflict ?? "",
        "SWAMP_BEHAVIORS_DIR (env/behaviors)",
      );
    },
  );
});
