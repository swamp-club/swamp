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
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import { ModelOutput } from "../../domain/models/model_output.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createModelOutputDataDeps,
  modelOutputData,
  type ModelOutputDataDeps,
  type ModelOutputDataEvent,
} from "./output_data.ts";
import { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { catalogDbPath } from "../../infrastructure/persistence/repository_factory.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native sqlite handles
      // yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function catalogDbExists(repoDir: string): Promise<boolean> {
  try {
    await Deno.lstat(catalogDbPath(repoDir));
    return true;
  } catch {
    return false;
  }
}

Deno.test(
  "createModelOutputDataDeps: reuses an injected data repo and opens no new catalog db",
  async () => {
    await withTempDir(async (dir) => {
      const injected = new FileSystemUnifiedDataRepository(
        dir,
        undefined,
        new CatalogStore(":memory:"),
      );
      createModelOutputDataDeps(dir, undefined, injected);
      assertEquals(await catalogDbExists(dir), false);
    });
  },
);

Deno.test(
  "createModelOutputDataDeps: opens a file-based catalog db when no repo is injected",
  async () => {
    await withTempDir(async (dir) => {
      createModelOutputDataDeps(dir);
      assertEquals(await catalogDbExists(dir), true);
    });
  },
);

function makeOutput(
  opts?: { withDataArtifact?: boolean },
): ModelOutput {
  const output = ModelOutput.create({
    definitionId: "00000000-0000-4000-8000-000000000001" as DefinitionId,
    methodName: "start",
    provenance: {
      definitionHash: "abc",
      modelVersion: "1",
      triggeredBy: "manual",
    },
  });
  output.markRunning();
  output.markSucceeded();
  if (opts?.withDataArtifact !== false) {
    output.addDataArtifact({
      dataId: crypto.randomUUID(),
      name: "output",
      version: 1,
      tags: { type: "data" },
    });
  }
  return output;
}

function makeDeps(
  overrides?: Partial<ModelOutputDataDeps>,
): ModelOutputDataDeps {
  const output = makeOutput();
  const modelType = ModelType.create("aws/ec2");
  return {
    isPartialId: () => true,
    matchOutputByPartialId: () =>
      Promise.resolve({
        status: "found" as const,
        match: { output, type: modelType },
      }),
    findDefinition: () =>
      Promise.resolve({
        id: "00000000-0000-4000-8000-000000000001",
        name: "my-model",
      }),
    findDataByName: () =>
      Promise.resolve({
        id: "data-1",
        name: "output",
        version: 1,
        contentType: "application/json",
      }),
    getContent: () =>
      Promise.resolve(
        new TextEncoder().encode(JSON.stringify({ key: "value" })),
      ),
    ...overrides,
  };
}

Deno.test("modelOutputData yields completed with data", async () => {
  const deps = makeDeps();
  const events = await collect<ModelOutputDataEvent>(
    modelOutputData(createLibSwampContext(), deps, {
      outputIdArg: "out-123",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    ModelOutputDataEvent,
    { kind: "completed" }
  >;
  assertEquals(typeof completed.data.outputId, "string");
  assertEquals(completed.data.data, { key: "value" });
  assertEquals(completed.data.field, null);
});

Deno.test("modelOutputData extracts field from JSON", async () => {
  const deps = makeDeps();
  const events = await collect<ModelOutputDataEvent>(
    modelOutputData(createLibSwampContext(), deps, {
      outputIdArg: "out-123",
      field: "key",
    }),
  );

  const completed = events[1] as Extract<
    ModelOutputDataEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.data, "value");
  assertEquals(completed.data.field, "key");
});

Deno.test("modelOutputData yields error for missing field", async () => {
  const deps = makeDeps();
  const events = await collect<ModelOutputDataEvent>(
    modelOutputData(createLibSwampContext(), deps, {
      outputIdArg: "out-123",
      field: "nonexistent",
    }),
  );

  assertEquals(events[1].kind, "error");
});

Deno.test("modelOutputData yields error when no data artifacts", async () => {
  const outputNoData = makeOutput({ withDataArtifact: false });
  const modelType = ModelType.create("aws/ec2");
  const deps = makeDeps({
    matchOutputByPartialId: () =>
      Promise.resolve({
        status: "found" as const,
        match: { output: outputNoData, type: modelType },
      }),
  });
  const events = await collect<ModelOutputDataEvent>(
    modelOutputData(createLibSwampContext(), deps, {
      outputIdArg: "out-123",
    }),
  );

  assertEquals(events[1].kind, "error");
});
