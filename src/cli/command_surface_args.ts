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

import type { CommandSurface } from "../presentation/command_surface.ts";
import { MODEL_GROUP_WORD } from "./behavior_twin.ts";
import { extractCommandInfo } from "./telemetry_integration.ts";

/**
 * The spelling a command's messages use, from the raw CLI arguments
 * (swamp-club#3437): `model` when the command word is `model`, and
 * `behavior` for `swamp behavior …`, its `behaviour` alias and every other
 * command. Read from the arguments rather than from the matched command so
 * errors raised before a command's action runs (repo checks, the auth gate)
 * get it too.
 */
export function commandSurfaceFromArgs(
  args: readonly string[],
): CommandSurface {
  const { command } = extractCommandInfo([...args]);
  return command === MODEL_GROUP_WORD ? "model" : "behavior";
}
