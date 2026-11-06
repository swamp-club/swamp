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

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { DefaultMethodExecutionService } from "../src/domain/models/method_execution_service.ts";
import { type DataHandle, modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { RepoMarkerRepository } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  modelMethodRun,
  type ModelMethodRunEvent,
} from "../src/libswamp/models/run.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createModelMethodRunDeps } from "../src/serve/deps.ts";

await initializeLogging({});

const ITEM_COUNT = 6;
const ITEM = { blob: "x".repeat(1000) };
const ITEM_BYTES = JSON.stringify(ITEM).length;
// room for two items and part of a third
const CAP_BYTES = ITEM_BYTES * 2 + Math.floor(ITEM_BYTES / 2);

Deno.test("resource attribute budget: a method run past the cap succeeds, keeps later handles light and marks their artifacts omitted", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-attr-budget-" });
  const type = ModelType.create(`test/attr-budget-${crypto.randomUUID()}`);
  const definition = Definition.create({
    name: "bulk",
    type: type.normalized,
  });
  const returned: DataHandle[] = [];
  modelRegistry.register({
    type,
    version: "2026.11.06.1",
    resources: {
      item: {
        description: "One written item",
        schema: z.object({ blob: z.string() }),
        lifetime: "infinite",
        garbageCollection: 20,
      },
    },
    methods: {
      write: {
        description: "Write many items",
        arguments: z.object({}),
        execute: async (_args, context) => {
          for (let i = 0; i < ITEM_COUNT; i++) {
            returned.push(
              await context.writeResource!("item", `item-${i}`, { ...ITEM }),
            );
          }
          return { dataHandles: returned };
        },
      },
    },
  });
  try {
    await Deno.mkdir(join(dir, "models"), { recursive: true });
    await new RepoMarkerRepository().write(RepoPath.create(dir), {
      swampVersion: "0.1.0",
      initializedAt: "2026-11-06T00:00:00.000Z",
      repoId: crypto.randomUUID(),
      tools: [],
    });
    const repo = createRepositoryContext({ repoDir: dir });
    try {
      await repo.definitionRepo.save(type, definition);
      const deps = await createModelMethodRunDeps(dir, repo);
      deps.resourceAttributeCapBytes = CAP_BYTES;
      deps.createExecutionService = () =>
        new DefaultMethodExecutionService(CAP_BYTES);

      const events = await collect<ModelMethodRunEvent>(
        modelMethodRun(createLibSwampContext(), deps, {
          modelIdOrName: "bulk",
          methodName: "write",
          inputs: {},
          lastEvaluated: false,
        }),
      );

      const last = events.at(-1);
      assert(last?.kind === "completed", JSON.stringify(last));
      assertEquals(last.run.status, "succeeded");
      const items = last.run.dataArtifacts.filter((a) =>
        a.name.startsWith("item-")
      );
      assertEquals(items.length, ITEM_COUNT);
      assertEquals(items.map((a) => a.attributesOmitted === true), [
        false,
        false,
        true,
        true,
        true,
        true,
      ]);
      assertEquals(items[0].attributes, ITEM);
      assertEquals(items[2].attributes, undefined);
      assertEquals(
        JSON.parse(JSON.stringify(last.run)).dataArtifacts.length,
        last.run.dataArtifacts.length,
      );

      assertEquals(returned.map((h) => h.attributes !== undefined), [
        true,
        true,
        false,
        false,
        false,
        false,
      ]);

      for (let i = 0; i < ITEM_COUNT; i++) {
        const bytes = await repo.unifiedDataRepo.getContent(
          type,
          definition.id,
          `item-${i}`,
        );
        assertExists(bytes, `item-${i}`);
        assertEquals(JSON.parse(new TextDecoder().decode(bytes)), ITEM);
      }

      const summaryBytes = await repo.unifiedDataRepo.getContent(
        type,
        definition.id,
        "report-swamp-method-summary-json",
      );
      assertExists(summaryBytes);
      const summary = JSON.parse(new TextDecoder().decode(summaryBytes));
      assertEquals(summary.status, "succeeded");
    } finally {
      repo.catalogStore.close();
    }
  } finally {
    modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else await Deno.remove(dir, { recursive: true });
  }
});
