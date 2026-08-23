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
import { DataRenameService } from "./data_rename_service.ts";
import type { UnifiedDataRepository } from "./repositories.ts";
import { Definition } from "../definitions/definition.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import { ModelType } from "../models/model_type.ts";

interface RenameCall {
  type: ModelType;
  modelId: string;
  oldName: string;
  newName: string;
}

function makeDataRepo(
  rename: (
    type: ModelType,
    modelId: string,
    oldName: string,
    newName: string,
  ) => Promise<{
    oldName: string;
    newName: string;
    copiedVersion: number;
    newVersion: number;
  }>,
): { repo: UnifiedDataRepository; calls: RenameCall[] } {
  const calls: RenameCall[] = [];
  const repo = {
    rename: (
      type: ModelType,
      modelId: string,
      oldName: string,
      newName: string,
    ) => {
      calls.push({ type, modelId, oldName, newName });
      return rename(type, modelId, oldName, newName);
    },
  } as unknown as UnifiedDataRepository;
  return { repo, calls };
}

function makeDefinitionRepo(
  byName: { definition: Definition; type: ModelType } | null,
): { repo: DefinitionRepository; lookups: string[] } {
  const lookups: string[] = [];
  const repo = {
    findById: () => Promise.resolve(null),
    findByNameGlobal: (name: string) => {
      lookups.push(name);
      return Promise.resolve(byName);
    },
  } as unknown as DefinitionRepository;
  return { repo, lookups };
}

function makeDefinition(name = "my-model"): Definition {
  return Definition.create({ type: "aws/s3-bucket", name });
}

Deno.test("rename: delegates to the data repository and maps the result", async () => {
  const definition = makeDefinition();
  const type = ModelType.create("AWS::S3::Bucket");
  const { repo: definitionRepo } = makeDefinitionRepo({ definition, type });
  const { repo: dataRepo, calls } = makeDataRepo(() =>
    Promise.resolve({
      oldName: "old-data",
      newName: "new-data",
      copiedVersion: 4,
      newVersion: 5,
    })
  );

  const service = new DataRenameService(dataRepo, definitionRepo);
  const result = await service.rename("my-model", "old-data", "new-data");

  // The repository receives the resolved model type and definition id.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].type.normalized, "aws/s3/bucket");
  assertEquals(calls[0].modelId, definition.id);
  assertEquals(calls[0].oldName, "old-data");
  assertEquals(calls[0].newName, "new-data");

  // The result combines repository output with model identity.
  assertEquals(result.oldName, "old-data");
  assertEquals(result.newName, "new-data");
  assertEquals(result.modelType, "aws/s3/bucket");
  assertEquals(result.modelId, definition.id);
  assertEquals(result.modelName, "my-model");
  assertEquals(result.copiedVersion, 4);
  assertEquals(result.newVersion, 5);
});

Deno.test("rename: accepts new names with dots and dashes", async () => {
  const definition = makeDefinition();
  const type = ModelType.create("aws/s3-bucket");
  const { repo: definitionRepo } = makeDefinitionRepo({ definition, type });
  const { repo: dataRepo, calls } = makeDataRepo((_t, _m, oldName, newName) =>
    Promise.resolve({ oldName, newName, copiedVersion: 1, newVersion: 1 })
  );

  const service = new DataRenameService(dataRepo, definitionRepo);
  const result = await service.rename("my-model", "old", "report-v1.2-final");

  assertEquals(calls.length, 1);
  assertEquals(result.newName, "report-v1.2-final");
});

Deno.test("rename: rejects invalid new names before touching the repositories", async () => {
  const invalidNames = ["", "a/b", "a\\b", "..", "up..dir", "nul\0l"];

  for (const newName of invalidNames) {
    const definition = makeDefinition();
    const type = ModelType.create("aws/s3-bucket");
    const { repo: definitionRepo, lookups } = makeDefinitionRepo({
      definition,
      type,
    });
    const { repo: dataRepo, calls } = makeDataRepo(() =>
      Promise.resolve({
        oldName: "old",
        newName,
        copiedVersion: 1,
        newVersion: 1,
      })
    );

    const service = new DataRenameService(dataRepo, definitionRepo);
    await assertRejects(
      () => service.rename("my-model", "old", newName),
      Error,
      `Invalid new name "${newName}"`,
    );

    // Validation fires before model resolution and repository rename,
    // so nothing is orphaned by a rejected name.
    assertEquals(lookups.length, 0);
    assertEquals(calls.length, 0);
  }
});

Deno.test("rename: throws when the model cannot be resolved", async () => {
  const { repo: definitionRepo } = makeDefinitionRepo(null);
  const { repo: dataRepo, calls } = makeDataRepo(() =>
    Promise.resolve({
      oldName: "old",
      newName: "new",
      copiedVersion: 1,
      newVersion: 1,
    })
  );

  const service = new DataRenameService(dataRepo, definitionRepo);
  await assertRejects(
    () => service.rename("no-such-model", "old", "new"),
    Error,
    "Model not found: no-such-model",
  );
  assertEquals(calls.length, 0);
});

Deno.test("rename: propagates data-not-found errors from the repository", async () => {
  const definition = makeDefinition();
  const type = ModelType.create("aws/s3-bucket");
  const { repo: definitionRepo } = makeDefinitionRepo({ definition, type });
  const { repo: dataRepo } = makeDataRepo(() =>
    Promise.reject(new Error("Data not found: old-data"))
  );

  const service = new DataRenameService(dataRepo, definitionRepo);
  await assertRejects(
    () => service.rename("my-model", "old-data", "new-data"),
    Error,
    "Data not found: old-data",
  );
});

Deno.test("rename: propagates name-collision errors from the repository", async () => {
  const definition = makeDefinition();
  const type = ModelType.create("aws/s3-bucket");
  const { repo: definitionRepo } = makeDefinitionRepo({ definition, type });
  const { repo: dataRepo } = makeDataRepo(() =>
    Promise.reject(new Error('Data "new-data" already exists'))
  );

  const service = new DataRenameService(dataRepo, definitionRepo);
  await assertRejects(
    () => service.rename("my-model", "old-data", "new-data"),
    Error,
    'Data "new-data" already exists',
  );
});
