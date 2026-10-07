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
  CONTROL_PLANE_MODEL_TYPES,
  CONTROL_PLANE_STORED_TYPES,
  isControlPlaneModelType,
  normalizeModelTypeName,
} from "./control_plane_types.ts";
import { modelRegistry } from "./models.ts";

Deno.test("CONTROL_PLANE_MODEL_TYPES: pins the eight control-plane types", () => {
  assertEquals([...CONTROL_PLANE_MODEL_TYPES].sort(), [
    "swamp/enrollment-token",
    "swamp/fleet-probe",
    "swamp/grant",
    "swamp/group",
    "swamp/pending-dispatch",
    "swamp/server-token",
    "swamp/step-lease",
    "swamp/worker",
  ]);
});

Deno.test("isControlPlaneModelType: matches every normalized form of a control-plane type", () => {
  for (
    const type of [
      "swamp/grant",
      "SWAMP/Grant",
      "@swamp/grant",
      "swamp::server-token",
      "swamp.worker",
      " swamp/group ",
      " @swamp/grant",
      "@@swamp/grant",
      "@/@swamp/group",
    ]
  ) {
    assertEquals(isControlPlaneModelType(type), true, type);
  }
});

Deno.test("isControlPlaneModelType: rejects user and other built-in types", () => {
  for (
    const type of [
      "command/shell",
      "@acme/grant",
      "swamp/grants",
      "grant",
      "",
      "   ",
      "///",
      "::",
      "@",
      "workflow",
    ]
  ) {
    assertEquals(isControlPlaneModelType(type), false, JSON.stringify(type));
  }
});

Deno.test("isControlPlaneModelType: every control-plane type is marked internal in the registry", () => {
  for (const type of CONTROL_PLANE_MODEL_TYPES) {
    assertEquals(modelRegistry.isInternal(type), true, type);
  }
});

Deno.test("CONTROL_PLANE_STORED_TYPES: names each type bare and @-prefixed", () => {
  assertEquals(
    CONTROL_PLANE_STORED_TYPES.length,
    CONTROL_PLANE_MODEL_TYPES.length * 2,
  );
  for (const type of CONTROL_PLANE_MODEL_TYPES) {
    assertEquals(CONTROL_PLANE_STORED_TYPES.includes(type), true, type);
    assertEquals(CONTROL_PLANE_STORED_TYPES.includes(`@${type}`), true, type);
  }
});

Deno.test("normalizeModelTypeName: gives one key for every spelling of a type", () => {
  for (
    const type of [
      "exp/probe",
      "@exp/probe",
      "@Exp::Probe",
      "EXP.PROBE",
      " @exp/probe",
      "@exp/probe ",
      "@@exp/probe",
      "@ exp/probe",
      "@/exp/probe",
      "@/@exp/probe",
      "/@exp/probe",
      "@ @exp/probe",
    ]
  ) {
    assertEquals(normalizeModelTypeName(type), "exp/probe", type);
  }
});

Deno.test("normalizeModelTypeName: returns null for a string that names no type", () => {
  for (const type of ["", "   ", "@", "@@", "::", "/", "@/", "@ /@"]) {
    assertEquals(normalizeModelTypeName(type), null, JSON.stringify(type));
  }
});
