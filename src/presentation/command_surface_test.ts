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
import {
  DEFAULT_COMMAND_SURFACE,
  envVarWarningMessage,
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

/** The env-var warning text the application layer produces today. */
const ENV_VAR_WARNING = ValidationWarning.envVarUsage([]).message;

Deno.test("envVarWarningMessage: the model surface keeps the message verbatim", () => {
  assertEquals(envVarWarningMessage("model", ENV_VAR_WARNING), ENV_VAR_WARNING);
});

Deno.test("envVarWarningMessage: the behavior surface swaps the noun in the real warning text", () => {
  assertEquals(
    envVarWarningMessage("behavior", ENV_VAR_WARNING),
    "Data stored under this behavior will vary depending on these environment variables at runtime. Consider using separate behaviors per environment, or vault.get() for sensitive values.",
  );
});

Deno.test("envVarWarningMessage: a message without the model phrases is unchanged", () => {
  const other = "Something else entirely about vault.get().";
  assertEquals(envVarWarningMessage("behavior", other), other);
});
