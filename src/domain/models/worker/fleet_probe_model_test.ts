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
  FLEET_PROBE_MODEL_TYPE,
  fleetProbeModel,
} from "./fleet_probe_model.ts";

Deno.test("fleetProbeModel: registers with correct type", () => {
  assertEquals(
    fleetProbeModel.type.normalized,
    FLEET_PROBE_MODEL_TYPE.normalized,
  );
});

Deno.test("fleetProbeModel: has verify method", () => {
  assertEquals("verify" in fleetProbeModel.methods, true);
  assertEquals(fleetProbeModel.methods.verify.kind, "action");
});

Deno.test("fleetProbeModel: result resource is ephemeral with gc 1", () => {
  const resource = fleetProbeModel.resources!["result"];
  assertEquals(resource.lifetime, "ephemeral");
  assertEquals(resource.garbageCollection, 1);
});
