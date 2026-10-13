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
import {
  BEHAVIOR_AUDIT_ACTION_PREFIX,
  BEHAVIOR_AUDIT_RESOURCE_PREFIX,
  BEHAVIOR_EXPORT_NAME,
  BEHAVIOR_MANIFEST_KEY,
  BEHAVIOR_SELECTOR_KIND,
  BEHAVIOR_STEP_TASK_FIELDS,
  BEHAVIOR_STEP_TASK_TYPE,
  BEHAVIORS_DIR_NAME,
  canonicalResourceKind,
  DEFAULT_BEHAVIORS_DIR,
  DEFAULT_MODELS_DIR,
  MODEL_AUDIT_ACTION_PREFIX,
  MODEL_AUDIT_RESOURCE_PREFIX,
  MODEL_EXPORT_NAME,
  MODEL_MANIFEST_KEY,
  MODEL_SELECTOR_KIND,
  MODEL_STEP_TASK_TYPE,
  MODELS_DIR_NAME,
  replacePrefix,
} from "./behavior_aliases.ts";

Deno.test("behavior aliases: the table pairs each behavior spelling with its model form", () => {
  assertEquals(BEHAVIOR_STEP_TASK_TYPE, "behavior");
  assertEquals(MODEL_STEP_TASK_TYPE, "model_method");
  assertEquals({ ...BEHAVIOR_STEP_TASK_FIELDS }, {
    behavior: "modelIdOrName",
    behaviorType: "modelType",
    behaviorName: "modelName",
  });
  assertEquals(BEHAVIOR_SELECTOR_KIND, "behavior");
  assertEquals(MODEL_SELECTOR_KIND, "model");
  assertEquals(BEHAVIOR_AUDIT_ACTION_PREFIX, "behavior.");
  assertEquals(MODEL_AUDIT_ACTION_PREFIX, "model.");
  assertEquals(BEHAVIOR_AUDIT_RESOURCE_PREFIX, "behavior:");
  assertEquals(MODEL_AUDIT_RESOURCE_PREFIX, "model:");
});

Deno.test("canonicalResourceKind: maps only the exact behavior spelling", () => {
  assertEquals(canonicalResourceKind("behavior"), "model");
  for (
    const kind of [
      "model",
      "workflow",
      "data",
      "behaviour",
      "behaviors",
      "Behavior",
      "BEHAVIOR",
      " behavior",
      "",
    ]
  ) {
    assertEquals(canonicalResourceKind(kind), kind, kind);
  }
});

Deno.test("replacePrefix: replaces a leading prefix only", () => {
  assertEquals(
    replacePrefix("behavior.run", "behavior.", "model."),
    "model.run",
  );
  assertEquals(
    replacePrefix("x.behavior.run", "behavior.", "model."),
    "x.behavior.run",
  );
  assertEquals(
    replacePrefix("behaviour.run", "behavior.", "model."),
    "behaviour.run",
  );
  assertEquals(replacePrefix("behavior.", "behavior.", "model."), "model.");
});

Deno.test("behavior aliases: the extension export, directory and manifest key pair with their model forms", () => {
  assertEquals(BEHAVIOR_EXPORT_NAME, "behavior");
  assertEquals(MODEL_EXPORT_NAME, "model");
  assertEquals(BEHAVIORS_DIR_NAME, "behaviors");
  assertEquals(MODELS_DIR_NAME, "models");
  assertEquals(DEFAULT_BEHAVIORS_DIR, "extensions/behaviors");
  assertEquals(DEFAULT_MODELS_DIR, "extensions/models");
  assertEquals(BEHAVIOR_MANIFEST_KEY, "behaviors");
  assertEquals(MODEL_MANIFEST_KEY, "models");
});
