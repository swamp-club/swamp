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
  controlPlaneRecordResource,
  isControlPlaneRecordResource,
} from "./control_plane_records.ts";

Deno.test("controlPlaneRecordResource: names the access resource by the normalized type", () => {
  assertEquals(controlPlaneRecordResource("swamp/grant"), {
    kind: "access",
    name: "swamp/grant",
    fields: { name: "swamp/grant" },
  });
  assertEquals(
    controlPlaneRecordResource("@SWAMP::Server-Token").name,
    "swamp/server-token",
  );
});

Deno.test("isControlPlaneRecordResource: only access resources named by a control-plane type", () => {
  assertEquals(
    isControlPlaneRecordResource(controlPlaneRecordResource("swamp/worker")),
    true,
  );
  // The names access requests use are not control-plane records.
  for (const name of ["grant", "group", "*", "swamp/*", "audit"]) {
    assertEquals(
      isControlPlaneRecordResource({ kind: "access", name, fields: { name } }),
      false,
      name,
    );
  }
  // Another kind named like a control-plane type is not one either.
  assertEquals(
    isControlPlaneRecordResource({
      kind: "data",
      name: "swamp/grant",
      fields: { name: "swamp/grant", ns: "", tags: {} },
    }),
    false,
  );
});
