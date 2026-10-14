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
import { ValidationWarning } from "../domain/models/validation_service.ts";
import { messageFor } from "../domain/behavior_wording.ts";
import {
  DEFAULT_COMMAND_SURFACE,
  surfaceMethodNoun,
  surfaceNoun,
  surfaceNounCapitalized,
  surfaceNounPlural,
} from "./command_surface.ts";

Deno.test("command surface: the default is the legacy model wording", () => {
  assertEquals(DEFAULT_COMMAND_SURFACE, "model");
});

Deno.test("command surface: nouns for the model surface are the legacy words", () => {
  assertEquals(surfaceNoun("model"), "model");
  assertEquals(surfaceNounPlural("model"), "models");
  assertEquals(surfaceNounCapitalized("model"), "Model");
  assertEquals(surfaceMethodNoun("model"), "model method");
});

Deno.test("command surface: nouns for the behavior surface follow the glossary", () => {
  assertEquals(surfaceNoun("behavior"), "behavior");
  assertEquals(surfaceNounPlural("behavior"), "behaviors");
  assertEquals(surfaceNounCapitalized("behavior"), "Behavior");
  assertEquals(surfaceMethodNoun("behavior"), "method");
});

/** The env-var warning the application layer produces. */
const ENV_VAR_WARNING = ValidationWarning.envVarUsage([]);

Deno.test("env-var warning: the model surface prints the model spelling", () => {
  assertEquals(
    messageFor(ENV_VAR_WARNING, "model"),
    "Data stored under this model will vary depending on these environment variables at runtime. Consider using separate models per environment, or vault.get() for sensitive values.",
  );
});

Deno.test("env-var warning: the behavior surface prints the behavior spelling", () => {
  assertEquals(
    messageFor(ENV_VAR_WARNING, "behavior"),
    "Data stored under this behavior will vary depending on these environment variables at runtime. Consider using separate behaviors per environment, or vault.get() for sensitive values.",
  );
});
