// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  dataVersions,
  type DataVersionsDeps,
  type DataVersionsEvent,
} from "./versions.ts";

function makeDeps(overrides?: Partial<DataVersionsDeps>): DataVersionsDeps {
  const definition = Definition.create({
    id: "00000000-0000-4000-8000-000000000001",
    name: "my-model",
    version: 1,
  });
  const modelType = ModelType.create("aws/ec2");
  return {
    lookupDefinition: () => Promise.resolve({ definition, type: modelType }),
    listVersions: () => Promise.resolve([1, 2, 3]),
    findByName: (_type, _defId, _name, version) =>
      Promise.resolve({
        version,
        createdAt: new Date("2026-01-01"),
        size: 100,
        checksum: "abc123",
      }),
    ...overrides,
  };
}

Deno.test("dataVersions yields resolving then completed", async () => {
  const deps = makeDeps();
  const events = await collect<DataVersionsEvent>(
    dataVersions(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      dataName: "output",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    DataVersionsEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.total, 3);
  assertEquals(completed.data.versions[0].version, 3); // sorted desc
  assertEquals(completed.data.versions[0].isLatest, true);
});

Deno.test("dataVersions yields error when model not found", async () => {
  const deps = makeDeps({
    lookupDefinition: () => Promise.resolve(null),
  });
  const events = await collect<DataVersionsEvent>(
    dataVersions(createLibSwampContext(), deps, {
      modelIdOrName: "missing",
      dataName: "output",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[1].kind, "error");
  const error = events[1] as Extract<DataVersionsEvent, { kind: "error" }>;
  assertEquals(error.error.code, "not_found");
});

Deno.test("dataVersions yields error when no versions exist", async () => {
  const deps = makeDeps({
    listVersions: () => Promise.resolve([]),
  });
  const events = await collect<DataVersionsEvent>(
    dataVersions(createLibSwampContext(), deps, {
      modelIdOrName: "my-model",
      dataName: "missing-data",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[1].kind, "error");
});
