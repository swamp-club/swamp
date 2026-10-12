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

import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import {
  DefinitionFactory,
  ModelOutputFactory,
  WorkflowRunFactory,
} from "./identity_factories.ts";
import { partitionOf } from "./partition_key.ts";

const uuid = z.string().uuid();

Deno.test("WorkflowRunFactory.newRunId: gives a fresh UUID each time", () => {
  const ids = new Set(
    Array.from({ length: 1000 }, () => WorkflowRunFactory.newRunId()),
  );
  assertEquals(ids.size, 1000);
  for (const id of ids) assert(uuid.safeParse(id).success);
});

Deno.test("DefinitionFactory.newAutoDefinitionId: each id is its own partition", () => {
  const a = DefinitionFactory.newAutoDefinitionId();
  const b = DefinitionFactory.newAutoDefinitionId();
  assert(uuid.safeParse(a).success);
  assert(
    !partitionOf({ kind: "definition", id: a }).equals(
      partitionOf({ kind: "definition", id: b }),
    ),
  );
});

Deno.test("ModelOutputFactory.newOutputId: gives a fresh UUID each time", () => {
  const a = ModelOutputFactory.newOutputId();
  assert(uuid.safeParse(a).success);
  assert(a !== ModelOutputFactory.newOutputId());
});
