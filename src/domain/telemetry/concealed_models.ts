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

import { normalizeModelTypeName } from "../models/control_plane_types.ts";
import { integrationDefinitionName } from "../models/access/integration_model.ts";

export const CONCEALED_MODEL_NAME = "<REDACTED>";

// an integration's name embeds its id and a group's name is operator-chosen
const CONCEALED_TYPES: ReadonlyMap<string, string> = new Map([
  ["swamp/integration", "@swamp/integration"],
  ["swamp/group", "@swamp/group"],
]);

const INTEGRATION_NAME_PREFIX = integrationDefinitionName("");

/**
 * the label telemetry sends in place of a behavior's name, or undefined to send
 * the name; before the type is known an integration-shaped name is concealed
 */
export function concealedModelLabel(
  modelType: string | undefined,
  modelName: string,
): string | undefined {
  if (modelType !== undefined) {
    const normalized = normalizeModelTypeName(modelType);
    return normalized === null ? undefined : CONCEALED_TYPES.get(normalized);
  }
  return modelName.startsWith(INTEGRATION_NAME_PREFIX)
    ? CONCEALED_MODEL_NAME
    : undefined;
}
