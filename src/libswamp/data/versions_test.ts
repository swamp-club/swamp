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

import { assertEquals, assertRejects } from "@std/assert";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createDataVersionsDeps,
  dataVersions,
  type DataVersionsDeps,
  type DataVersionsEvent,
} from "./versions.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";

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

Deno.test(
  "dataVersions marks the highest version latest past the spread-argument ceiling",
  async () => {
    // Math.max(...versions) threw RangeError above ~125k versions
    // (swamp-club#2565).
    const count = 150_000;
    const deps = makeDeps({
      listVersions: () =>
        Promise.resolve(Array.from({ length: count }, (_, i) => i + 1)),
    });
    const events = await collect<DataVersionsEvent>(
      dataVersions(createLibSwampContext(), deps, {
        modelIdOrName: "my-model",
        dataName: "output",
      }),
    );

    assertEquals(events[1].kind, "completed");
    const completed = events[1] as Extract<
      DataVersionsEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.data.total, count);
    assertEquals(completed.data.versions[0].version, count);
    assertEquals(completed.data.versions[0].isLatest, true);
    assertEquals(
      completed.data.versions.filter((v) => v.isLatest).length,
      1,
    );
  },
);

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

Deno.test(
  "createDataVersionsDeps: uses injectedDefinitionRepo for lookups",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
    try {
      const injected = new YamlDefinitionRepository(dir);
      const deps = createDataVersionsDeps(dir, undefined, undefined, injected);
      const result = await deps.lookupDefinition("nonexistent");
      assertEquals(result, null);
    } finally {
      if (Deno.build.os === "windows") {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(dir, { recursive: true });
      }
    }
  },
);

function otherDefinitionResult() {
  return {
    definition: Definition.create({
      id: "00000000-0000-4000-8000-000000000002",
      name: "00000000-0000-4000-8000-000000000001",
      version: 1,
    }),
    type: ModelType.create("aws/ec2"),
  };
}

Deno.test("dataVersions: byId resolves the model by id only, never by name", async () => {
  const byIdLookups: string[] = [];
  const listedFor: string[] = [];
  const definition = Definition.create({
    id: "00000000-0000-4000-8000-000000000001",
    name: "my-model",
    version: 1,
  });
  const deps = makeDeps({
    lookupDefinition: () => {
      throw new Error("name-first lookup must not be used with byId");
    },
    lookupDefinitionById: (id) => {
      byIdLookups.push(id);
      return Promise.resolve({
        definition,
        type: ModelType.create("aws/ec2"),
      });
    },
    listVersions: (_type, definitionId) => {
      listedFor.push(definitionId);
      return Promise.resolve([1]);
    },
  });
  const events = await collect<DataVersionsEvent>(
    dataVersions(createLibSwampContext(), deps, {
      modelIdOrName: definition.id,
      byId: true,
      dataName: "output",
    }),
  );

  assertEquals(events[1].kind, "completed");
  assertEquals(byIdLookups, [definition.id]);
  assertEquals(listedFor, [definition.id]);
});

Deno.test("dataVersions: byId without a by-id lookup fails instead of looking up by name", async () => {
  let nameLookups = 0;
  const deps = makeDeps({
    lookupDefinition: () => {
      nameLookups++;
      return Promise.resolve(otherDefinitionResult());
    },
  });
  await assertRejects(
    () =>
      collect<DataVersionsEvent>(
        dataVersions(createLibSwampContext(), deps, {
          modelIdOrName: "00000000-0000-4000-8000-000000000001",
          byId: true,
          dataName: "output",
        }),
      ),
    Error,
    "by-id lookup was requested but none is wired",
  );
  assertEquals(nameLookups, 0);
});
