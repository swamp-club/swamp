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
import { modelRegistry } from "../models.ts";
import { withMockedEnv } from "../../../infrastructure/persistence/path_test_helpers.ts";
import { FEDERATION_GATE_VARIABLE } from "../../serve/federation_gate.ts";
import {
  FEDERATION_MODEL_TYPES,
  registerFederationModelTypes,
} from "./federation_model_types.ts";

const MEMBER_TYPE = "swamp/serve-member";

function env(gate: string | undefined) {
  return (name: string) => name === FEDERATION_GATE_VARIABLE ? gate : undefined;
}

Deno.test("registerFederationModelTypes: with the gate off registers nothing", async () => {
  await withMockedEnv({ [FEDERATION_GATE_VARIABLE]: undefined }, async () => {
    assertEquals(modelRegistry.has(MEMBER_TYPE), false);
    assertEquals(await registerFederationModelTypes(env(undefined)), false);
    assertEquals(await registerFederationModelTypes(env("0")), false);
    assertEquals(modelRegistry.has(MEMBER_TYPE), false);
  });
});

Deno.test("registerFederationModelTypes: with the gate on registers swamp/serve-member as built in, idempotently", async () => {
  try {
    assertEquals(await registerFederationModelTypes(env("1")), true);
    assertEquals(await registerFederationModelTypes(env("1")), true);
    await Promise.all([
      registerFederationModelTypes(env("1")),
      registerFederationModelTypes(env("1")),
    ]);
    for (const type of FEDERATION_MODEL_TYPES) {
      assertEquals(modelRegistry.has(type), true);
      assertEquals(modelRegistry.isBuiltIn(type), true);
      assertEquals(modelRegistry.isInternal(type), false);
    }
  } finally {
    modelRegistry.invalidateType(MEMBER_TYPE);
  }
});

Deno.test("registerFederationModelTypes: registers again after the type was invalidated", async () => {
  try {
    await registerFederationModelTypes(env("1"));
    modelRegistry.invalidateType(MEMBER_TYPE);
    await registerFederationModelTypes(env("1"));
    assertEquals(modelRegistry.has(MEMBER_TYPE), true);
  } finally {
    modelRegistry.invalidateType(MEMBER_TYPE);
  }
});
