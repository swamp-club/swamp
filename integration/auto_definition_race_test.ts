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
import { z } from "zod";
import { resolveOrCreateDefinition } from "../src/libswamp/mod.ts";
import type { ModelDefinition } from "../src/domain/models/model.ts";
import type { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-race-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function createTestModelDef(): ModelDefinition {
  return {
    type: "test/race",
    version: "2026.01.01.1",
    globalArguments: undefined,
    methods: {
      run: {
        description: "Test method",
        arguments: z.object({}),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  } as unknown as ModelDefinition;
}

Deno.test("integration: concurrent auto-creation converges on a single definition", async () => {
  await withTempDir(async (tmpDir) => {
    const lockDir = join(tmpDir, "locks");
    const defsDir = join(tmpDir, "auto-definitions", "test", "race");
    await ensureDir(lockDir);
    await ensureDir(defsDir);

    const modelDef = createTestModelDef();
    const resolvedType = ModelType.create("test/race");
    const savedDefinitions: Definition[] = [];
    let lookupCount = 0;

    const deps = {
      lookupDefinition: () => {
        lookupCount++;
        // Simulate filesystem scan: return the first saved definition
        // (mimics what YamlDefinitionRepository.findByNameGlobal does)
        if (savedDefinitions.length > 0) {
          return Promise.resolve({
            definition: savedDefinitions[0],
            type: resolvedType,
          });
        }
        return Promise.resolve(null);
      },
      getModelDef: () => modelDef,
      saveDefinition: (_type: ModelType, def: Definition) => {
        savedDefinitions.push(def);
        return Promise.resolve();
      },
      getDefinitionPath: (_type: ModelType, id: string) =>
        join(defsDir, `${id}.yaml`),
    };

    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        resolveOrCreateDefinition(
          deps,
          "test/race",
          "racy",
          "run",
          {},
          resolvedType,
          modelDef,
          undefined,
          lockDir,
        )),
    );

    // All N calls succeed
    for (const result of results) {
      assertEquals(result.ok, true);
    }

    // Exactly one definition was created; the rest adopted it
    assertEquals(savedDefinitions.length, 1, "expected exactly one save");
    const createdCount = results.filter((r) => r.ok && r.created).length;
    assertEquals(createdCount, 1, "expected exactly one created=true");

    // All results reference the same definition ID
    const ids = new Set(
      results.filter((r) => r.ok).map((r) => r.ok ? r.definition.id : ""),
    );
    assertEquals(
      ids.size,
      1,
      "all results should share the same definition ID",
    );

    // The lookup was called more than N times (fast path + re-checks under lock)
    assertEquals(
      lookupCount > N,
      true,
      `expected more than ${N} lookups (got ${lookupCount})`,
    );
  });
});
