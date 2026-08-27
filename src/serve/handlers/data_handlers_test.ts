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
import { resolveDataFields } from "./data_handlers.ts";
import type { DefinitionRepository } from "../../domain/definitions/repositories.ts";

function makeDefinitionRepo(
  definitions: Map<
    string,
    { name: string; tags?: Record<string, string>; type?: string }
  >,
): DefinitionRepository {
  return {
    findByNameGlobal: (name: string) => {
      const def = definitions.get(name);
      if (!def) return Promise.resolve(null);
      return Promise.resolve({
        type: { normalized: def.type ?? "test/type" },
        definition: { name: def.name, tags: def.tags, id: "test-id" },
      });
    },
    findById: () => Promise.resolve(null),
    listTypes: () => Promise.resolve([]),
    listByType: () => Promise.resolve([]),
  } as unknown as DefinitionRepository;
}

Deno.test("resolveDataFields: returns tags when model has them", async () => {
  const repo = makeDefinitionRepo(
    new Map([["tagged-model", {
      name: "tagged-model",
      tags: { env: "prod" },
    }]]),
  );

  const fields = await resolveDataFields(repo, "tagged-model");

  assertEquals(fields.name, "tagged-model");
  assertEquals(fields.tags, { env: "prod" });
});

Deno.test("resolveDataFields: omits tags when model has none", async () => {
  const repo = makeDefinitionRepo(
    new Map([["plain-model", { name: "plain-model" }]]),
  );

  const fields = await resolveDataFields(repo, "plain-model");

  assertEquals(fields.name, "plain-model");
  assertEquals(fields.tags, undefined);
});

Deno.test("resolveDataFields: falls back to name-only when model not found", async () => {
  const repo = makeDefinitionRepo(new Map());

  const fields = await resolveDataFields(repo, "missing-model");

  assertEquals(fields.name, "missing-model");
  assertEquals(fields.tags, undefined);
});

Deno.test("resolveDataFields: returns ns from user namespace type", async () => {
  const repo = makeDefinitionRepo(
    new Map([["ns-model", {
      name: "ns-model",
      tags: { env: "prod" },
      type: "@myns/model-type",
    }]]),
  );

  const fields = await resolveDataFields(repo, "ns-model");

  assertEquals(fields.name, "ns-model");
  assertEquals(fields.ns, "myns");
  assertEquals(fields.tags, { env: "prod" });
});

Deno.test("resolveDataFields: omits ns for non-namespaced type", async () => {
  const repo = makeDefinitionRepo(
    new Map([["plain-type-model", {
      name: "plain-type-model",
      type: "command/shell",
    }]]),
  );

  const fields = await resolveDataFields(repo, "plain-type-model");

  assertEquals(fields.name, "plain-type-model");
  assertEquals(fields.ns, undefined);
});

Deno.test("resolveDataFields: falls back to name-only when repo throws", async () => {
  const repo = {
    findByNameGlobal: () => Promise.reject(new Error("PermissionDenied")),
    findById: () => Promise.reject(new Error("PermissionDenied")),
    listTypes: () => Promise.resolve([]),
    listByType: () => Promise.resolve([]),
  } as unknown as DefinitionRepository;

  const fields = await resolveDataFields(repo, "erroring-model");

  assertEquals(fields.name, "erroring-model");
  assertEquals(fields.tags, undefined);
});
