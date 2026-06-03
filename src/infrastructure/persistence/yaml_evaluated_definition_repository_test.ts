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
import { YamlEvaluatedDefinitionRepository } from "./yaml_evaluated_definition_repository.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";

const testType = ModelType.create("test/model");

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    prefix: "swamp-yaml-evaluated-definition-",
  });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test(
  "YamlEvaluatedDefinitionRepository invokes markDirty with relPath on mutations",
  async () => {
    await withTempDir(async (dir) => {
      const calls: Array<string | undefined> = [];
      const markDirty = (relPath?: string) => {
        calls.push(relPath);
        return Promise.resolve();
      };
      const repo = new YamlEvaluatedDefinitionRepository(
        dir,
        undefined,
        markDirty,
      );

      const definition = Definition.create({
        type: testType.normalized,
        typeVersion: "1",
        name: "test-def",
      });

      const expectedPath = repo.getPath(testType, definition.id);

      // save → per-definition yaml path
      await repo.save(testType, definition);
      assertEquals(calls.length, 1);
      assertEquals(calls[0], expectedPath);

      // delete → same per-definition yaml path
      await repo.delete(testType, definition.id);
      assertEquals(calls.length, 2);
      assertEquals(calls[1], expectedPath);

      // Reads do not notify.
      await repo.findAll(testType);
      await repo.findById(testType, definition.id);
      assertEquals(calls.length, 2);

      // clearAll → bulk (whole evaluated-definitions tree removed)
      await repo.save(testType, definition);
      assertEquals(calls.length, 3);
      await repo.clearAll();
      assertEquals(calls.length, 4);
      assertEquals(calls[3], undefined);
    });
  },
);
