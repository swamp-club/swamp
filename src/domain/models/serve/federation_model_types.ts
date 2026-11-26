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

import { modelRegistry } from "../model.ts";
import { isServeFederationEnabled } from "../../serve/federation_gate.ts";

export const FEDERATION_MODEL_TYPES: readonly string[] = ["swamp/serve-member"];

/** gated, idempotent; a literal specifier keeps the module in a compiled binary */
export async function registerFederationModelTypes(
  env: (name: string) => string | undefined,
): Promise<boolean> {
  if (!isServeFederationEnabled(env)) return false;
  const { serveMemberModel } = await import(
    "./serve_member_model.ts"
  );
  // a cached import does not re-run defineModel after invalidateType
  if (!modelRegistry.has(serveMemberModel.type)) {
    modelRegistry.register(serveMemberModel);
    modelRegistry.markBuiltIn(serveMemberModel.type);
  }
  return true;
}
