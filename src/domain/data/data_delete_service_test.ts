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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { DataDeleteService } from "./data_delete_service.ts";
import { ModelType } from "../models/model_type.ts";

const MODEL_TYPE = ModelType.create("test/example");

class FakeDataRepository {
  versionsByName: Map<string, number[]> = new Map();
  deleteCalls: Array<{
    type: ModelType;
    modelId: string;
    dataName: string;
    version?: number;
  }> = [];

  listVersions = (
    _type: ModelType,
    _modelId: string,
    dataName: string,
  ): Promise<number[]> => {
    return Promise.resolve(this.versionsByName.get(dataName) ?? []);
  };

  delete = (
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<void> => {
    this.deleteCalls.push({ type, modelId, dataName, version });
    return Promise.resolve();
  };
}

class FakeDefinitionRepository {
  findByNameGlobal = (name: string) => {
    if (name === "missing-model") return Promise.resolve(null);
    return Promise.resolve({
      definition: { id: "def-1", name },
      type: MODEL_TYPE,
    });
  };
  findById = () => Promise.resolve(null);
}

function makeService(): {
  service: DataDeleteService;
  dataRepo: FakeDataRepository;
  definitionRepo: FakeDefinitionRepository;
} {
  const dataRepo = new FakeDataRepository();
  const definitionRepo = new FakeDefinitionRepository();
  const service = new DataDeleteService(
    dataRepo as never,
    definitionRepo as never,
  );
  return { service, dataRepo, definitionRepo };
}

Deno.test("DataDeleteService.delete: deletes all versions when version is undefined", async () => {
  const { service, dataRepo } = makeService();
  dataRepo.versionsByName.set("my-data", [1, 2, 3]);

  const result = await service.delete("my-model", "my-data");

  assertEquals(result.modelId, "def-1");
  assertEquals(result.modelName, "my-model");
  assertEquals(result.modelType, "test/example");
  assertEquals(result.dataName, "my-data");
  assertEquals(result.version, undefined);
  assertEquals(result.versionsDeleted, 3);
  assertEquals(dataRepo.deleteCalls.length, 1);
  assertEquals(dataRepo.deleteCalls[0].dataName, "my-data");
  assertEquals(dataRepo.deleteCalls[0].version, undefined);
});

Deno.test("DataDeleteService.delete: deletes specific version when provided", async () => {
  const { service, dataRepo } = makeService();
  dataRepo.versionsByName.set("my-data", [1, 2, 3]);

  const result = await service.delete("my-model", "my-data", 2);

  assertEquals(result.version, 2);
  assertEquals(result.versionsDeleted, 1);
  assertEquals(dataRepo.deleteCalls[0].version, 2);
});

Deno.test("DataDeleteService.delete: throws when model not found", async () => {
  const { service } = makeService();

  await assertRejects(
    () => service.delete("missing-model", "my-data"),
    Error,
    "Model not found: missing-model",
  );
});

Deno.test("DataDeleteService.delete: throws when artifact has no versions", async () => {
  const { service, dataRepo } = makeService();
  dataRepo.versionsByName.set("other-data", [1]);

  await assertRejects(
    () => service.delete("my-model", "my-data"),
    Error,
    'No data named "my-data" exists for model my-model',
  );
});

Deno.test("DataDeleteService.delete: throws when version does not exist, listing available versions", async () => {
  const { service, dataRepo } = makeService();
  dataRepo.versionsByName.set("my-data", [3, 1, 2]);

  const error = await assertRejects(
    () => service.delete("my-model", "my-data", 99),
    Error,
  );
  assertStringIncludes(
    error.message,
    'Version 99 does not exist for "my-data"',
  );
  assertStringIncludes(error.message, "available versions: 1, 2, 3");
});

Deno.test("DataDeleteService.delete: does not call repository.delete when pre-check fails", async () => {
  const { service, dataRepo } = makeService();
  dataRepo.versionsByName.set("my-data", [1, 2]);

  await assertRejects(
    () => service.delete("my-model", "my-data", 99),
    Error,
  );

  assertEquals(dataRepo.deleteCalls.length, 0);
});

Deno.test("DataDeleteService.previewDelete: returns versions count without deleting", async () => {
  const { service, dataRepo } = makeService();
  dataRepo.versionsByName.set("my-data", [1, 2, 3]);

  const preview = await service.previewDelete("my-model", "my-data");

  assertEquals(preview.versionsCount, 3);
  assertEquals(preview.modelId, "def-1");
  assertEquals(preview.modelName, "my-model");
  assertEquals(preview.modelType, "test/example");
  assertEquals(preview.dataName, "my-data");
  assertEquals(dataRepo.deleteCalls.length, 0);
});

Deno.test("DataDeleteService.previewDelete: throws when model not found", async () => {
  const { service } = makeService();

  await assertRejects(
    () => service.previewDelete("missing-model", "my-data"),
    Error,
    "Model not found: missing-model",
  );
});

Deno.test("DataDeleteService.previewDelete: throws when artifact has no versions", async () => {
  const { service } = makeService();

  await assertRejects(
    () => service.previewDelete("my-model", "my-data"),
    Error,
    'No data named "my-data" exists for model my-model',
  );
});
