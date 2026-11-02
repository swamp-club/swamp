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
import fc from "fast-check";
import { Data, RECORD_KIND_TAG } from "./data.ts";
import { assertKindContinues, dataKindOf } from "./data_kind.ts";

const owner = { ownerType: "model-method" as const, ownerRef: "t:m" };

const arbVersion = fc.record({
  kind: fc.option(fc.constantFrom("file" as const, "resource" as const), {
    nil: undefined,
  }),
  type: fc.constantFrom("file", "resource", "agent-session", "report"),
  marker: fc.constantFrom("none", "deleted", "renamed"),
}).map(({ kind, type, marker }) => {
  const data = Data.create({
    name: "x",
    contentType: "application/json",
    lifetime: "infinite",
    garbageCollection: 10,
    tags: kind === undefined ? { type } : { type, [RECORD_KIND_TAG]: kind },
    ownerDefinition: owner,
  });
  if (marker === "deleted") return data.withDeletionMarker({ version: 2 });
  if (marker === "renamed") {
    return data.withRenameMarker({ version: 2, renamedTo: "y" });
  }
  return data;
});

Deno.test("property: assertKindContinues refuses exactly when two live versions have known, different kinds", () => {
  fc.assert(
    fc.property(arbVersion, arbVersion, (prior, next) => {
      const priorKind = dataKindOf(prior);
      const nextKind = dataKindOf(next);
      const expectRefusal = !prior.isDeleted && !next.isDeleted &&
        priorKind !== undefined && nextKind !== undefined &&
        priorKind !== nextKind;
      let refused = false;
      try {
        assertKindContinues(prior, next, "id");
      } catch {
        refused = true;
      }
      assertEquals(refused, expectRefusal);
    }),
  );
});
