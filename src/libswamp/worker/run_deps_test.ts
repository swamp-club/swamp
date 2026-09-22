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

import { assert } from "@std/assert";
import { createWorkerModelRunDeps } from "./run_deps.ts";
import { createRepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import "../../domain/models/models.ts";

Deno.test("createWorkerModelRunDeps: createAndSaveDefinition calls markDirty hook", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-run-deps-test-" });
  try {
    const dirtyPaths: string[] = [];
    const ctx = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
      markDirty: (relPath?: string) => {
        if (relPath) dirtyPaths.push(relPath);
        return Promise.resolve();
      },
    });

    const deps = await createWorkerModelRunDeps(dir, ctx);
    const definition = Definition.create({
      name: "test-token",
      type: "swamp/enrollment-token",
      typeVersion: "2026.07.04.1",
    });
    await deps.createAndSaveDefinition!(
      ModelType.create("swamp/enrollment-token"),
      definition,
    );

    assert(
      dirtyPaths.length > 0,
      "markDirty must be called when saving an auto-definition",
    );
    ctx.catalogStore.close();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
